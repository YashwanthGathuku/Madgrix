/**
 * Rebase-vs-reverify, end to end (spec 1 §10–§11;
 * specs/amendments/rebase-ancestry-v1.md).
 *
 * Drives src/harness/head-move.ts's runHeadMoveScenario with a
 * deterministic ctx and asserts the full loop: a permit at the fork base →
 * a concurrent merge moves the destination HEAD → the stale permit EXPIRES
 * (unconsumed, no effects) → the SAME SHA, re-evaluated, gets no permit at
 * the moved head (REBASE_REQUIRED; promote.sh would exit 47) → the rebase
 * service replays the candidate onto the moved head as a NEW SHA → fresh
 * evidence for that SHA → new verdict → new permit → PROMOTED, the
 * destination fast-forwarding to the rebased commit.
 *
 * Also the EVAL_BUNDLE_MISMATCH regression (spec 1 §11 check 4): a
 * permit issued under old evidence cannot promote after a re-evaluation
 * — the permit binds evaluation_bundle_hash, and promotion re-checks it
 * against the authority's stored bundle.
 *
 * node --test test/head-move.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, sha256Hex } from "../src/lib/canonical.ts";
import { runHeadMoveScenario } from "../src/harness/head-move.ts";
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
		now: () => "2026-10-01T20:00:00.000Z",
		randomHex: (n: number) => "a".repeat(n * 2),
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
	evaluated_at: string;
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
		evaluated_at: input.evaluated_at,
		tainted: false,
	};
	return { ...rest, bundle_hash: await sha256Hex(canonicalJson(rest)) };
}

describe("head-move: rebase-vs-reverify end to end", () => {
	it("stale permit expires; the same SHA gets no permit at the moved head; only the rebased SHA promotes", async () => {
		const ctx = makeCtx();
		const { state, result } = await runHeadMoveScenario(ctx);
		const r = result as any;

		assert.equal(r.expiredOutcome, "EXPIRED_HEAD_MOVED");
		assert.equal(state.permits[r.stalePermitId].consumed, false, "the expired permit must remain unconsumed");

		// The old step 5: the same SHA, re-evaluated, bound to the moved head.
		assert.equal(r.sameShaPermit, "REBASE_REQUIRED", "the authority must refuse a permit for the same SHA at the moved head");
		assert.equal(r.sameShaContainer, "BASELINE_MISMATCH", "promote.sh refuses it too (exit 47)");
		assert.ok(
			!Object.values(state.permits).some(
				(p) => p.winner_candidate_sha === r.candidateSha && p.expected_destination_head === r.movedHead,
			),
			"no permit for the original candidate is ever bound to the moved head",
		);

		// The new step 5: rebase → new SHA → fresh evidence → permit → promotion.
		assert.equal(r.rebaseOutcome, "REBASED");
		assert.notEqual(r.rebasedSha, r.candidateSha, "the rebase must produce a new SHA");
		assert.notEqual(
			state.evaluations[r.rebasedSha]?.bundle_hash,
			undefined,
			"the rebased SHA must have its own evidence",
		);
		assert.equal(r.promotedOutcome, "PROMOTED");
		assert.equal(r.promotedSha, r.rebasedSha, "only the rebased SHA may be promoted");
		assert.equal(r.promotedBase, r.movedHead, "the permit-bound base is the moved head");
		assert.equal(r.promotedParent, r.movedHead, "the rebased commit's own parent is the moved head");
		assert.equal(r.canonicalHead, r.rebasedSha, "the destination fast-forwards to the rebased commit");
		const permit = state.permits[r.promotedPermitId];
		assert.equal(permit.consumed, true, "the permit that promoted must be consumed");
		assert.equal(permit.winner_candidate_sha, r.rebasedSha);
		assert.equal(permit.expected_destination_head, r.movedHead);

		const aborts = state.ledger.filter((e) => e.kind === "promotion_aborted");
		assert.equal(aborts.length, 1, "the ledger records the one EXPIRED_HEAD_MOVED abort");
		assert.equal(state.ledger.filter((e) => e.kind === "permit_refused").length, 1, "and the one REBASE_REQUIRED refusal");
		assert.equal(state.ledger.filter((e) => e.kind === "rebase_recorded").length, 1, "and the rebase");
		assert.equal(state.task_status, "promoted");
	});

	it("EVAL_BUNDLE_MISMATCH: permit issued under old evidence cannot promote after re-evaluation", async () => {
		const ctx = makeCtx();
		const task_hash = "taskhash-ebm";
		let state: AuthorityState = createAuthority({
			task_id: "task-ebm",
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
		const CAND = "cand-e";
		// contender-1's push of CAND, as the authority observed it.
		state = {
			...claimRes.state,
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
					claim_work_id: claimRes.claim.work_id,
					latest_commit: CAND,
				},
			},
		};
		const TREE = "tree-e";
		// The destination is still at the contender's fork base.
		const HEAD = "base123";
		const b1 = await makeBundle({
			candidate_sha: CAND,
			tree_sha256: TREE,
			contender_id: "contender-1",
			task_hash,
			evaluated_at: "2026-10-01T18:00:00Z",
		});
		state = (await submitEvaluation(state, b1, { zone: "evaluation_domain" }, ctx)).state;
		const v = await runVerdictSeam(
			state,
			[{ contender_id: "contender-1", candidate_sha: CAND, blast_radius: 1, change_surface: 1 }],
			ctx,
		);
		state = v.state;
		assert.equal(v.record.state, "ACCEPT");
		const { state: s2, permit } = await issuePermit(state, CAND, "canonical", HEAD, ctx);
		assert.ok(permit);
		state = s2;

		// Re-evaluation supersedes the evidence the permit was issued under.
		const b2 = await makeBundle({
			candidate_sha: CAND,
			tree_sha256: TREE,
			contender_id: "contender-1",
			task_hash,
			evaluated_at: "2026-10-01T19:00:00Z",
		});
		assert.notEqual(b2.bundle_hash, b1.bundle_hash);
		state = (await submitEvaluation(state, b2, { zone: "evaluation_domain" }, ctx)).state;

		// The OLD permit must not promote: it binds the superseded bundle.
		const a = await attemptPromotion(state, permit.permit_id, HEAD, TREE, ctx);
		state = a.state;
		assert.equal(a.outcome, "EVAL_BUNDLE_MISMATCH");
		assert.equal(a.effects.length, 0, "no effects on a mismatched permit");
		assert.equal(
			state.permits[permit.permit_id].consumed,
			false,
			"mismatched permit must NOT be consumed",
		);

		// A fresh permit issued after the re-evaluation promotes normally.
		const v3 = await runVerdictSeam(
			state,
			[{ contender_id: "contender-1", candidate_sha: CAND, blast_radius: 1, change_surface: 1 }],
			ctx,
		);
		state = v3.state;
		const fresh = await issuePermit(state, CAND, "canonical", HEAD, ctx);
		assert.ok(fresh.permit);
		state = fresh.state;
		assert.notEqual(fresh.permit.permit_id, permit.permit_id, "fresh permit must differ (binds new bundle)");
		const a2 = await attemptPromotion(state, fresh.permit.permit_id, HEAD, TREE, ctx);
		assert.equal(a2.outcome, "PROMOTED");
	});
});
