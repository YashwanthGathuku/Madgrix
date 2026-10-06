/**
 * Fork-crew composition fails closed (specs/amendments/composition-result-v1.md).
 * node --test test/composition-authority.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, sha256Hex } from "../src/lib/canonical.ts";
import { treeDigestOfFiles } from "../src/lib/tree-digest.ts";
import {
	attemptPromotion,
	createAuthority,
	issuePermit,
	recordComposition,
	runVerdictSeam,
	submitEvaluation,
	type Ctx,
} from "../src/lib/task-state.ts";
import type { AuthorityState, CompositionRecord, EvaluationBundle } from "../src/lib/types.ts";
import { FIXED_TREE, TOKENS, call, makeHarness, push, worker } from "./helpers/worker-harness.ts";

const BASELINE = "base123";
const SIDE_A = "side-a";
const SIDE_B = "side-b";
const RESOLVED = "resolved-sha";

function makeCtx(): Ctx {
	return {
		now: () => "2026-10-06T12:00:00.000Z",
		randomHex: (n: number) => "f".repeat(n * 2),
		sha256Hex,
		selectorPolicyHash: "policyhash",
		policyVersion: "seam-policy/0.1.0",
	};
}

function composition(overrides: Partial<CompositionRecord> = {}): CompositionRecord {
	return {
		status: "CONFLICTED",
		contender_id: "contender-1",
		baseline: BASELINE,
		agents: [
			{ id: "sub-api", role: "api", intent: "change the handler", sha: SIDE_A, paths: ["src/api.js"], claim_work_id: "W-api" },
			{ id: "sub-ui", role: "ui", intent: "change the view", sha: SIDE_B, paths: ["src/ui.js"], claim_work_id: "W-ui" },
		],
		contributing_shas: [SIDE_A, SIDE_B],
		files: [
			{
				path: "src/shared.js",
				classification: "textual-line-overlap",
				sides: [
					{ agent_id: "sub-api", role: "api", intent: "change the handler", sha: SIDE_A, excerpt: "api-body" },
					{ agent_id: "sub-ui", role: "ui", intent: "change the view", sha: SIDE_B, excerpt: "x".repeat(500) },
				],
			},
		],
		candidate_sha: null,
		...overrides,
	};
}

async function makeBundle(overrides: Partial<EvaluationBundle> = {}): Promise<EvaluationBundle> {
	const base = {
		candidate_sha: SIDE_A,
		tree_sha256: "tree1",
		contender_id: "contender-1",
		task_hash: "taskhash-abc",
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
		evaluated_at: "2026-10-06T12:00:00Z",
		tainted: false,
		...overrides,
	};
	const { bundle_hash: _ignored, ...rest } = base as EvaluationBundle & { bundle_hash?: string };
	return { ...(rest as EvaluationBundle), bundle_hash: await sha256Hex(canonicalJson(rest)) };
}

function observed(sha: string): AuthorityState {
	const state = createAuthority({
		task_id: "task-1",
		task_hash: "taskhash-abc",
		intent: "compose two agents",
		baseline_repo: "acme/api",
		baseline_commit: BASELINE,
		behavior_contract: "both behaviors hold",
		policy_version: "seam-policy/0.1.0",
		frozen_at: "2026-10-06T11:00:00Z",
	});
	state.contenders["contender-1"] = {
		contender_id: "contender-1",
		agent_id: "agent-1",
		fork_repo: "fork-1",
		fork_lineage: { parent_repo: "acme/api", parent_commit: BASELINE },
		fork_base: BASELINE,
		token_id: "tok-1",
		status: "forked",
		claim_work_id: null,
		latest_commit: sha,
	};
	return state;
}

async function accepted(ctx: Ctx, sha: string): Promise<AuthorityState> {
	let state = observed(sha);
	const bundle = await makeBundle({ candidate_sha: sha });
	state = (await submitEvaluation(state, bundle, { zone: "evaluation_domain" }, ctx)).state;
	const seam = await runVerdictSeam(
		state,
		[{ contender_id: "contender-1", candidate_sha: sha, blast_radius: 1, change_surface: 1 }],
		ctx,
	);
	assert.equal(seam.record.state, "ACCEPT");
	return seam.state;
}

describe("composition authority", () => {
	it("CONFLICTED is not evidence, a permit, or a promotion", async () => {
		const ctx = makeCtx();
		let state = await accepted(ctx, SIDE_A);
		const issued = await issuePermit(state, SIDE_A, "acme/api", BASELINE, ctx);
		assert.equal(issued.outcome, "ISSUED");
		assert.ok(issued.permit);
		state = await recordComposition(issued.state, composition(), ctx);
		assert.equal(state.composition?.files[0].sides[1].excerpt.length, 400);

		await assert.rejects(
			submitEvaluation(state, await makeBundle({ candidate_sha: SIDE_A }), { zone: "evaluation_domain" }, ctx),
			/CONFLICTED/,
		);
		const refused = await issuePermit(state, SIDE_A, "acme/api", BASELINE, ctx);
		assert.equal(refused.outcome, "UNRESOLVED_CONFLICT");
		assert.equal(refused.permit, null);
		const promoted = await attemptPromotion(state, issued.permit.permit_id, BASELINE, "tree1", ctx);
		assert.equal(promoted.outcome, "UNRESOLVED_CONFLICT");
		assert.deepEqual(promoted.effects, []);
		assert.equal(promoted.state.permits[issued.permit.permit_id].consumed, false);
	});

	it("CONFLICTED cannot become COMPOSED, and the same record is idempotent", async () => {
		const ctx = makeCtx();
		const recorded = await recordComposition(observed(SIDE_A), composition(), ctx);
		assert.equal(recorded.ledger.at(-1)?.kind, "composition_recorded");
		const again = await recordComposition(recorded, composition(), ctx);
		assert.equal(again.ledger.length, recorded.ledger.length);
		await assert.rejects(
			recordComposition(recorded, composition({ status: "COMPOSED", candidate_sha: RESOLVED }), ctx),
			/cannot become an ordinary candidate/,
		);
		await assert.rejects(
			recordComposition(observed(SIDE_A), composition({ baseline: "other-base" }), ctx),
			/frozen task baseline/,
		);
		await assert.rejects(
			recordComposition(observed(SIDE_A), composition({ status: "RESOLVED", candidate_sha: SIDE_A }), ctx),
			/must be new/,
		);
	});

	it("a resolved SHA needs new evidence; a contributing SHA and an old hash cannot authorize it", async () => {
		const ctx = makeCtx();
		let state = await accepted(ctx, SIDE_A);
		state = await recordComposition(state, composition({ status: "RESOLVED", candidate_sha: RESOLVED }), ctx);
		await assert.rejects(
			submitEvaluation(state, await makeBundle({ candidate_sha: SIDE_A }), { zone: "evaluation_domain" }, ctx),
			/contributing SHA/,
		);
		const sidePermit = await issuePermit(state, SIDE_A, "acme/api", BASELINE, ctx);
		assert.equal(sidePermit.outcome, "UNRESOLVED_CONFLICT");
		await assert.rejects(issuePermit(state, RESOLVED, "acme/api", BASELINE, ctx), /no ACCEPT verdict/);

		state = { ...state, contenders: { "contender-1": { ...state.contenders["contender-1"], latest_commit: RESOLVED } } };
		const old = await makeBundle({ candidate_sha: SIDE_A });
		const swapped = { ...old, candidate_sha: RESOLVED };
		state = (await submitEvaluation(state, swapped, { zone: "evaluation_domain" }, ctx)).state;
		const reused = await runVerdictSeam(
			state,
			[{ contender_id: "contender-1", candidate_sha: RESOLVED, blast_radius: 1, change_surface: 1 }],
			ctx,
		);
		assert.equal(reused.record.state, "REJECT");
		assert.match(reused.record.reasons.join("\n"), /evaluation_bundle_hash mismatch/);
		await assert.rejects(issuePermit(reused.state, RESOLVED, "acme/api", BASELINE, ctx), /no ACCEPT verdict/);

		const fresh = await makeBundle({ candidate_sha: RESOLVED, tree_sha256: "tree-resolved" });
		let clean = await recordComposition(
			observed(RESOLVED),
			composition({ status: "RESOLVED", candidate_sha: RESOLVED }),
			ctx,
		);
		clean = (await submitEvaluation(clean, fresh, { zone: "evaluation_domain" }, ctx)).state;
		const seam = await runVerdictSeam(
			clean,
			[{ contender_id: "contender-1", candidate_sha: RESOLVED, blast_radius: 1, change_surface: 1 }],
			ctx,
		);
		assert.equal(seam.record.state, "ACCEPT");
		assert.equal(seam.record.winner_sha, RESOLVED);
		const permit = await issuePermit(seam.state, RESOLVED, "acme/api", BASELINE, ctx);
		assert.equal(permit.outcome, "ISSUED");
		assert.equal(permit.permit?.winner_candidate_sha, RESOLVED);
	});
});

describe("composition route", () => {
	it("only the control plane can record a conflict, and the graph escapes it", async () => {
		const h = await makeHarness();
		const sha = await push(h, FIXED_TREE, h.baseline);
		const body = {
			composition: composition({
				contender_id: h.contenderId,
				baseline: h.baseline,
				files: [
					{
						path: "src/shared.js",
						classification: "textual-line-overlap",
						sides: [
							{ agent_id: "sub-api", role: "api", intent: "change the handler", sha: SIDE_A, excerpt: "api" },
							{
								agent_id: "sub-ui",
								role: "ui",
								intent: "change the view",
								sha: SIDE_B,
								excerpt: "<script>alert(1)</script>",
							},
						],
					},
				],
			}),
		};
		assert.equal((await call(h, "POST", `/tasks/${h.taskId}/composition`, { token: TOKENS.agent, body })).status, 401);
		assert.equal((await call(h, "POST", `/tasks/${h.taskId}/composition`, { token: TOKENS.evaluation, body })).status, 401);
		const recorded = await call(h, "POST", `/tasks/${h.taskId}/composition`, { token: TOKENS.control, body });
		assert.equal(recorded.status, 200, JSON.stringify(recorded.body));
		assert.equal(recorded.body.status, "CONFLICTED");

		const tree = h.fake.readCommitObject(h.forkRepo, sha)!.tree;
		const rest = {
			candidate_sha: sha,
			tree_sha256: await treeDigestOfFiles(tree),
			contender_id: h.contenderId,
			task_hash: h.taskHash,
			admission: {
				exact_baseline: true,
				scope_compliance: true,
				valid_tool_states: true,
				no_eval_tampering: true,
				provenance_complete: true,
			},
			hidden_oracle: { passed: true, total: 1, failed: [] as string[] },
			regressions: { passed: true, total: 1, failed: [] as string[] },
			static_analysis: { passed: true, findings: [] as string[] },
			semantic_checks: { passed: true, total: 1, failed: [] as string[] },
			security_policy: { passed: true, findings: [] as string[] },
			evaluated_at: "2026-10-06T12:00:00Z",
			tainted: false,
		};
		const evidence = await call(h, "POST", `/tasks/${h.taskId}/evidence`, {
			token: TOKENS.evaluation,
			body: { bundle: { ...rest, bundle_hash: await sha256Hex(canonicalJson(rest)) } },
		});
		assert.equal(evidence.status, 422, JSON.stringify(evidence.body));
		assert.match(evidence.body.detail, /CONFLICTED/);

		assert.equal((await call(h, "GET", `/tasks/${h.taskId}/context`)).status, 401);
		const visible = await call(h, "GET", `/tasks/${h.taskId}/context`, { token: TOKENS.agent });
		assert.equal(visible.status, 200, JSON.stringify(visible.body));
		assert.equal(visible.body.composition.status, "CONFLICTED");
		assert.equal(visible.body.composition.candidate_sha, null);
		assert.equal(JSON.stringify(visible.body).includes("agent_secret"), false);

		const page = await worker.fetch(new Request(`https://madgrix.test/tasks/${h.taskId}/graph`, {
			headers: { authorization: `Bearer ${TOKENS.control}` },
		}), h.env as never);
		const html = await page.text();
		assert.equal(page.status, 200);
		assert.match(page.headers.get("content-type") ?? "", /text\/html/);
		assert.match(html, /CONFLICTED/);
		assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
		assert.doesNotMatch(html, /<script>alert/);

		const ordinary = await call(h, "POST", `/tasks/${h.taskId}/composition`, {
			token: TOKENS.control,
			body: { composition: composition({ contender_id: h.contenderId, baseline: h.baseline, status: "COMPOSED", candidate_sha: RESOLVED }) },
		});
		assert.equal(ordinary.status, 422, JSON.stringify(ordinary.body));
	});
});
