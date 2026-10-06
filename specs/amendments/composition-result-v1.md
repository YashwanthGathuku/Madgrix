# Spec amendment: composition-result-v1 — a fork crew is COMPOSED or CONFLICTED, and CONFLICTED is not a candidate

**Status:** proposed · **Date:** 2026-10-06
**Affects:** `PROMOTION_PROTOCOL.md` (FROZEN-v1) §9.5 and §12, by this amendment file only.
The frozen spec files are not edited. `WorkClaim` fields are not changed.

## (1) The invariant

`PROMOTION_PROTOCOL.md` §9.5: a candidate that is not an admissible exact state does not proceed to promotion. §12 rejects stale or mismatched work rather than shipping it under another name.

A fork crew that has a known unresolved textual overlap is not an admissible candidate. Writing conflict markers into a commit and pushing that commit made the overlap look like an ordinary candidate SHA. That is the behavior this amendment closes.

## (2) The result

`scripts/lib/fork-crew.mjs` classifies the sub-agent commits:

- **COMPOSED.** Disjoint edits, including non-overlapping lines of one file, become one merge commit. Its parents are the frozen baseline and each sub-agent commit. `candidate_sha` is that commit.
- **CONFLICTED.** Overlapping lines produce no commit. The parent checkout stays at the baseline. The result carries the baseline, the agents and their intents, the contributing SHAs, the paths, the classification `textual-line-overlap`, and a short excerpt of each side. `candidate_sha` is null. The runner does not push.
- **RESOLVED.** A resolver command may read the baseline tree, `.madgrix/conflict.json`, and `.madgrix/sides/<agent>/`. It receives `MADGRIX_CONFLICT_PATH` and `MADGRIX_BASELINE_SHA` only. It does not receive `CONTROL_SERVICE_TOKEN`, `EVALUATION_SERVICE_TOKEN`, or the agent service token. The commit it writes is a new SHA. That SHA is not one of the contributing SHAs. It still needs its own evaluation, verdict, and permit.

## (3) The authority

The control plane records the result with `POST /tasks/:id/composition` (`CONTROL_SERVICE_TOKEN`). A coding agent cannot call that route.

`recordComposition` (`src/lib/task-state.ts`):

- The baseline must be the frozen task baseline.
- CONFLICTED cannot be replaced by COMPOSED. RESOLVED may follow CONFLICTED. A recorded candidate SHA cannot be rebound. The same canonical record is an idempotent no-op.
- While the record is CONFLICTED, `submitEvaluation`, `issuePermit`, and `attemptPromotion` fail closed for that contender (`UNRESOLVED_CONFLICT` for the permit and promotion paths; evidence throws). No permit is stored. A refused promotion does not consume a permit and returns no canonical-write effect.
- After COMPOSED or RESOLVED, a contributing SHA is not evidence for the new candidate and cannot be permitted or promoted in its place. A later SHA that is not a contributing SHA (an empty republish of the composed commit, for example) is a different candidate and needs its own evaluation. It is not treated as the already-recorded SHA.

The Worker `runPromotion` applies the same refusal before it asks the promotion container to write.

## (4) What this amendment does not say

TheUstad, as wired, checks that the frozen baseline identity still holds before composition. It does not evaluate the composed or resolved candidate. A passing local harness is not a Cloudflare run.
