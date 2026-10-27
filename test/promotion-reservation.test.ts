/**
 * Promotion reservation race (specs/amendments/promotion-reservation-v1.md).
 * The barrier pauses runPromotion after beginPromotion and before any
 * Artifacts token or container call.
 *
 * node --test test/promotion-reservation.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { authorityRefusal } from "../src/lib/authority-refusal.ts";
import {
	FIXED_TREE,
	TOKENS,
	authorityState,
	evidence,
	issuedPermit,
	push,
	worker,
	type Harness,
} from "./helpers/worker-harness.ts";

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

async function canonicalHead(h: Harness): Promise<string | null> {
	return (await h.fake.get("canonical")).getHead();
}

function spyGets(h: Harness): { count: number } {
	const box = { count: 0 };
	const original = h.fake.get.bind(h.fake);
	h.fake.get = async (name: string) => {
		box.count += 1;
		return original(name);
	};
	return box;
}

/** A new tip with changed evaluation files. That is the mechanical quarantine path. */
async function quarantineByTamper(h: Harness, parent: string): Promise<void> {
	const sha = await push(h, { ...FIXED_TREE, "src/tamper.js": "tamper\n" }, parent);
	await evidence(h, sha, "2026-10-03T09:30:00Z", {
		admission: {
			exact_baseline: true,
			scope_compliance: true,
			valid_tool_states: true,
			no_eval_tampering: false,
			provenance_complete: true,
		},
		eval_file_changes: ["eval/hidden.test.js"],
	});
	const state = await authorityState(h);
	assert.equal(state.quarantine[h.contenderId]?.status, "QUARANTINED");
}

describe("P0-C runPromotion reservation", () => {
	it("quarantine before the reservation performs no Artifacts call and no container call", async () => {
		const { h, X, permit } = await issuedPermit();
		await quarantineByTamper(h, X);
		const gets = spyGets(h);
		const answer = await worker.runPromotion(h.env as never, h.taskId, permit.permit_id);
		assert.equal(answer.status, 409);
		assert.equal(answer.body.outcome, "QUARANTINED_CANDIDATE");
		assert.equal(gets.count, 0);
		assert.equal(h.containerCalls.length, 0);
		const state = await authorityState(h);
		assert.equal(state.permits[permit.permit_id].consumed, false);
		assert.equal(state.promotion_reservations?.[permit.permit_id], undefined);
		assert.equal(await canonicalHead(h), h.baseline);
	});

	it("quarantine after the reservation still finalizes that reserved write", async () => {
		const { h, X, permit } = await issuedPermit();
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let reached = false;
		(h.env as { PROMOTION_BARRIER?: () => Promise<void> }).PROMOTION_BARRIER = async () => {
			reached = true;
			await gate;
		};
		const pending = worker.runPromotion(h.env as never, h.taskId, permit.permit_id).then(
			(value) => ({ ok: true as const, value }),
			(error: unknown) => ({ ok: false as const, error }),
		);
		const start = Date.now();
		while (!reached) {
			if (Date.now() - start > 5000) {
				release();
				const early = await pending;
				throw new Error(`reservation barrier was not reached: ${JSON.stringify(early)}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		assert.equal(h.containerCalls.length, 0, "the container has not run at the reservation");
		const reserved = await authorityState(h);
		assert.equal(reserved.promotion_reservations?.[permit.permit_id]?.status, "IN_FLIGHT");
		assert.equal(reserved.permits[permit.permit_id].consumed, false);
		await quarantineByTamper(h, X);
		release();
		const answer = await pending;
		assert.equal(answer.ok, true, JSON.stringify(answer));
		if (!answer.ok) return;
		assert.equal(answer.value.status, 200, JSON.stringify(answer.value.body));
		assert.equal(answer.value.body.outcome, "PROMOTED");
		assert.notEqual(answer.value.body.error, "promotion_written_but_finalize_pending");
		assert.equal(h.containerCalls.length, 1);
		assert.equal(h.containerCalls[0].candidate_sha, X);
		assert.equal(h.containerCalls[0].promotion_nonce, reserved.promotion_reservations?.[permit.permit_id]?.promotion_nonce);
		const state = await authorityState(h);
		assert.equal(state.permits[permit.permit_id].consumed, true);
		assert.equal(state.promotion_reservations?.[permit.permit_id]?.status, "FINALIZED");
		assert.equal(state.quarantine[h.contenderId]?.status, "QUARANTINED");
		assert.ok(state.ledger.some((entry) => entry.kind === "contender_quarantined"));
		assert.ok(state.ledger.some((entry) => entry.kind === "promotion_succeeded"));
		assert.equal(authorityRefusal(state, h.contenderId, "future-sha"), "QUARANTINED_CANDIDATE");
		assert.equal(await canonicalHead(h), X);
	});

	it("a lost finalize retries the same reservation and does not write twice", async () => {
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
		assert.equal(await canonicalHead(h), X);
		const mid = await authorityState(h);
		assert.equal(mid.permits[permit.permit_id].consumed, false);
		assert.equal(mid.promotion_reservations?.[permit.permit_id]?.status, "IN_FLIGHT");
		const nonce = mid.promotion_reservations?.[permit.permit_id]?.promotion_nonce;
		const second = await worker.runPromotion(h.env as never, h.taskId, permit.permit_id);
		assert.equal(second.status, 200, JSON.stringify(second.body));
		assert.equal(second.body.outcome, "PROMOTED");
		assert.equal(second.body.reconciled_existing_write, true);
		assert.equal(h.containerCalls.length, 2);
		assert.equal(h.containerCalls[0].promotion_nonce, nonce);
		assert.equal(h.containerCalls[1].promotion_nonce, nonce);
		assert.equal(h.containerCalls[1].candidate_sha, X);
		assert.equal(await canonicalHead(h), X);
		const state = await authorityState(h);
		assert.equal(state.permits[permit.permit_id].consumed, true);
		assert.equal(state.promotion_reservations?.[permit.permit_id]?.status, "FINALIZED");
		assert.equal(state.promotion_reservations?.[permit.permit_id]?.promotion_nonce, nonce);
		assert.equal(state.ledger.filter((entry) => entry.kind === "promotion_succeeded").length, 1);
		assert.equal(state.ledger.filter((entry) => entry.kind === "promotion_reserved").length, 1);
	});
});
