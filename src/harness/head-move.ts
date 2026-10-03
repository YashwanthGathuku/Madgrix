/**
 * HEAD-MOVE SCENARIO — rebase-vs-reverify, end to end.
 * (Internal codename: seam — NOT a public brand.)
 *
 * Run: `node src/harness/head-move.ts` (Node type-stripping; no build step).
 *
 * The failure mode this closes: a permit issued at destination HEAD B is
 * presented after a concurrent merge moved the destination to H2 (TOCTOU).
 * The permit MUST expire — presenting it is a no-op ACK, the permit is NOT
 * consumed, and there are NO effects. Nor may the same reviewed commit simply
 * be re-permitted at H2: promotion fast-forwards the destination to the
 * reviewed commit, which does not descend from H2 (container/promote.sh exits
 * 47), so the authority refuses that permit with REBASE_REQUIRED. The
 * legitimate path is rebase-vs-reverify (specs/amendments/rebase-ancestry-v1.md):
 * the rebase service replays the candidate onto H2 as a NEW commit, the
 * authority records that H2 is its ancestor, the new SHA is evaluated again,
 * and only a fresh permit bound to H2 and that new evidence promotes it.
 *
 * Substrate: FakeArtifacts repositories; the promotion container is
 * src/harness/fake-container.ts, which runs the same procedures as
 * container/promote.sh and container/rebase.sh (the two are held together by
 * test/fixtures/promotion-cases.json). Authority transitions are the
 * production task-state functions — no harness-only forks. The harness exits
 * non-zero on any unexpected outcome.
 */
import {
	attemptPromotion,
	createAuthority,
	defaultCtx,
	ingestQueueEvent,
	issuePermit,
	recordRebase,
	registerClaim,
	registerContender,
	runVerdictSeam,
	submitEvaluation,
	type Ctx,
} from "../lib/task-state.ts";
import { canonicalJson, sha256Hex } from "../lib/canonical.ts";
import { FakeArtifacts } from "../lib/fake-artifacts.ts";
import { treeDigestOfFiles } from "../lib/tree-digest.ts";
import { SELECTOR_POLICY_VERSION, type AuthorityState, type EvaluationBundle } from "../lib/types.ts";
import { fakePromote, fakeRebase } from "./fake-container.ts";

export interface HeadMoveResult {
	baseline: string;
	/** The reviewed candidate, based on the baseline. */
	candidateSha: string;
	/** The destination head after the concurrent merge. */
	movedHead: string;
	stalePermitId: string;
	expiredOutcome: "EXPIRED_HEAD_MOVED";
	/** issuePermit for the SAME SHA at the moved head (head-move.ts's old step 5). */
	sameShaPermit: "REBASE_REQUIRED";
	/** What promote.sh answers for that SHA at the moved head. */
	sameShaContainer: "BASELINE_MISMATCH";
	rebaseOutcome: "REBASED";
	/** The new commit the rebase pushed to the contender's fork. */
	rebasedSha: string;
	promotedPermitId: string;
	promotedOutcome: "PROMOTED";
	promotedSha: string;
	/** The permit-bound head the promotion fast-forwarded from. */
	promotedBase: string;
	/** The promoted commit's own parent, as the container read it from git. */
	promotedParent: string;
	/** The destination's main after promotion. */
	canonicalHead: string;
}

function check(cond: boolean, msg: string): void {
	if (!cond) {
		console.error(`HEAD-MOVE ASSERT FAILED: ${msg}`);
		process.exitCode = 1;
		throw new Error(msg);
	}
}

const short = (sha: string) => sha.slice(0, 12);

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
 * Run the full rebase-vs-reverify loop against a fresh authority and fresh
 * FakeArtifacts repositories. Exported so test/head-move.test.ts can drive
 * it with a deterministic ctx.
 */
