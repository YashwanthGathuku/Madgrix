/**
 * Permit ancestry (specs/amendments/rebase-ancestry-v1.md).
 *
 * container/promote.sh fast-forwards the destination to the reviewed
 * candidate commit, so it refuses (exit 47) any permit whose destination head
 * the candidate does not descend from. The task authority has no git, but it
 * knows two such heads for a candidate: the commit the contender's fork was
 * created at (fork_base, the task's baseline), and any head a rebase replayed
 * the candidate onto (recorded by recordRebase from container/rebase.sh's
 * report). issuePermit refuses every other head with REBASE_REQUIRED, so the
 * same SHA can never be re-promoted after the destination moved: the
 * candidate is rebased, the rebased commit is a new SHA, and that SHA is
 * evaluated again before it can get a permit.
 *
 * node --test test/rebase-ancestry.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { canonicalJson, sha256Hex } from "../src/lib/canonical.ts";
import { assumeCompleteMergeArtifactScan } from "../src/lib/merge-artifacts.ts";
// A namespace import: a missing export is undefined in one test, not a link
// error that hides every other test in this file.
import * as taskState from "../src/lib/task-state.ts";
import type { Ctx } from "../src/lib/task-state.ts";
import { SELECTOR_POLICY_VERSION, type AuthorityState, type EvaluationBundle } from "../src/lib/types.ts";

const ts = taskState as any;

const BASE = "b0".repeat(20);
const X = "a1".repeat(20);
const H2 = "c2".repeat(20);
const X2 = "d3".repeat(20);
const Y = "e4".repeat(20);
const CONTENDER = "contender-1";

function makeCtx(): Ctx {
	let n = 0;
	return {
		now: () => `2026-10-03T12:00:${String(n++ % 60).padStart(2, "0")}.000Z`,
		randomHex: (bytes: number) => "5".repeat(bytes * 2),
		sha256Hex,
		selectorPolicyHash: "policyhash",
		policyVersion: SELECTOR_POLICY_VERSION,
	};
}

async function bundleFor(state: AuthorityState, candidate_sha: string, evaluated_at: string, extra: object = {}): Promise<EvaluationBundle> {
	const rest = {
		candidate_sha,
		tree_sha256: await sha256Hex(`tree of ${candidate_sha}`),
		contender_id: CONTENDER,
		task_hash: state.task.task_hash,
		admission: {
			exact_baseline: true,
			scope_compliance: true,
			valid_tool_states: true,
			no_eval_tampering: true,
			provenance_complete: true,
		},
		hidden_oracle: { passed: true, total: 2, failed: [] as string[] },
		regressions: { passed: true, total: 3, failed: [] as string[] },
		static_analysis: { passed: true, findings: [] as string[] },
		semantic_checks: { passed: true, total: 1, failed: [] as string[] },
		security_policy: { passed: true, findings: [] as string[] },
		evaluated_at,
		tainted: false,
		...extra,
	};
	const scanned = assumeCompleteMergeArtifactScan(rest);
	return { ...scanned, bundle_hash: await sha256Hex(canonicalJson(scanned)) } as EvaluationBundle;
}

/** A task on BASE whose contender forked at BASE and pushed X (observed). */
async function forkedAt(ctx: Ctx): Promise<AuthorityState> {
	const task_hash = await sha256Hex("rebase-ancestry task");
	let state = taskState.createAuthority({
		task_id: "task-ancestry",
		task_hash,
		intent: "fix",
		baseline_repo: "canonical",
		baseline_commit: BASE,
		behavior_contract: "",
		policy_version: SELECTOR_POLICY_VERSION,
		frozen_at: ctx.now(),
	});
	const claim = await taskState.registerClaim(
		state,
		{
			agent: "agent-1",
			task: task_hash,
			baseline: BASE,
			intent: { behavior: ["fix"] },
			scope: { paths: ["src/**"], symbols: [] },
			contracts: { reads: [], modifies: [] },
			interfaces: [],
			schema_changes: [],
			expected_tests: [],
			lease: { claimed_at: ctx.now(), expires_at: "2026-10-04T00:00:00Z" },
		},
		ctx,
	);
	state = claim.state;
	state = (
		await taskState.registerContender(
			state,
			{
				contender_id: CONTENDER,
				agent_id: "agent-1",
				fork_repo: "fork-1",
				fork_lineage: { parent_repo: "canonical", parent_commit: BASE },
				fork_base: BASE,
				token_id: "tok-1",
				token_ids: ["tok-1"],
				status: "forked",
				claim_work_id: claim.claim.work_id,
				latest_commit: BASE,
			} as never,
			ctx,
		)
	).state;
	return observePush(state, BASE, X, ctx);
}

