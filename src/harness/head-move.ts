/**
 * HEAD-MOVE SCENARIO — rebase-vs-reverify, end to end.
 * (Internal codename: seam — NOT a public brand.)
 *
 * Run: `node src/harness/head-move.ts` (Node 24 type-stripping; no build step).
 *
 * The failure mode this closes: a permit issued at destination HEAD H1 is
 * presented after the destination HEAD has moved to H2 (concurrent merge,
 * TOCTOU). The permit MUST expire — presenting it is a no-op ACK, the
 * permit is NOT consumed, and there are NO effects. The legitimate path
 * is rebase-vs-reverify: re-evaluate the candidate against the new head
 * (new bundle_hash), run the verdict again, issue a fresh permit bound to
 * the new head and the new evidence, and promote.
 *
 * This is the same production transition functions as the slice
 * (pure task-state machine) — no slice-only forks. The harness exits
 * non-zero on any unexpected outcome.
 */
import {
	attemptPromotion,
	createAuthority,
	defaultCtx,
	ingestQueueEvent,
	issuePermit,
	registerClaim,
	registerContender,
	runVerdictSeam,
	submitEvaluation,
	type Ctx,
} from "../lib/task-state.ts";
import { canonicalJson, sha256Hex } from "../lib/canonical.ts";
import { SELECTOR_POLICY_VERSION, type AuthorityState, type EvaluationBundle } from "../lib/types.ts";

interface HeadMoveResult {
	promotedOnceSha: string;
	expiredPermitId: string;
	expiredOutcome: "EXPIRED_HEAD_MOVED";
	reverifiedPermitId: string;
	reverifiedOutcome: "PROMOTED";
}

