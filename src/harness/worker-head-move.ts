/**
 * Worker runPromotion after a destination head move.
 * The library head-move harness expires the stale permit before a reservation
 * is stored. This path stores the reservation, then the container returns
 * EXPIRED_HEAD_MOVED. The reservation must become ABORTED, and a rebased
 * permit must still promote.
 */
import assert from "node:assert/strict";
import { canonicalJson, sha256Hex } from "../lib/canonical.ts";
import {
	BASELINE_TREE,
	TOKENS,
	authorityState,
	call,
	evidence,
	issuedPermit,
	moveDestination,
	verdict,
	worker,
	type Harness,
} from "../../test/helpers/worker-harness.ts";

async function canonicalHead(h: Harness): Promise<string | null> {
	return (await h.fake.get("canonical")).getHead();
}

/** The independent audit's Worker head-move. Throws when recovery is wedged. */
export async function assertWorkerHeadMoveRecovery(): Promise<void> {
	const { h, X, permit } = await issuedPermit();
	const H2 = await moveDestination(h, { ...BASELINE_TREE, "README.md": "moved by recovery\n" });
	const stale = await worker.runPromotion(h.env as never, h.taskId, permit.permit_id);
	assert.equal(stale.status, 409, JSON.stringify(stale.body));
	assert.equal(stale.body.outcome, "EXPIRED_HEAD_MOVED");
	const headAfterStale = await canonicalHead(h);
	assert.equal(headAfterStale, H2);
	assert.notEqual(headAfterStale, X);
	const afterStale = await authorityState(h);
	assert.equal(afterStale.permits[permit.permit_id].consumed, false);
	const reservation = afterStale.promotion_reservations?.[permit.permit_id];
	assert.equal(reservation?.status, "ABORTED");
	assert.equal(reservation?.abort_reason, "EXPIRED_HEAD_MOVED");
	const abortEntries = afterStale.ledger.filter((entry) => entry.kind === "promotion_reservation_aborted");
	assert.equal(abortEntries.length, 1);
	assert.equal(
		abortEntries[0].payload_hash,
		await sha256Hex(
			canonicalJson({
				permit_id: permit.permit_id,
				candidate_sha: X,
				promotion_nonce: reservation?.promotion_nonce,
				terminal_outcome: "EXPIRED_HEAD_MOVED",
			}),
		),
	);

	const callsAfterStale = h.containerCalls.length;
	const retry = await worker.runPromotion(h.env as never, h.taskId, permit.permit_id);
	assert.equal(retry.status, 409, JSON.stringify(retry.body));
	assert.equal(retry.body.outcome, "EXPIRED_HEAD_MOVED");
	assert.equal(h.containerCalls.length, callsAfterStale, "retrying the aborted permit must not call the container");
	const afterRetry = await authorityState(h);
	assert.equal(afterRetry.promotion_reservations?.[permit.permit_id]?.status, "ABORTED");
	assert.equal(afterRetry.promotion_reservations?.[permit.permit_id]?.promotion_nonce, reservation?.promotion_nonce);
	assert.equal(afterRetry.ledger.filter((entry) => entry.kind === "promotion_reservation_aborted").length, 1);
	assert.equal(afterRetry.permits[permit.permit_id].consumed, false);

	const rebased = await call(h, "POST", `/tasks/${h.taskId}/rebase`, {
		token: TOKENS.control,
		body: { contender_id: h.contenderId, destination_repo: "canonical" },
	});
	assert.equal(rebased.status, 200, JSON.stringify(rebased.body));
	const Y = rebased.body.rebased_sha as string;
	assert.equal(typeof Y, "string");
	assert.notEqual(Y, X);
	await evidence(h, Y, "2026-10-13T13:00:00Z");
	const issued = await verdict(h, Y);
	assert.equal(issued.status, 200, JSON.stringify(issued.body));
	assert.equal(issued.body.outcome, "ISSUED");
	const secondId = issued.body.permit.permit_id as string;
	const recovered = await worker.runPromotion(h.env as never, h.taskId, secondId);
	assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
	assert.equal(recovered.body.outcome, "PROMOTED");
	assert.equal(await canonicalHead(h), Y);
	const done = await authorityState(h);
	assert.equal(done.permits[secondId].consumed, true);
	assert.equal(done.promotion_reservations?.[secondId]?.status, "FINALIZED");
	assert.equal(done.permits[permit.permit_id].consumed, false);
	assert.equal(done.promotion_reservations?.[permit.permit_id]?.status, "ABORTED");
}
