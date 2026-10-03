/**
 * Promotion attacks (spec 3 §6 attacks #7/#10; spec 1 §10–§11).
 *
 * 1. COMMIT-SWAP (attack #7): the candidate is reviewed at SHA X but the
 *    attacker pushes SHA Y before promotion. Presenting X's permit with
 *    Y's tree → TREE_MISMATCH, permit NOT consumed, NO effects. Retrying
 *    with X's actual tree → PROMOTED with exactly one canonical_write.
 *
 * 2. PERMIT DOUBLE-ISSUE (single-use regression): permit_id is
 *    deterministic over the bound fields, so re-issuing the same permit
 *    must converge to the SAME record — never overwrite (an overwrite
 *    would reset consumed=false and resurrect a consumed permit).
 *      (a) re-issue BEFORE consumption → same permit_id; present once →
 *          PROMOTED; present again → ALREADY_CONSUMED.
 *      (b) re-issue AFTER consumption → returns the consumed record;
 *          presentation → ALREADY_CONSUMED (no second promotion).
 *
 * node --test test/promotion-attacks.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, sha256Hex } from "../src/lib/canonical.ts";
import {
	attemptPromotion,
	createAuthority,
	issuePermit,
	registerClaim,
	runVerdictSeam,
	submitEvaluation,
	type Ctx,
} from "../src/lib/task-state.ts";
import {
	SELECTOR_POLICY_VERSION,
	type AuthorityState,
	type EvaluationBundle,
} from "../src/lib/types.ts";

function makeCtx(): Ctx {
	return {
		now: () => "2026-10-01T21:00:00.000Z",
		randomHex: (n: number) => "b".repeat(n * 2),
		sha256Hex,
		selectorPolicyHash: "policyhash",
		policyVersion: SELECTOR_POLICY_VERSION,
	};
}

async function makeBundle(input: {
	candidate_sha: string;
	tree_sha256: string;
	contender_id: string;
	task_hash: string;
}): Promise<EvaluationBundle> {
	const rest = {
		candidate_sha: input.candidate_sha,
		tree_sha256: input.tree_sha256,
		contender_id: input.contender_id,
		task_hash: input.task_hash,
		admission: {
			exact_baseline: true,
			scope_compliance: true,
			valid_tool_states: true,
			no_eval_tampering: true,
			provenance_complete: true,
		},
		hidden_oracle: { passed: true, total: 2, failed: [] as string[] },
		regressions: { passed: true, total: 5, failed: [] as string[] },
		static_analysis: { passed: true, findings: [] as string[] },
		semantic_checks: { passed: true, total: 1, failed: [] as string[] },
		security_policy: { passed: true, findings: [] as string[] },
		evaluated_at: "2026-10-01T18:00:00Z",
		tainted: false,
	};
	return { ...rest, bundle_hash: await sha256Hex(canonicalJson(rest)) };
}

const EVAL_CALLER = { zone: "evaluation_domain" } as const;

/** contender-1, bound to `workId`, with its push of `cand` observed by the authority. */
function observedContender(state: AuthorityState, workId: string, cand: string): AuthorityState {
	return {
		...state,
		contenders: {
			"contender-1": {
				contender_id: "contender-1",
				agent_id: "contender-1",
				fork_repo: "fork-contender-1",
				fork_lineage: { parent_repo: "acme/api", parent_commit: "base123" },
				fork_base: "base123",
				token_id: "tok-1",
				token_ids: ["tok-1"],
				status: "forked",
				claim_work_id: workId,
				latest_commit: cand,
			},
		},
	};
}

/** Authority driven to an ACCEPT verdict for one candidate; returns state + ids. */
async function authorityWithPermit(ctx: Ctx, task_hash: string, cand: string, tree: string, head: string) {
	let state: AuthorityState = createAuthority({
		task_id: `task-${task_hash}`,
		task_hash,
		intent: "fix",
		baseline_repo: "acme/api",
		baseline_commit: "base123",
		behavior_contract: "works",
		policy_version: SELECTOR_POLICY_VERSION,
		frozen_at: ctx.now(),
	});
	const claimRes = await registerClaim(
		state,
		{
			agent: "contender-1",
			task: task_hash,
			baseline: "base123",
			intent: { behavior: ["fix"] },
			scope: { paths: ["src/a.js"], symbols: [] },
			contracts: { reads: [], modifies: [] },
			interfaces: [],
			schema_changes: [],
			expected_tests: ["expired token returns true"],
			lease: { claimed_at: ctx.now(), expires_at: "2026-10-02T00:00:00Z" },
		},
		ctx,
	);
	state = observedContender(claimRes.state, claimRes.claim.work_id, cand);
	const bundle = await makeBundle({ candidate_sha: cand, tree_sha256: tree, contender_id: "contender-1", task_hash });
	state = (await submitEvaluation(state, bundle, EVAL_CALLER, ctx)).state;
	const v = await runVerdictSeam(
		state,
		[{ contender_id: "contender-1", candidate_sha: cand, blast_radius: 1, change_surface: 1 }],
		ctx,
	);
	state = v.state;
	assert.equal(v.record.state, "ACCEPT");
	const issued = await issuePermit(state, cand, "canonical", head, ctx);
	assert.equal(issued.outcome, "ISSUED");
	assert.ok(issued.permit);
	return { state: issued.state, permit: issued.permit };
}

