/**
 * Terminal no-write reservation abort
 * (specs/amendments/promotion-terminal-abort-v1.md).
 *
 * node --test test/promotion-terminal-abort.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, sha256Hex } from "../src/lib/canonical.ts";
import { assumeCompleteMergeArtifactScan } from "../src/lib/merge-artifacts.ts";
import {
	abortReservedPromotion,
	beginPromotion,
	createAuthority,
	finalizeReservedPromotion,
	issuePermit,
	runVerdictSeam,
	submitEvaluation,
	type Ctx,
} from "../src/lib/task-state.ts";
import { SELECTOR_POLICY_VERSION, type AuthorityState, type EvaluationBundle } from "../src/lib/types.ts";
import { assertWorkerHeadMoveRecovery } from "../src/harness/worker-head-move.ts";
import { authorityState, issuedPermit, worker, type Harness } from "./helpers/worker-harness.ts";

const BASELINE = "base123";

function makeCtx(): Ctx {
	let nonce = 0;
	return {
		now: () => "2026-10-13T12:00:00.000Z",
		randomHex: (n: number) => {
			nonce += 1;
			return nonce.toString(16).padStart(n * 2, "0");
		},
		sha256Hex,
		selectorPolicyHash: "policyhash",
		policyVersion: SELECTOR_POLICY_VERSION,
	};
}

function observed(sha: string): AuthorityState {
	const state = createAuthority({
		task_id: "task-1",
		task_hash: "taskhash-abc",
		intent: "promote one candidate",
		baseline_repo: "acme/api",
		baseline_commit: BASELINE,
		behavior_contract: "the check holds",
		policy_version: SELECTOR_POLICY_VERSION,
		frozen_at: "2026-10-13T11:00:00Z",
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

async function bundle(sha: string, tree: string): Promise<EvaluationBundle> {
	const rest = {
		candidate_sha: sha,
		tree_sha256: tree,
		contender_id: "contender-1",
		task_hash: "taskhash-abc",
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
		evaluated_at: "2026-10-13T12:00:00Z",
		tainted: false,
	};
	const scanned = assumeCompleteMergeArtifactScan(rest);
	return { ...(scanned as EvaluationBundle), bundle_hash: await sha256Hex(canonicalJson(scanned)) };
}

async function acceptOn(ctx: Ctx, state: AuthorityState, sha: string, tree: string): Promise<AuthorityState> {
	const tipped: AuthorityState = {
		...state,
		contenders: {
			...state.contenders,
			"contender-1": { ...state.contenders["contender-1"], latest_commit: sha },
		},
	};
	const submitted = await submitEvaluation(tipped, await bundle(sha, tree), { zone: "evaluation_domain" }, ctx);
	const seam = await runVerdictSeam(
		submitted.state,
		[{ contender_id: "contender-1", candidate_sha: sha, blast_radius: 1, change_surface: 1 }],
		ctx,
	);
	assert.equal(seam.record.state, "ACCEPT");
	assert.equal(seam.record.winner_sha, sha);
	return seam.state;
}

async function reserved(ctx: Ctx, sha = "sha-x", tree = "tree-x") {
	const accepted = await acceptOn(ctx, observed(sha), sha, tree);
	const issued = await issuePermit(accepted, sha, "acme/api", BASELINE, ctx);
	assert.equal(issued.outcome, "ISSUED");
	assert.ok(issued.permit);
	const begun = await beginPromotion(issued.state, issued.permit.permit_id, BASELINE, tree, ctx);
	assert.equal(begun.outcome, "RESERVED");
	assert.ok(begun.reservation);
	return { state: begun.state, permit: issued.permit, reservation: begun.reservation };
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

async function canonicalHead(h: Harness): Promise<string | null> {
	return (await h.fake.get("canonical")).getHead();
}

describe("terminal no-write reservation abort", () => {
	it("the Worker head-move path aborts the stale reservation and promotes the rebase", async () => {
		await assertWorkerHeadMoveRecovery();
	});

	it("retrying an aborted permit returns the stored outcome and does not reserve again", async () => {
		const ctx = makeCtx();
		const first = await reserved(ctx);
		const aborted = await abortReservedPromotion(
			first.state,
			first.permit.permit_id,
			first.reservation.promotion_nonce,
			"EXPIRED_HEAD_MOVED",
			ctx,
		);
		assert.equal(aborted.outcome, "ABORTED");
		const again = await beginPromotion(aborted.state, first.permit.permit_id, BASELINE, "tree-x", ctx);
		assert.equal(again.outcome, "EXPIRED_HEAD_MOVED");
		assert.equal(again.reservation, undefined);
		assert.equal(again.state.promotion_reservations?.[first.permit.permit_id]?.status, "ABORTED");
		assert.equal(again.state.permits[first.permit.permit_id].consumed, false);
		assert.equal(again.state.ledger.filter((entry) => entry.kind === "promotion_reserved").length, 1);
		assert.equal(again.state.ledger.filter((entry) => entry.kind === "promotion_succeeded").length, 0);
	});

	it("a wrong nonce leaves the reservation IN_FLIGHT", async () => {
		const ctx = makeCtx();
		const first = await reserved(ctx);
		const before = JSON.stringify(first.state.promotion_reservations);
		const aborted = await abortReservedPromotion(first.state, first.permit.permit_id, "f".repeat(64), "EXPIRED_HEAD_MOVED", ctx);
		assert.equal(aborted.outcome, "RESERVATION_MISMATCH");
		assert.equal(JSON.stringify(aborted.state.promotion_reservations), before);
		assert.equal(aborted.state.promotion_reservations?.[first.permit.permit_id]?.status, "IN_FLIGHT");
		assert.equal(aborted.state.ledger.filter((entry) => entry.kind === "promotion_reservation_aborted").length, 0);
	});

	it("aborting a finalized reservation does not reopen it", async () => {
		const ctx = makeCtx();
		const first = await reserved(ctx);
		const finalized = await finalizeReservedPromotion(
			first.state,
			first.permit.permit_id,
			{
				promoted_sha: first.reservation.candidate_sha,
				tree_sha256: first.reservation.tree_sha256,
				verified_base: first.reservation.expected_destination_head,
				promotion_nonce: first.reservation.promotion_nonce,
			},
			ctx,
		);
		assert.equal(finalized.outcome, "PROMOTED");
		const aborted = await abortReservedPromotion(
			finalized.state,
			first.permit.permit_id,
			first.reservation.promotion_nonce,
			"EXPIRED_HEAD_MOVED",
			ctx,
		);
		assert.equal(aborted.outcome, "ALREADY_CONSUMED");
		assert.equal(aborted.state, finalized.state);
		assert.equal(aborted.state.promotion_reservations?.[first.permit.permit_id]?.status, "FINALIZED");
		assert.equal(aborted.state.permits[first.permit.permit_id].consumed, true);
		assert.equal(aborted.state.ledger.filter((entry) => entry.kind === "promotion_reservation_aborted").length, 0);
	});

	it("the same abort delivered twice is one ledger entry", async () => {
		const ctx = makeCtx();
		const first = await reserved(ctx);
		const once = await abortReservedPromotion(
			first.state,
			first.permit.permit_id,
			first.reservation.promotion_nonce,
			"TREE_MISMATCH",
			ctx,
		);
		assert.equal(once.outcome, "ABORTED");
		const twice = await abortReservedPromotion(
			once.state,
			first.permit.permit_id,
			first.reservation.promotion_nonce,
			"TREE_MISMATCH",
			ctx,
		);
		assert.equal(twice.outcome, "ALREADY_ABORTED");
		assert.equal(twice.state, once.state);
		assert.equal(twice.state.ledger.filter((entry) => entry.kind === "promotion_reservation_aborted").length, 1);
		assert.equal(twice.state.permits[first.permit.permit_id].consumed, false);
	});

	it("PUSH_REJECTED is not abortable", async () => {
		const ctx = makeCtx();
		const first = await reserved(ctx);
		const aborted = await abortReservedPromotion(
			first.state,
			first.permit.permit_id,
			first.reservation.promotion_nonce,
			"PUSH_REJECTED",
			ctx,
		);
		assert.equal(aborted.outcome, "NOT_ABORTABLE");
		assert.equal(aborted.state, first.state);
		assert.equal(aborted.state.promotion_reservations?.[first.permit.permit_id]?.status, "IN_FLIGHT");
	});

	it("an ABORTED reservation does not block a fresh permit", async () => {
		const ctx = makeCtx();
		const first = await reserved(ctx, "sha-x", "tree-x");
		const aborted = await abortReservedPromotion(
			first.state,
			first.permit.permit_id,
			first.reservation.promotion_nonce,
			"BASELINE_MISMATCH",
			ctx,
		);
		assert.equal(aborted.outcome, "ABORTED");
		const next = await acceptOn(ctx, aborted.state, "sha-y", "tree-y");
		const issued = await issuePermit(next, "sha-y", "acme/api", BASELINE, ctx);
		assert.equal(issued.outcome, "ISSUED");
		assert.ok(issued.permit);
		const begun = await beginPromotion(issued.state, issued.permit.permit_id, BASELINE, "tree-y", ctx);
		assert.equal(begun.outcome, "RESERVED");
		assert.notEqual(begun.outcome, "PROMOTION_IN_FLIGHT");
		assert.equal(begun.state.promotion_reservations?.[issued.permit.permit_id]?.status, "IN_FLIGHT");
		assert.equal(begun.state.promotion_reservations?.[first.permit.permit_id]?.status, "ABORTED");
	});

	it("a container 503 leaves the reservation IN_FLIGHT", async () => {
		const { h, permit } = await issuedPermit();
		const head = await canonicalHead(h);
		h.containerAnswer = async () => json({ error: "container_not_running" }, 503);
		const answer = await worker.runPromotion(h.env as never, h.taskId, permit.permit_id);
		assert.equal(answer.status, 503, JSON.stringify(answer.body));
		const state = await authorityState(h);
		assert.equal(state.promotion_reservations?.[permit.permit_id]?.status, "IN_FLIGHT");
		assert.equal(state.permits[permit.permit_id].consumed, false);
		assert.equal(state.ledger.filter((entry) => entry.kind === "promotion_reservation_aborted").length, 0);
		assert.equal(await canonicalHead(h), head);
	});

	it("a lost finalize stays IN_FLIGHT and the retry finalizes the same write", async () => {
		const { h, X, permit } = await issuedPermit();
		const real = h.env.TASK_AUTHORITY;
		let finalizeFailures = 1;
		h.env.TASK_AUTHORITY = {
			idFromName: (name: string) => real.idFromName(name),
			get(id: { toString(): string }) {
				const stub = real.get(id);
				return {
					fetch: async (request: Request) => {
						if (new URL(request.url).pathname === "/promotion/finalize" && finalizeFailures-- > 0) {
							return json({ error: "finalize_transport" }, 503);
						}
						return stub.fetch(request);
					},
				};
			},
		};
		const first = await worker.runPromotion(h.env as never, h.taskId, permit.permit_id);
		assert.equal(first.status, 503, JSON.stringify(first.body));
		assert.equal(first.body.error, "promotion_written_but_finalize_pending");
		const mid = await authorityState(h);
		assert.equal(mid.promotion_reservations?.[permit.permit_id]?.status, "IN_FLIGHT");
		assert.equal(mid.permits[permit.permit_id].consumed, false);
		const nonce = mid.promotion_reservations?.[permit.permit_id]?.promotion_nonce;
		const second = await worker.runPromotion(h.env as never, h.taskId, permit.permit_id);
		assert.equal(second.status, 200, JSON.stringify(second.body));
		assert.equal(second.body.outcome, "PROMOTED");
		assert.equal(second.body.reconciled_existing_write, true);
		assert.equal(await canonicalHead(h), X);
		const state = await authorityState(h);
		assert.equal(state.promotion_reservations?.[permit.permit_id]?.status, "FINALIZED");
		assert.equal(state.promotion_reservations?.[permit.permit_id]?.promotion_nonce, nonce);
		assert.equal(state.permits[permit.permit_id].consumed, true);
		assert.equal(state.ledger.filter((entry) => entry.kind === "promotion_succeeded").length, 1);
		assert.equal(state.ledger.filter((entry) => entry.kind === "promotion_reservation_aborted").length, 0);
	});

	it("a failed abort RPC stays IN_FLIGHT and the retry records the abort", async () => {
		const { h, permit } = await issuedPermit();
		const { moveDestination, BASELINE_TREE } = await import("./helpers/worker-harness.ts");
		const H2 = await moveDestination(h, { ...BASELINE_TREE, "README.md": "moved during abort outage\n" });
		const real = h.env.TASK_AUTHORITY;
		let abortFailures = 1;
		h.env.TASK_AUTHORITY = {
			idFromName: (name: string) => real.idFromName(name),
			get(id: { toString(): string }) {
				const stub = real.get(id);
				return {
					fetch: async (request: Request) => {
						if (new URL(request.url).pathname === "/promotion/abort" && abortFailures-- > 0) {
							return json({ error: "abort_transport" }, 503);
						}
						return stub.fetch(request);
					},
				};
			},
		};
		const first = await worker.runPromotion(h.env as never, h.taskId, permit.permit_id);
		assert.equal(first.status, 503, JSON.stringify(first.body));
		assert.equal(first.body.error, "promotion_abort_pending");
		const mid = await authorityState(h);
		assert.equal(mid.promotion_reservations?.[permit.permit_id]?.status, "IN_FLIGHT");
		assert.equal(mid.permits[permit.permit_id].consumed, false);
		assert.equal(await canonicalHead(h), H2);
		const second = await worker.runPromotion(h.env as never, h.taskId, permit.permit_id);
		assert.equal(second.status, 409, JSON.stringify(second.body));
		assert.equal(second.body.outcome, "EXPIRED_HEAD_MOVED");
		const state = await authorityState(h);
		assert.equal(state.promotion_reservations?.[permit.permit_id]?.status, "ABORTED");
		assert.equal(state.promotion_reservations?.[permit.permit_id]?.abort_reason, "EXPIRED_HEAD_MOVED");
		assert.equal(state.permits[permit.permit_id].consumed, false);
		assert.equal(await canonicalHead(h), H2);
	});

	it("PUSH_REJECTED from the container leaves the reservation IN_FLIGHT", async () => {
		const { h, permit } = await issuedPermit();
		const head = await canonicalHead(h);
		h.containerAnswer = async () => json({ outcome: "PUSH_REJECTED", detail: "the destination refused the fast-forward" }, 409);
		const answer = await worker.runPromotion(h.env as never, h.taskId, permit.permit_id);
		assert.equal(answer.status, 409, JSON.stringify(answer.body));
		assert.equal(answer.body.outcome, "PUSH_REJECTED");
		const state = await authorityState(h);
		assert.equal(state.promotion_reservations?.[permit.permit_id]?.status, "IN_FLIGHT");
		assert.equal(state.permits[permit.permit_id].consumed, false);
		assert.equal(state.ledger.filter((entry) => entry.kind === "promotion_reservation_aborted").length, 0);
		assert.equal(await canonicalHead(h), head);
	});
});