async function observePush(state: AuthorityState, before: string, after: string, ctx: Ctx): Promise<AuthorityState> {
	const r = await taskState.ingestQueueEvent(
		state,
		{ namespace: "ancestry", repo: "fork-1", ref: "refs/heads/main", before, after },
		ctx,
	);
	assert.equal(r.outcome, "APPLIED_NEW");
	return r.state;
}

/** Fresh evidence for `sha` and an ACCEPT verdict naming it. */
async function accepted(state: AuthorityState, sha: string, ctx: Ctx, evaluated_at: string, extra: object = {}): Promise<AuthorityState> {
	const evidence = await taskState.submitEvaluation(
		state,
		await bundleFor(state, sha, evaluated_at, extra),
		{ zone: "evaluation_domain" },
		ctx,
	);
	assert.equal(evidence.outcome, "RECORDED");
	const verdict = await taskState.runVerdictSeam(
		evidence.state,
		[{ contender_id: CONTENDER, candidate_sha: sha, blast_radius: 1, change_surface: 1 }],
		ctx,
	);
	assert.equal(verdict.record.state, "ACCEPT");
	return verdict.state;
}

describe("issuePermit: a permit only at a head the candidate is known to descend from", () => {
	it("a permit at the contender's fork base is ISSUED", async () => {
		const ctx = makeCtx();
		const state = await accepted(await forkedAt(ctx), X, ctx, "2026-10-03T12:10:00Z");
		const r = await taskState.issuePermit(state, X, "canonical", BASE, ctx);
		assert.equal((r as any).outcome, "ISSUED");
		assert.equal(r.permit?.expected_destination_head, BASE);
		assert.equal(r.permit?.winner_candidate_sha, X);
	});

	it("the same SHA after the head moved is REBASE_REQUIRED: no permit is stored, the refusal is ledgered", async () => {
		const ctx = makeCtx();
		let state = await accepted(await forkedAt(ctx), X, ctx, "2026-10-03T12:10:00Z");
		const before = state;
		// The destination moved BASE → H2 (a concurrent merge). X's parent is
		// BASE, so promote.sh would refuse a permit at H2 with exit 47.
		const r = await taskState.issuePermit(state, X, "canonical", H2, ctx);
		assert.equal((r as any).outcome, "REBASE_REQUIRED", "a permit at a head X does not descend from must be refused");
		assert.equal(r.permit, null);
		state = r.state;
		assert.deepEqual(Object.keys(state.permits), Object.keys(before.permits), "no permit is stored");
		assert.equal(state.ledger.length, before.ledger.length + 1, "the refusal is one ledger entry");
		assert.equal(state.ledger.at(-1)?.kind, "permit_refused");
	});

	it("re-evaluating the same SHA (head-move.ts's old step 5) still gets no permit at the moved head", async () => {
		const ctx = makeCtx();
		let state = await accepted(await forkedAt(ctx), X, ctx, "2026-10-03T12:10:00Z");
		const stale = await taskState.issuePermit(state, X, "canonical", BASE, ctx);
		state = stale.state;
		// Head moved to H2: the stale permit expires, unconsumed.
		const expired = await taskState.attemptPromotion(state, stale.permit!.permit_id, H2, state.evaluations[X].tree_sha256, ctx);
		assert.equal(expired.outcome, "EXPIRED_HEAD_MOVED");
		state = expired.state;
		// Fresh evidence for the SAME SHA and a new ACCEPT do not change what X descends from.
		state = await accepted(state, X, ctx, "2026-10-03T12:20:00Z");
		const again = await taskState.issuePermit(state, X, "canonical", H2, ctx);
		assert.equal((again as any).outcome, "REBASE_REQUIRED");
		assert.equal(again.permit, null);
	});

	it("registerContender refuses a fork base other than the task's baseline commit", async () => {
		const ctx = makeCtx();
		const state = await forkedAt(ctx);
		await assert.rejects(
			taskState.registerContender(
				state,
				{
					contender_id: "contender-2",
					agent_id: "agent-1",
					fork_repo: "fork-2",
					fork_lineage: { parent_repo: "canonical", parent_commit: BASE },
					fork_base: H2,
					token_id: "tok-2",
					token_ids: ["tok-2"],
					status: "forked",
					claim_work_id: null,
					latest_commit: H2,
				} as never,
				ctx,
			),
			/fork_base/,
		);
	});
});

