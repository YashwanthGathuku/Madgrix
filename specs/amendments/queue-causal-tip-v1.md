# Spec amendment: queue-causal-tip-v1 — a stale push does not rewind the tip

**Status:** proposed · **Date:** 2026-10-12
**Affects:** `CLOUDFLARE_RUNTIME_MODEL.md` (FROZEN) §3, by this amendment file
only. The frozen spec is not edited.

## (1) The invariant

`CLOUDFLARE_RUNTIME_MODEL.md` §3:

> "Out-of-order events MUST NOT corrupt state: transitions are validated against current state (e.g. "evidence for unknown candidate" is rejected, not applied blindly)."

Queue delivery is at-least-once and unordered. `event_key = SHA256(namespace || repo || ref || before || after)` makes a redelivery of the same push idempotent. A delayed older push has a different `event_key`. Dedupe alone does not keep `latest_commit` from moving backward.

## (2) The conflict this closes

`ingestQueueEvent` used to set `latest_commit = event.after` for every new key on a known fork. A tip of C could become an older `after` when a delayed event arrived. An unknown repository was named `REJECTED_OUT_OF_ORDER`. That name claimed a reorder the function had not detected.

## (3) The transition

The ingestion boundary has `before` and `after` only. It does not look up git ancestry and it does not guess.

The observed tip is `latest_commit` when that is a non-empty string, otherwise `fork_base` when that is a non-empty string, otherwise unknown.

- Seen `event_key` → `ACK_DUP`. Same state object. No effects.
- Repository is not a known contender fork → `REJECTED_UNKNOWN_REPO`. Ledger kind `queue_event_rejected_unknown_repo`. No contender is updated. This is not evidence of out-of-order delivery.
- `after` is already the observed tip → `ALREADY_OBSERVED`. The tip stays.
- `before` is the observed tip → `APPLIED_NEW`. The tip becomes `after`.
- Anything else, including an unknown tip → `REQUIRES_RECONCILIATION`. The tip stays. Ledger kind `queue_event_requires_reconciliation`. A later event whose `before` is the tip may still advance it.

The queue consumer acknowledges `ACK_DUP`, `APPLIED_NEW`, `ALREADY_OBSERVED`, `REQUIRES_RECONCILIATION`, and `REJECTED_UNKNOWN_REPO`. It does not throw those outcomes back onto the queue.

`submitEvaluation` still admits evidence only for `latest_commit`. A stale event that does not move the tip cannot change which SHA that check accepts.

## (4) What this amendment does not say

It does not claim the local function was observed on Cloudflare Queue. It does not treat an unknown repository as a reordered push. It does not invent a parent link the event did not carry.