export async function runHeadMoveScenario(ctx: Ctx): Promise<{ state: AuthorityState; result: HeadMoveResult }> {
	const fake = new FakeArtifacts({ now: () => Date.parse("2026-10-01T18:00:00Z") });
	const CONTENDER = "contender-1";
	const FORK = "fork-contender-1";

	// The canonical repository, at the frozen baseline B.
	await fake.create("canonical");
	const baselineTree = {
		"README.md": "acme api\n",
		"src/a.js": "export const isExpired = (exp, now) => exp < now;\n",
	};
	const B = await fake.adminPush({ repo: "canonical", ref: "main", tree: baselineTree, message: "baseline" });
	const canonical = await fake.get("canonical");

	const task_hash = await sha256Hex(canonicalJson({ task: "head-move", ctx: "scenario" }));
	let state = createAuthority({
		task_id: "task-headmove",
		task_hash,
		intent: "fix the thing",
		baseline_repo: "canonical",
		baseline_commit: B,
		behavior_contract: "it works",
		policy_version: SELECTOR_POLICY_VERSION,
		frozen_at: ctx.now(),
	});
	const claimRes = await registerClaim(
		state,
		{
			agent: CONTENDER,
			task: task_hash,
			baseline: B,
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

	// contender-1 forks the canonical repository at B and pushes its fix X.
	await canonical.fork(FORK);
	const fork = await fake.get(FORK);
	const writeToken = await fork.createToken("write", 3600);
	state = (
		await registerContender(
			state,
			{
				contender_id: CONTENDER,
				agent_id: CONTENDER,
				fork_repo: FORK,
				fork_lineage: { parent_repo: "canonical", parent_commit: B },
				fork_base: B,
				token_id: writeToken.id,
				token_ids: [writeToken.id],
				status: "forked",
				claim_work_id: claimRes.claim.work_id,
				latest_commit: B,
			},
			ctx,
		)
	).state;
	const candidateTree = { ...baselineTree, "src/a.js": "export const isExpired = (exp, now) => exp <= now;\n" };
	const X = await fake.pushAsToken({
		repo: FORK,
		ref: "main",
		tree: candidateTree,
		message: "contender-1: fix isExpired",
		parents: [B],
		token: writeToken.plaintext,
	});
	const pushed = await ingestQueueEvent(state, { namespace: "headmove", repo: FORK, ref: "refs/heads/main", before: B, after: X }, ctx);
	check(pushed.outcome === "APPLIED_NEW", "the contender's push must be observed");
	state = pushed.state;
	const treeX = await treeDigestOfFiles(candidateTree);

	const evaluateAndAccept = async (sha: string, tree: string, evaluated_at: string) => {
		const evidence = await submitEvaluation(
			state,
			await makeBundle({ candidate_sha: sha, tree_sha256: tree, contender_id: CONTENDER, task_hash, evaluated_at }),
			{ zone: "evaluation_domain" },
			ctx,
		);
		check(evidence.outcome === "RECORDED", `evidence for ${short(sha)} must be RECORDED (got ${evidence.outcome})`);
		state = evidence.state;
		const verdict = await runVerdictSeam(state, [{ contender_id: CONTENDER, candidate_sha: sha, blast_radius: 1, change_surface: 1 }], ctx);
		check(verdict.record.state === "ACCEPT", `verdict for ${short(sha)} must be ACCEPT (got ${verdict.record.state})`);
		state = verdict.state;
	};

	// --- [1] permit at the fork base -----------------------------------
	await evaluateAndAccept(X, treeX, "2026-10-01T18:00:00Z");
	const p1 = await issuePermit(state, X, "canonical", B, ctx);
	state = p1.state;
	check(p1.outcome === "ISSUED" && p1.permit !== null, `a permit at the fork base must be ISSUED (got ${p1.outcome})`);
	const stalePermit = p1.permit!;
	console.log(`[1] ${short(X)} evaluated and accepted; permit ${short(stalePermit.permit_id)}… bound to head ${short(B)} (the fork base)`);

	// --- [2] concurrent merge moves HEAD to H2 ---------------------------
	const H2 = await fake.adminPush({
		repo: "canonical",
		ref: "main",
		tree: { ...baselineTree, "README.md": "acme api\n\nSee docs/usage.md.\n", "docs/usage.md": "# Usage\n" },
		message: "concurrent merge: docs",
		parents: [B],
	});
	check((await canonical.getHead()) === H2, "the destination must have moved to H2");
	console.log(`[2] concurrent merge: destination HEAD ${short(B)} → ${short(H2)}`);

	// --- [3] the stale permit: MUST expire, NOT consumed ----------------
	const staleRun = await fakePromote(fake, {
		source: FORK,
		destination: "canonical",
		candidate_sha: X,
		expected_head: B,
		winning_tree_sha256: stalePermit.winning_tree_sha256,
	});
	check(
		staleRun.status === 409 && staleRun.body.outcome === "EXPIRED_HEAD_MOVED",
		`the container must refuse the stale permit (got ${staleRun.status} ${staleRun.body.outcome})`,
	);
	const a1 = await attemptPromotion(state, stalePermit.permit_id, H2, treeX, ctx);
	state = a1.state;
	check(a1.outcome === "EXPIRED_HEAD_MOVED", `stale permit must EXPIRE (got ${a1.outcome})`);
	check(a1.effects.length === 0, "expired permit must have NO effects");
	check(state.permits[stalePermit.permit_id].consumed === false, "expired permit must remain UNCONSUMED");
	check((await canonical.getHead()) === H2, "the destination must not move");
	console.log(`[3] stale permit presented at ${short(H2)} → EXPIRED_HEAD_MOVED (container exit ${staleRun.run.exit}), unconsumed, no effects`);

	// --- [4] the SAME SHA at the new head: refused ----------------------
	// Fresh evidence for X and a new ACCEPT do not change what X descends
	// from: B, not H2. This is where the old harness re-promoted X.
	await evaluateAndAccept(X, treeX, "2026-10-01T19:00:00Z");
	const sameSha = await issuePermit(state, X, "canonical", H2, ctx);
	state = sameSha.state;
	check(sameSha.outcome === "REBASE_REQUIRED", `a permit for the same SHA at the moved head must be refused (got ${sameSha.outcome})`);
	const sameShaRun = await fakePromote(fake, {
		source: FORK,
		destination: "canonical",
		candidate_sha: X,
		expected_head: H2,
		winning_tree_sha256: treeX,
	});
	check(
		sameShaRun.status === 409 && sameShaRun.body.outcome === "BASELINE_MISMATCH",
		`promote.sh must refuse the same SHA at the moved head (got ${sameShaRun.status} ${sameShaRun.body.outcome})`,
	);
	console.log(
		`[4] same SHA ${short(X)} re-evaluated at ${short(H2)}: issuePermit → REBASE_REQUIRED; ` +
			`the container would answer ${sameShaRun.body.outcome} (exit ${sameShaRun.run.exit})`,
	);

	// --- [5] rebase → new SHA → fresh evidence → permit → promote --------
	const rebase = await fakeRebase(fake, { fork: FORK, destination: "canonical", candidate_sha: X, onto: H2 });
	check(rebase.status === 200 && rebase.body.outcome === "REBASED", `the rebase must succeed (got ${rebase.status} ${rebase.body.outcome})`);
	const X2 = rebase.body.rebased_sha!;
	check(X2 !== X, "the rebase must produce a NEW SHA");
	check((await fork.getHead()) === X2, "the rebased commit must be on the contender's fork");
	const recorded = await recordRebase(state, { contender_id: CONTENDER, outcome: "REBASED", from_sha: X, onto: H2, new_sha: X2 }, ctx);
	check(recorded.outcome === "RECORDED", `the authority must record the rebase (got ${recorded.outcome})`);
	state = recorded.state;
	// The rebase's push to the fork also arrives through the queue.
	const rebasedPush = await ingestQueueEvent(state, { namespace: "headmove", repo: FORK, ref: "refs/heads/main", before: X, after: X2 }, ctx);
	state = rebasedPush.state;
	check(state.contenders[CONTENDER].latest_commit === X2, "the rebased commit re-enters evaluation");
	check(state.evaluations[X2] === undefined, "the rebased commit has no evidence yet");

	const rebasedTree = fake.readCommitObject(FORK, X2)!.tree;
	const treeX2 = await treeDigestOfFiles(rebasedTree);
	await evaluateAndAccept(X2, treeX2, "2026-10-01T20:00:00Z");
	const p3 = await issuePermit(state, X2, "canonical", H2, ctx);
	state = p3.state;
	check(p3.outcome === "ISSUED" && p3.permit !== null, `a permit for the rebased SHA at H2 must be ISSUED (got ${p3.outcome})`);
	const permit = p3.permit!;
	check(permit.evaluation_bundle_hash === state.evaluations[X2].bundle_hash, "the permit must bind the rebased SHA's evidence");

	const promoted = await fakePromote(fake, {
		source: FORK,
		destination: "canonical",
		candidate_sha: X2,
		expected_head: H2,
		winning_tree_sha256: permit.winning_tree_sha256,
	});
	check(
		promoted.status === 200 && promoted.body.outcome === "PROMOTED",
		`the container must promote the rebased SHA (got ${promoted.status} ${promoted.body.outcome})`,
	);
	const a3 = await attemptPromotion(state, permit.permit_id, promoted.body.base!, treeX2, ctx);
	state = a3.state;
	check(a3.outcome === "PROMOTED", `re-verified promotion must succeed (got ${a3.outcome})`);
	check(state.permits[permit.permit_id].consumed, "the permit must be consumed");
	const head = await canonical.getHead();
	check(head === X2, "the destination must fast-forward to the rebased commit");
	console.log(
		`[5] rebased ${short(X)} onto ${short(H2)} → new SHA ${short(X2)}; fresh evidence; permit ${short(permit.permit_id)}… → PROMOTED ` +
			`(base ${short(promoted.body.base!)}, parent ${short(promoted.body.parent!)})`,
	);

	return {
		state,
		result: {
			baseline: B,
			candidateSha: X,
			movedHead: H2,
			stalePermitId: stalePermit.permit_id,
			expiredOutcome: "EXPIRED_HEAD_MOVED",
			sameShaPermit: "REBASE_REQUIRED",
			sameShaContainer: "BASELINE_MISMATCH",
			rebaseOutcome: "REBASED",
			rebasedSha: X2,
			promotedPermitId: permit.permit_id,
			promotedOutcome: "PROMOTED",
			promotedSha: promoted.body.promoted_sha!,
			promotedBase: promoted.body.base!,
			promotedParent: promoted.body.parent!,
			canonicalHead: head!,
		},
	};
}

// Standalone run: `node src/harness/head-move.ts`.
const isMain = process.argv[1]?.endsWith("head-move.ts") ?? false;
if (isMain) {
	const { SELECTOR_POLICY_INPUT } = await import("../do/TaskAuthority.ts");
	const ctx = defaultCtx(await sha256Hex(SELECTOR_POLICY_INPUT));
	await runHeadMoveScenario(ctx);
	console.log("HEAD-MOVE OK: the same SHA is refused at the moved head; only the rebased SHA was promoted.");
}