describe("recordRebase: container/rebase.sh's report", () => {
	it("REBASED: the new SHA becomes the contender's candidate and gets a permit at onto after fresh evidence", async () => {
		const ctx = makeCtx();
		let state = await accepted(await forkedAt(ctx), X, ctx, "2026-10-03T12:10:00Z");
		const r = await ts.recordRebase(
			state,
			{ contender_id: CONTENDER, outcome: "REBASED", from_sha: X, onto: H2, new_sha: X2 },
			ctx,
		);
		assert.equal(r.outcome, "RECORDED");
		state = r.state;
		const contender = state.contenders[CONTENDER] as any;
		assert.equal(contender.latest_commit, X2, "the rebased commit re-enters evaluation");
		assert.deepEqual(
			contender.rebases.map((x: any) => [x.outcome, x.from_sha, x.onto, x.new_sha]),
			[["REBASED", X, H2, X2]],
		);
		assert.equal(state.ledger.at(-1)?.kind, "rebase_recorded");
		// The old evidence was for X; X2 has none until it is evaluated.
		await assert.rejects(
			taskState.runVerdictSeam(state, [{ contender_id: CONTENDER, candidate_sha: X2, blast_radius: 1, change_surface: 1 }], ctx),
			/no stored evaluation/,
		);
		state = await accepted(state, X2, ctx, "2026-10-03T12:30:00Z");
		const permit = await taskState.issuePermit(state, X2, "canonical", H2, ctx);
		assert.equal((permit as any).outcome, "ISSUED");
		assert.equal(permit.permit?.winner_candidate_sha, X2);
		assert.equal(permit.permit?.expected_destination_head, H2);
		assert.deepEqual(ts.permitBases(state.contenders[CONTENDER], X2), [BASE, H2]);
		assert.deepEqual(ts.permitBases(state.contenders[CONTENDER], X), [BASE], "X itself still descends only from the fork base");
	});

	it("REBASED never moves latest_commit back over a newer observed push", async () => {
		const ctx = makeCtx();
		let state = await forkedAt(ctx);
		// The contender pushed Y on top of the rebased commit, and that push
		// was observed before the rebase report arrived.
		state = await observePush(state, X, X2, ctx);
		state = await observePush(state, X2, Y, ctx);
		const r = await ts.recordRebase(state, { contender_id: CONTENDER, outcome: "REBASED", from_sha: X, onto: H2, new_sha: X2 }, ctx);
		assert.equal(r.outcome, "RECORDED");
		assert.equal(r.state.contenders[CONTENDER].latest_commit, Y);
		assert.deepEqual(ts.permitBases(r.state.contenders[CONTENDER], X2), [BASE, H2]);
	});

	it("UP_TO_DATE records onto as an ancestor of the same SHA", async () => {
		const ctx = makeCtx();
		let state = await forkedAt(ctx);
		state = await observePush(state, X, Y, ctx);
		const r = await ts.recordRebase(state, { contender_id: CONTENDER, outcome: "UP_TO_DATE", from_sha: Y, onto: H2 }, ctx);
		assert.equal(r.outcome, "RECORDED");
		state = await accepted(r.state, Y, ctx, "2026-10-03T12:40:00Z");
		const permit = await taskState.issuePermit(state, Y, "canonical", H2, ctx);
		assert.equal((permit as any).outcome, "ISSUED");
		assert.equal(state.contenders[CONTENDER].latest_commit, Y);
	});

	it("CONFLICT escalates the task with the paths as data; permits are blocked", async () => {
		const ctx = makeCtx();
		let state = await accepted(await forkedAt(ctx), X, ctx, "2026-10-03T12:10:00Z");
		const paths = ["README.md", "weird\nname.txt", "src/ü.js"];
		const r = await ts.recordRebase(state, { contender_id: CONTENDER, outcome: "CONFLICT", from_sha: X, onto: H2, paths }, ctx);
		assert.equal(r.outcome, "ESCALATED");
		state = r.state;
		assert.equal(state.task_status, "escalated");
		const escalation = state.escalations.at(-1) as any;
		assert.equal(escalation.resolved, false);
		assert.deepEqual(escalation.data, {
			kind: "rebase_conflict",
			contender_id: CONTENDER,
			candidate_sha: X,
			onto: H2,
			paths,
			paths_total: 3,
		});
		for (const p of paths) assert.ok(!escalation.reason.includes(p), "paths are data, never part of the reason text");
		assert.equal(state.ledger.at(-1)?.kind, "escalated");
		await assert.rejects(taskState.issuePermit(state, X, "canonical", BASE, ctx), /escalated/);
	});

	it("a retried report is ACK_DUP: no state change", async () => {
		const ctx = makeCtx();
		const state = await forkedAt(ctx);
		const report = { contender_id: CONTENDER, outcome: "REBASED", from_sha: X, onto: H2, new_sha: X2 };
		const first = await ts.recordRebase(state, report, ctx);
		const second = await ts.recordRebase(first.state, report, ctx);
		assert.equal(second.outcome, "ACK_DUP");
		assert.equal(second.state, first.state);
	});

	it("malformed or unauthorized reports are refused", async () => {
		const ctx = makeCtx();
		const state = await forkedAt(ctx);
		await assert.rejects(ts.recordRebase(state, { contender_id: "nobody", outcome: "UP_TO_DATE", from_sha: X, onto: H2 }, ctx), /unknown contender/);
		await assert.rejects(ts.recordRebase(state, { contender_id: CONTENDER, outcome: "REBASED", from_sha: X, onto: H2 }, ctx), /new_sha/);
		await assert.rejects(ts.recordRebase(state, { contender_id: CONTENDER, outcome: "REBASED", from_sha: X, onto: H2, new_sha: X }, ctx), /new_sha/);
		await assert.rejects(ts.recordRebase(state, { contender_id: CONTENDER, outcome: "CONFLICT", from_sha: X, onto: H2, paths: [] }, ctx), /paths/);
		await assert.rejects(ts.recordRebase(state, { contender_id: CONTENDER, outcome: "MERGED", from_sha: X, onto: H2 }, ctx), /outcome/);
		const quarantined = await taskState.quarantineContender(state, CONTENDER, "forged_evidence", "e".repeat(64), ctx);
		await assert.rejects(
			ts.recordRebase(quarantined.state, { contender_id: CONTENDER, outcome: "UP_TO_DATE", from_sha: X, onto: H2 }, ctx),
			/quarantined/,
		);
	});
});

