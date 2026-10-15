# Spec amendment: queue-nonempty-tip-v1 — an empty after is not a tip

**Status:** proposed · **Date:** 2026-10-13
**Affects:** `CLOUDFLARE_RUNTIME_MODEL.md` (FROZEN) §3, by this amendment file
only. The frozen spec is not edited. It adds a rejection in front of
`specs/amendments/queue-causal-tip-v1.md`.

## (1) The invariant

`CLOUDFLARE_RUNTIME_MODEL.md` §3:

> "Out-of-order events MUST NOT corrupt state."

`latest_commit` is a commit id. An empty string is not a commit id.

## (2) The conflict this closes

`ingestQueueEvent` stored `event.after` whenever `before` was the observed tip. `after: ""` set `latest_commit` to `""`. `observedTip` ignores an empty `latest_commit` and falls back to `fork_base`, so a later event whose `before` is the fork base was applied and the tip moved backward.

## (3) The transition

Before a contender is updated, a push is `REJECTED_INVALID_EVENT` when it is not a string-shaped queue event, when `repo` or `ref` is empty or whitespace-only, when `after` is empty or whitespace-only, or when `after` is 40 or 64 zeros (a ref deletion, not a candidate tip). The seen key is recorded. The tip does not change. A redelivery of that key is `ACK_DUP`. `trim()` is used only to detect an empty value. The stored tip is never a trimmed copy of `after`.

A following event whose `before` is the old fork base is `REQUIRES_RECONCILIATION` while the non-empty tip is unchanged. It does not become current.

The queue consumer acknowledges `REJECTED_INVALID_EVENT` along with the outcomes in `queue-causal-tip-v1.md`. It does not throw that outcome back onto the queue.

A non-empty `after` whose `before` is the current tip is still `APPLIED_NEW`, including when `after` is a different id. This amendment does not add ancestry.

## (4) What this amendment does not say

It does not claim the local function was observed on Cloudflare Queue. It does not treat a deletion as the contender's latest commit. It does not rewrite `queue-causal-tip-v1.md`.
