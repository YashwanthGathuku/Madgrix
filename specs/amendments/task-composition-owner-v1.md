# Spec amendment: task-composition-owner-v1 — one composition, one contender

**Status:** proposed · **Date:** 2026-10-13
**Affects:** `PROMOTION_PROTOCOL.md` (FROZEN) composition rules, by this amendment
file only. The frozen spec is not edited. It narrows
`specs/amendments/exact-composition-candidate-v1.md` for a task that already
has a composition record.

## (1) The invariant

A task authority holds one composition record. That record names one contender. The promotable SHA, when the status is `COMPOSED` or `RESOLVED` and the SHA is not a crew contribution, is `candidate_sha`.

## (2) The conflict this closes

`compositionBlocks` returned false when `composition.contender_id` was not the contender being judged. A second contender could be evaluated, selected, permitted, and promoted at a member SHA, an older SHA, or the composition candidate itself, while the owner's other SHAs stayed refused.

## (3) The transition

Once `state.composition` exists, only `composition.contender_id` can pass the composition check.

For that owner:

- `PENDING`, `COMPOSING`, `CONFLICTED`, and `RESOLVING` name no promotable SHA.
- `COMPOSED` and `RESOLVED` name only the exact `candidate_sha` from `promotableCompositionSha`.

For every other contender, evaluation, verdict selection, permit issuance, `attemptPromotion`, and `runPromotion` are refused. The refusal is `UNRESOLVED_CONFLICT`. There is no canonical write. The check is not "is this SHA in `contributing_shas`". The exact candidate SHA is refused for a contender who does not own the record.

Registering another contender is unchanged. Multiple composed contenders per task would need a different state model and are not part of this amendment.

## (4) What this amendment does not say

It does not allow two `CrewContender` compositions on one task. It does not change the owner's plate from `exact-composition-candidate-v1.md`.