describe("evaluation base: the commit the evaluator compares a candidate with", () => {
	it("evaluationBases lists the fork base, then every recorded onto", async () => {
		const ctx = makeCtx();
		let state = await forkedAt(ctx);
		assert.deepEqual(ts.evaluationBases(state.contenders[CONTENDER]), [BASE]);
		state = (await ts.recordRebase(state, { contender_id: CONTENDER, outcome: "REBASED", from_sha: X, onto: H2, new_sha: X2 }, ctx)).state;
		assert.deepEqual(ts.evaluationBases(state.contenders[CONTENDER]), [BASE, H2]);
	});

	it("evidence naming an evaluation base the authority does not know is rejected", async () => {
		const ctx = makeCtx();
		let state = await forkedAt(ctx);
		state = (await ts.recordRebase(state, { contender_id: CONTENDER, outcome: "REBASED", from_sha: X, onto: H2, new_sha: X2 }, ctx)).state;
		await assert.rejects(
			taskState.submitEvaluation(state, await bundleFor(state, X2, "2026-10-03T12:50:00Z", { evaluation_base: Y }), { zone: "evaluation_domain" }, ctx),
			/evaluation_base/,
		);
		const ok = await taskState.submitEvaluation(
			state,
			await bundleFor(state, X2, "2026-10-03T12:50:00Z", { evaluation_base: H2 }),
			{ zone: "evaluation_domain" },
			ctx,
		);
		assert.equal(ok.outcome, "RECORDED");
	});
});
