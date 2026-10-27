# Spec amendment: promotion-terminal-abort-v1 — a proven no-write ends the reservation

**Status:** proposed · **Date:** 2026-10-13
**Affects:** `PROMOTION_PROTOCOL.md` (FROZEN) §11 and `specs/amendments/promotion-reservation-v1.md`, by this amendment file only. The frozen specs are not edited.

## (1) The invariant

The reservation is the linearization point. A canonical write that was authorized stays reconcilable. A promotion that is proven not to have updated the destination ref must not hold the task's only `IN_FLIGHT` slot.

## (2) The conflict this closes

`beginPromotion` stores `IN_FLIGHT` before the container runs. `container/promote.sh` can then exit 42 `EXPIRED_HEAD_MOVED` before `git push`. The Worker returned that 409 and left the reservation `IN_FLIGHT`. `beginPromotion` refuses every other permit while any reservation is `IN_FLIGHT`, so a rebased, re-evaluated candidate could not promote. The stale SHA was not written. Recovery was stuck.

## (3) The transition

`abortReservedPromotion(permit_id, promotion_nonce, terminal_outcome)` runs inside the task authority. It requires the permit, the reservation for that permit, matching permit bindings, an exact nonce, and status `IN_FLIGHT`. `terminal_outcome` must be one of:

- `EXPIRED_HEAD_MOVED` (exit 42, before the push)
- `TREE_MISMATCH` (exit 43, before the push)
- `UNSUPPORTED_TREE_ENTRY` (exit 46, before the push)
- `BASELINE_MISMATCH` (exit 47, before the push)
- `UNRESOLVED_CONFLICT` (exit 48, before the push, including before `ALREADY_WRITTEN`)

Each of those exits is above the `git push` in `container/promote.sh`. The permit stays unconsumed. The reservation stays in the record with status `ABORTED` and `abort_reason` set to that outcome. One `promotion_reservation_aborted` ledger entry records `permit_id`, `candidate_sha`, `promotion_nonce`, and `terminal_outcome`. There is no `canonical_write` effect. The reservation is not deleted.

The same abort delivered again (same permit, same nonce, same outcome) does not append a second ledger entry.

`beginPromotion` for that permit does not create another reservation. It returns the stored terminal outcome. An `ABORTED` reservation does not count as `PROMOTION_IN_FLIGHT`. Only `status === "IN_FLIGHT"` blocks another permit.

`runPromotion` calls this transition when the container returns HTTP 409 with one of those outcomes, and only then returns 409. If the abort RPC fails, `runPromotion` returns 503. The reservation may stay `IN_FLIGHT` until the transition lands. The Workflow retries that 503.

## (4) What stays IN_FLIGHT

These may have written canonical state, or the implementation does not prove they did not:

- `PUSH_REJECTED` (exit 44). `promote.sh` maps every non-zero `git push` to this outcome. A connection drop after the remote accepted the ref update is not distinguishable from a rejected update.
- HTTP 502, including exit 45 (fetched SHA is not the candidate) and a container result whose promoted SHA, tree, or base is not the reservation.
- HTTP 503, a network exception, and a container timeout.
- A successful canonical write whose finalize response was lost. Retry reuses the same reservation, the container reports `ALREADY_WRITTEN` when the candidate is already on the destination, and finalize consumes the permit once.

## (5) What this amendment does not say

It does not let an aborted permit promote. It does not delete the quarantine record. It does not undo a push. It does not claim this transition was observed on Cloudflare.
