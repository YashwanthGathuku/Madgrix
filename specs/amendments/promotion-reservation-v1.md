# Spec amendment: promotion-reservation-v1 — the reservation linearizes the write

**Status:** proposed · **Date:** 2026-10-13
**Affects:** `PROMOTION_PROTOCOL.md` (FROZEN) §11 and `CLOUDFLARE_RUNTIME_MODEL.md` (FROZEN) §5, by this amendment file only. The frozen specs are not edited.

## (1) The invariant

`PROMOTION_PROTOCOL.md` §11: a permit authorizes one exact tree onto one exact destination head, once. A canonical write that was not authorized must not land. A write that was authorized must not be reported as unauthorized after it has been linearized.

## (2) The conflict this closes

`runPromotion` read authority, minted tokens, and let the container fast-forward the destination. `POST /promotion/finalize` then called `attemptPromotion`, which ran `authorityRefusal` again. A quarantine that landed in that window left the destination moved and finalize answering `QUARANTINED_CANDIDATE`, with the permit unconsumed (`promotion_written_but_finalize_pending`). Another pre-write read does not close that window.

## (3) The transition

`beginPromotion(permit_id)` is the linearization point. Inside one task-authority transaction it checks the current authority: the permit exists, is unused, binds the recomputed permit id, names a known contender, is the exact composition candidate when a composition record exists, is not `QUARANTINED` or `REVOKED`, passes the authority epoch, matches the stored evidence and tree, presents the permit's expected destination head, and is not blocked by another `IN_FLIGHT` reservation. It then stores one `PromotionReservation` with status `IN_FLIGHT`: permit id, contender id, candidate SHA, tree digest, expected destination head, evaluation bundle hash, authority epoch, promotion nonce, destination repo, source repo, and the permit fields needed to mint tokens without a second authority decision.

The same permit does not create a second reservation. A later `beginPromotion` for that permit returns the same reservation and the same nonce, with no second `promotion_reserved` ledger entry, including when a quarantine landed after the first call. The permit stays unconsumed until finalize.

`runPromotion` mints the source token, mints the destination token, and calls the container only after `beginPromotion` returns `RESERVED`. The container request carries the reservation's candidate SHA, destination, expected head, tree digest, and promotion nonce. The container script is not required to echo the nonce. The worker rejects a result whose promoted SHA, tree, or base is not the reservation. That rejection does not consume the permit. The reservation stays `IN_FLIGHT`.

`finalizeReservedPromotion` finalizes that same reservation. It does not call `authorityRefusal`. A proof that is not the reservation is `RESERVATION_MISMATCH`, the permit stays unconsumed, and the reservation stays `IN_FLIGHT`.

Quarantine before `beginPromotion`: begin fails, no Artifacts call, no container call.

Quarantine after `beginPromotion`: the reservation remains the authorized operation. The quarantine record stays. It applies to every later permit, SHA, and unreserved promotion. Finalize of the reserved write does not report that write as unauthorized. The quarantine is not discarded.

A lost finalize retries the same reservation. If the destination already contains the reserved candidate, the container reports `ALREADY_WRITTEN` and finalize consumes the permit once. There is one `promotion_succeeded` ledger entry and one canonical write.

`attemptPromotion` is begin plus finalize of that reservation for in-process callers. A head or tree that is not the permit binding fails before a reservation is stored.

A container 409 that `promote.sh` returns before any destination ref update is not left `IN_FLIGHT`. That case is `specs/amendments/promotion-terminal-abort-v1.md`. `PUSH_REJECTED`, a 502, a 503, and a lost finalize stay `IN_FLIGHT`.

## (4) What this amendment does not say

It does not undo a container write. It does not let a post-reservation quarantine delete the quarantine record. It does not let one permit hold two nonces. It does not claim this transition was observed on Cloudflare.