describe("promotion attacks", () => {
	it("commit-swap: reviewed X, pushed Y → TREE_MISMATCH, unconsumed, no effects; retry with X's tree → PROMOTED", async () => {
		const ctx = makeCtx();
		const SHA_X = "sha-x-reviewed";
		const TREE_X = "tree-x";
		const TREE_Y = "tree-y-attacker";
		const HEAD = "base123";
		const { state: s0, permit } = await authorityWithPermit(ctx, "taskhash-swap", SHA_X, TREE_X, HEAD);

		// Attacker pushes SHA Y after review; permit for X is presented
		// with Y's tree → TREE_MISMATCH.
		const a1 = await attemptPromotion(s0, permit.permit_id, HEAD, TREE_Y, ctx);
		assert.equal(a1.outcome, "TREE_MISMATCH");
		assert.equal(a1.effects.length, 0, "TREE_MISMATCH must have no effects");
		assert.equal(
			a1.state.permits[permit.permit_id].consumed,
			false,
			"mismatched permit must NOT be consumed",
		);
		const aborts = a1.state.ledger.filter((e) => e.kind === "promotion_aborted");
		assert.ok(aborts.length >= 1, "ledger must record the TREE_MISMATCH abort");

		// Legitimate retry with X's actual reviewed tree → PROMOTED,
		// exactly one canonical_write effect.
		const a2 = await attemptPromotion(a1.state, permit.permit_id, HEAD, TREE_X, ctx);
		assert.equal(a2.outcome, "PROMOTED");
		const writes = a2.effects.filter((e) => e.kind === "canonical_write");
		assert.equal(writes.length, 1, "promotion must emit exactly one canonical_write");
	});

	it("permit double-issue before consumption converges; replay after promote → ALREADY_CONSUMED", async () => {
		const ctx = makeCtx();
		const { state: s0, permit } = await authorityWithPermit(ctx, "taskhash-dbl1", "sha-d", "tree-d", "base123");

		// Re-issue before consumption → the SAME record (idempotent), still
		// unconsumed. permit_id is deterministic over the bound fields.
		const re = await issuePermit(s0, "sha-d", "canonical", "base123", ctx);
		assert.ok(re.permit);
		assert.equal(re.permit.permit_id, permit.permit_id, "re-issue must converge to the same permit_id");
		assert.equal(re.permit.consumed, false, "unconsumed permit stays unconsumed");
		assert.equal(re.state, s0, "idempotent re-issue must not change state");

		// Present once → PROMOTED.
		const a1 = await attemptPromotion(re.state, permit.permit_id, "base123", "tree-d", ctx);
		assert.equal(a1.outcome, "PROMOTED");

		// Present again → ALREADY_CONSUMED, no effects, no second write.
		const a2 = await attemptPromotion(a1.state, permit.permit_id, "base123", "tree-d", ctx);
		assert.equal(a2.outcome, "ALREADY_CONSUMED");
		assert.equal(a2.effects.length, 0, "replay must have no effects");
	});

	it("re-issue AFTER consumption returns the consumed record (no resurrection)", async () => {
		const ctx = makeCtx();
		const { state: s0, permit } = await authorityWithPermit(ctx, "taskhash-dbl2", "sha-r", "tree-r", "base123");
		const a1 = await attemptPromotion(s0, permit.permit_id, "base123", "tree-r", ctx);
		assert.equal(a1.outcome, "PROMOTED");

		// The attack this guards: issuePermit used to OVERWRITE the permit
		// record, resetting consumed=false. Now it must return the stored
		// (consumed) record.
		const re = await issuePermit(a1.state, "sha-r", "canonical", "base123", ctx);
		assert.ok(re.permit);
		assert.equal(re.permit.permit_id, permit.permit_id);
		assert.equal(re.permit.consumed, true, "re-issue must not resurrect a consumed permit");

		const a2 = await attemptPromotion(re.state, permit.permit_id, "base123", "tree-r", ctx);
		assert.equal(a2.outcome, "ALREADY_CONSUMED");
		assert.equal(a2.effects.length, 0, "no second promotion possible");
	});
});
