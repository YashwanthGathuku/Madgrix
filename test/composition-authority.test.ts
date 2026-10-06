/**
 * Fork-crew composition fails closed (specs/amendments/composition-result-v1.md).
 * node --test test/composition-authority.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, sha256Hex } from "../src/lib/canonical.ts";
import { assumeCompleteMergeArtifactScan } from "../src/lib/merge-artifacts.ts";
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
import { buildWorkGraph } from "../src/lib/work-graph.ts";
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
	const scanned = assumeCompleteMergeArtifactScan(rest);
	return { ...(scanned as EvaluationBundle), bundle_hash: await sha256Hex(canonicalJson(scanned)) };
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

	it("only COMPOSED and RESOLVED expose a candidate, and a resolver SHA is not a contribution", async () => {
		const ctx = makeCtx();
		const pending = composition({ status: "PENDING", candidate_sha: null, contributing_shas: [], agents: [], files: [] });
		let state = await recordComposition(observed(SIDE_A), pending, ctx);
		assert.equal(state.composition?.candidate_sha, null);
		assert.equal(buildWorkGraph(state).composition_state, "PENDING");
		assert.equal(buildWorkGraph(state).candidate_sha, null);
		const pendingPermit = await issuePermit(
			await recordComposition(await accepted(ctx, SIDE_A), pending, ctx),
			SIDE_A,
			"acme/api",
			BASELINE,
			ctx,
		);
		assert.equal(pendingPermit.outcome, "UNRESOLVED_CONFLICT");

		state = await recordComposition(state, composition({ status: "COMPOSING", candidate_sha: null, contributing_shas: [], agents: [], files: [] }), ctx);
		assert.equal(state.composition?.status, "COMPOSING");
		assert.equal(state.composition?.candidate_sha, null);
		state = await recordComposition(state, composition(), ctx);
		assert.equal(state.composition?.status, "CONFLICTED");
		assert.equal(buildWorkGraph(state).candidate_sha, null);
		assert.equal(buildWorkGraph(state).crew?.parent.authority, "parent");
		assert.deepEqual(
			buildWorkGraph(state).members.map((member) => member.agent_id),
			["sub-api", "sub-ui"],
		);
		assert.equal(buildWorkGraph(state).overlaps[0]?.path, "src/shared.js");
		assert.ok(buildWorkGraph(state).dependencies.some((edge) => edge.relation === "overlap"));
		assert.ok(buildWorkGraph(state).dependencies.some((edge) => edge.relation === "baseline" && edge.to === BASELINE));

		await assert.rejects(
			recordComposition(state, composition({ status: "RESOLVING", candidate_sha: SIDE_A }), ctx),
			/RESOLVING has no candidate SHA/,
		);
		state = await recordComposition(state, composition({ status: "RESOLVING", candidate_sha: null }), ctx);
		assert.equal(state.composition?.candidate_sha, null);
		assert.equal(buildWorkGraph(state).composition_state, "RESOLVING");
		const resolvingPermit = await issuePermit(
			await recordComposition(await accepted(ctx, SIDE_A), composition({ status: "RESOLVING", candidate_sha: null }), ctx),
			SIDE_A,
			"acme/api",
			BASELINE,
			ctx,
		);
		assert.equal(resolvingPermit.outcome, "UNRESOLVED_CONFLICT");

		await assert.rejects(
			recordComposition(state, composition({ status: "RESOLVED", candidate_sha: SIDE_B }), ctx),
			/must be new/,
		);
		state = await recordComposition(state, composition({ status: "RESOLVED", candidate_sha: RESOLVED }), ctx);
		const graph = buildWorkGraph(state);
		assert.equal(graph.composition_state, "RESOLVED");
		assert.equal(graph.candidate_sha, RESOLVED);
		assert.equal(graph.crew?.candidate_sha, RESOLVED);
		assert.equal(graph.crew?.outcome, "RESOLVED");
		assert.equal(state.composition?.contributing_shas.includes(graph.candidate_sha ?? ""), false);
		await assert.rejects(
			recordComposition(state, composition({ status: "COMPOSED", candidate_sha: "other-sha" }), ctx),
			/already bound/,
		);
		await assert.rejects(recordComposition(observed(SIDE_A), composition({ status: "COMPOSED", candidate_sha: null }), ctx), /require a candidate SHA/);
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
		const scanned = assumeCompleteMergeArtifactScan(rest);
		const evidence = await call(h, "POST", `/tasks/${h.taskId}/evidence`, {
			token: TOKENS.evaluation,
			body: { bundle: { ...scanned, bundle_hash: await sha256Hex(canonicalJson(scanned)) } },
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
		assert.match(html, /Live work graph/);
		assert.match(html, /Resolution state: unresolved/);
		assert.match(html, /PROMOTABLE CANDIDATE: NONE/);
		assert.match(html, /Offline verification/);
		assert.match(html, /Not run/);
		assert.doesNotMatch(html, /\bVERIFIED\b/);
		assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
		assert.doesNotMatch(html, /<script>alert/);
		assert.match(html, /sub-api/);
		assert.match(html, /src\/shared\.js/);
		assert.doesNotMatch(html, /Fixture\/demo input/);
		assert.doesNotMatch(html, /class="edge /);

		const data = await worker.fetch(new Request(`https://madgrix.test/tasks/${h.taskId}/graph?format=json`, {
			headers: { authorization: `Bearer ${TOKENS.control}` },
		}), h.env as never);
		const graph = await data.json() as {
			composition_state: string;
			candidate_sha: string | null;
			crew: { parent: { authority: string }; outcome: string; candidate_sha: string | null; members: Array<{ agent_id: string; intent: string; scope: string[]; commit_sha: string }> };
			overlaps: Array<{ path: string; agents: string[] }>;
			dependencies: Array<{ relation: string }>;
		};
		assert.equal(data.status, 200);
		assert.match(data.headers.get("content-type") ?? "", /application\/json/);
		assert.equal(graph.composition_state, "CONFLICTED");
		assert.equal(graph.candidate_sha, null);
		assert.equal(graph.crew.candidate_sha, null);
		assert.equal(graph.crew.parent.authority, "parent");
		assert.equal(graph.crew.outcome, "CONFLICTED");
		assert.deepEqual(graph.crew.members.map((member) => member.agent_id), ["sub-api", "sub-ui"]);
		assert.equal(graph.crew.members[0].intent, "change the handler");
		assert.deepEqual(graph.crew.members[0].scope, ["src/api.js"]);
		assert.equal(graph.crew.members[0].commit_sha, SIDE_A);
		assert.equal(graph.overlaps[0].path, "src/shared.js");
		assert.ok(graph.dependencies.some((edge) => edge.relation === "overlap"));
		assert.equal(JSON.stringify(graph).includes(SIDE_A) && graph.candidate_sha === null, true);

		const ordinary = await call(h, "POST", `/tasks/${h.taskId}/composition`, {
			token: TOKENS.control,
			body: { composition: composition({ contender_id: h.contenderId, baseline: h.baseline, status: "COMPOSED", candidate_sha: RESOLVED }) },
		});
		assert.equal(ordinary.status, 422, JSON.stringify(ordinary.body));

		const resolving = await call(h, "POST", `/tasks/${h.taskId}/composition`, {
			token: TOKENS.control,
			body: { composition: composition({ contender_id: h.contenderId, baseline: h.baseline, status: "RESOLVING", candidate_sha: null }) },
		});
		assert.equal(resolving.status, 200, JSON.stringify(resolving.body));
		const resolved = await call(h, "POST", `/tasks/${h.taskId}/composition`, {
			token: TOKENS.control,
			body: { composition: composition({ contender_id: h.contenderId, baseline: h.baseline, status: "RESOLVED", candidate_sha: RESOLVED }) },
		});
		assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
		const after = await call(h, "GET", `/tasks/${h.taskId}/graph?format=json`, { token: TOKENS.agent });
		assert.equal(after.status, 200, JSON.stringify(after.body));
		assert.equal(after.body.composition_state, "RESOLVED");
		assert.equal(after.body.candidate_sha, RESOLVED);
		assert.equal(after.body.crew.candidate_sha, RESOLVED);
		assert.equal(after.body.contributing_shas, undefined);
		assert.equal((after.body.crew.members as Array<{ commit_sha: string }>).some((member) => member.commit_sha === RESOLVED), false);
	});
});
