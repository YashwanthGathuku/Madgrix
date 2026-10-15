# Spec amendment: quarantine-authority-epoch-v1 — quarantine ends the old authority

**Status:** proposed · **Date:** 2026-10-12
**Affects:** `PROMOTION_PROTOCOL.md` (FROZEN-v1) §9.5, by this amendment file
only. The frozen spec is not edited.

## (1) The invariant

`PROMOTION_PROTOCOL.md` §9.5 (FROZEN-v1):

> "A quarantined candidate state can NEVER be promoted. If the work is salvageable: new candidate state → new SHA → new evidence → full reevaluation. This prevents evidence laundering through quarantine."

> "`RELEASED` requires the operator-of-record to determine the trigger was a mechanical false positive AND re-verification to pass; otherwise `REVOKED` terminates the contender."

RELEASED is that determination. It is not a path back to the SHA, the evidence, the ACCEPT, or the permit that existed when quarantine was entered.

## (2) The conflict this closes

The implementation cleared `tainted` on RELEASED and then promoted the pre-quarantine permit. `REVOKED` fell through the same promotion check and emitted `canonical_write`. A bundle submitted while `QUARANTINED` was stored with `tainted: false` and, after `REVOKED`, could be accepted, permitted, and promoted.

That reuses the quarantined candidate state. §9.5 forbids it.

## (3) The epoch

Entering quarantine records two lists on the quarantine record and does not delete them later:

- `blocked_candidate_shas`: every evaluation SHA of that contender, plus `latest_commit` when it is set.
- `voided_permit_ids`: every permit id of that contender.

Those lists are the epoch boundary. A missing list on a `RELEASED` record fails closed.

**QUARANTINED**

- A new bundle may be stored only as forensic evidence: `tainted: true`, ledger kind `evaluation_recorded_forensic`, no quarantine effects repeated, and the SHA is added to `blocked_candidate_shas`. It is not selectable. The first quarantine evidence hash stands.
- `runVerdictSeam` does not ACCEPT the contender.
- `issuePermit` returns `QUARANTINED_CANDIDATE` and stores no permit.
- `attemptPromotion` and `runPromotion` return `QUARANTINED_CANDIDATE`, do not consume the permit, and emit no `canonical_write`. `runPromotion` returns before it mints a token or calls the promotion container.

**REVOKED**

- The contender is permanently non-promotable.
- `submitEvaluation` rejects a new bundle.
- `runVerdictSeam` does not ACCEPT.
- `issuePermit` returns `REVOKED_CANDIDATE`.
- `attemptPromotion` and `runPromotion` return `REVOKED_CANDIDATE`, do not consume a permit, and emit no `canonical_write`.
- Evidence received during quarantine does not become clean selectable evidence because the status changed.

**RELEASED**

- Taint stays. `blocked_candidate_shas` stays. `voided_permit_ids` stays.
- A pre-quarantine permit stays void. It cannot promote.
- A pre-quarantine ACCEPT cannot mint a permit for a blocked SHA.
- A SHA whose evidence was submitted during quarantine stays blocked.
- Salvage is a new SHA that is not on `blocked_candidate_shas`, then new evidence, a new verdict, and a new permit issued after release. A push that was not itself submitted as evidence during quarantine may be that new SHA.

`authorityRefusal` is the check `submitEvaluation` (for the released and revoked gates), `runVerdictSeam`, `issuePermit`, `attemptPromotion`, and `runPromotion` share.

## (4) What this amendment does not say

It does not add an agent-accusation trigger. It does not let RELEASED skip the signed determination or the passing re-check. It does not say a local suite is a Cloudflare run.