function check(cond: boolean, msg: string): void {
	if (!cond) {
		console.error(`HEAD-MOVE ASSERT FAILED: ${msg}`);
		process.exitCode = 1;
		throw new Error(msg);
	}
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

/**
 * Run the full rebase-vs-reverify loop against a fresh authority.
 * Exported so test/head-move.test.ts can drive it with a deterministic ctx.
 */
export async function runHeadMoveScenario(ctx: Ctx): Promise<{ state: AuthorityState; result: HeadMoveResult }> {
	const task_hash = await sha256Hex(canonicalJson({ task: "head-move", ctx: "scenario" }));
	let state = createAuthority({
		task_id: "task-headmove",
		task_hash,
		intent: "fix the thing",
		baseline_repo: "acme/api",
		baseline_commit: "base123",
		behavior_contract: "it works",
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
	state = claimRes.state;

	const CAND = "cand-x";
	const TREE_X = "tree-x";

	// contender-1's fork, and the push of CAND observed through the queue:
	// evidence is admissible only for a contender's latest observed commit.
	state = (
		await registerContender(
			state,
			{
				contender_id: "contender-1",
				agent_id: "contender-1",
				fork_repo: "fork-contender-1",
				fork_lineage: { parent_repo: "acme/api", parent_commit: "base123" },
				token_id: "tok-1",
				token_ids: ["tok-1"],
				status: "forked",
				claim_work_id: claimRes.claim.work_id,
				latest_commit: null,
			},
			ctx,
		)
	).state;
	const pushed = await ingestQueueEvent(
		state,
		{ namespace: "headmove", repo: "fork-contender-1", ref: "refs/heads/main", before: "base123", after: CAND },
		ctx,
	);
	check(pushed.outcome === "APPLIED_NEW", "the contender's push must be observed");
	state = pushed.state;

	// --- promote once at HEAD H0 -------------------------------------
	const bundle1 = await makeBundle({
		candidate_sha: CAND,
		tree_sha256: TREE_X,
		contender_id: "contender-1",
		task_hash,
		evaluated_at: "2026-10-01T18:00:00Z",
	});
	const e1 = await submitEvaluation(state, bundle1, { zone: "evaluation_domain" }, ctx);
	check(e1.outcome === "RECORDED", "initial evidence must be RECORDED");
	state = e1.state;
	const v1 = await runVerdictSeam(
		state,
		[{ contender_id: "contender-1", candidate_sha: CAND, blast_radius: 1, change_surface: 1 }],
		ctx,
	);
	state = v1.state;
	check(v1.record.state === "ACCEPT", "verdict must be ACCEPT");
	const H0 = "dest-head-0";
	const p1 = await issuePermit(state, CAND, "canonical", H0, ctx);
	state = p1.state;
	const a1 = await attemptPromotion(state, p1.permit.permit_id, H0, TREE_X, ctx);
	state = a1.state;
	check(a1.outcome === "PROMOTED", `first promotion must succeed (got ${a1.outcome})`);
	check(
		a1.effects.filter((e) => e.kind === "canonical_write").length === 1,
		"promotion must emit exactly one canonical_write",
	);
	console.log(`[1] promoted ${CAND} at ${H0} → PROMOTED`);

	// --- issue an UNCONSUMED permit at the post-promotion head -------
	// The destination HEAD is now the promoted commit (H1).
	const H1 = CAND; // the canonical HEAD is the promoted candidate commit
	const p2 = await issuePermit(state, CAND, "canonical", H1, ctx);
	state = p2.state;
	console.log(`[2] issued unconsumed permit ${p2.permit.permit_id.slice(0, 12)}… bound to head ${H1}`);

	// --- concurrent merge moves HEAD to H2 ----------------------------
	const H2 = "dest-head-2";
	console.log(`[3] concurrent merge: destination HEAD ${H1} → ${H2}`);

	// --- present the stale permit: MUST expire, NOT consumed -----------
	const a2 = await attemptPromotion(state, p2.permit.permit_id, H2, TREE_X, ctx);
	state = a2.state;
	check(a2.outcome === "EXPIRED_HEAD_MOVED", `stale permit must EXPIRE (got ${a2.outcome})`);
	check(a2.effects.length === 0, "expired permit must have NO effects");
	check(
		state.permits[p2.permit.permit_id].consumed === false,
		"expired permit must remain UNCONSUMED (a legitimate retry stays possible)",
	);
	console.log(`[4] stale permit presented at ${H2} → EXPIRED_HEAD_MOVED, unconsumed, no effects`);

	// --- rebase-vs-reverify: re-evaluate against the NEW head ---------
	// New evidence (new bundle_hash) — the old permit binds the old
	// evidence and can never promote again.
	const bundle2 = await makeBundle({
		candidate_sha: CAND,
		tree_sha256: TREE_X,
		contender_id: "contender-1",
		task_hash,
		evaluated_at: "2026-10-01T19:00:00Z", // re-evaluation at the new head
	});
	check(bundle2.bundle_hash !== bundle1.bundle_hash, "re-evaluation must produce a new bundle_hash");
	const e2 = await submitEvaluation(state, bundle2, { zone: "evaluation_domain" }, ctx);
	check(e2.outcome === "RECORDED", "re-evaluation must be RECORDED");
	state = e2.state;
	const v2 = await runVerdictSeam(
		state,
		[{ contender_id: "contender-1", candidate_sha: CAND, blast_radius: 1, change_surface: 1 }],
		ctx,
	);
	state = v2.state;
	check(v2.record.state === "ACCEPT", "re-verdict must be ACCEPT");
	const p3 = await issuePermit(state, CAND, "canonical", H2, ctx);
	state = p3.state;
	check(
		p3.permit.evaluation_bundle_hash === bundle2.bundle_hash,
		"fresh permit must bind the NEW evidence",
	);
	const a3 = await attemptPromotion(state, p3.permit.permit_id, H2, TREE_X, ctx);
	state = a3.state;
	check(a3.outcome === "PROMOTED", `re-verified promotion must succeed (got ${a3.outcome})`);
	console.log(`[5] re-evaluated at ${H2}, new permit → PROMOTED`);

	return {
		state,
		result: {
			promotedOnceSha: CAND,
			expiredPermitId: p2.permit.permit_id,
			expiredOutcome: "EXPIRED_HEAD_MOVED",
			reverifiedPermitId: p3.permit.permit_id,
			reverifiedOutcome: "PROMOTED",
		},
	};
}

// Standalone run: `node src/harness/head-move.ts`.
const isMain = process.argv[1]?.endsWith("head-move.ts") ?? false;
if (isMain) {
	const { SELECTOR_POLICY_INPUT } = await import("../do/TaskAuthority.ts");
	const ctx = defaultCtx(await sha256Hex(SELECTOR_POLICY_INPUT));
	await runHeadMoveScenario(ctx);
	console.log("HEAD-MOVE OK: rebase-vs-reverify loop closed end to end.");
}
