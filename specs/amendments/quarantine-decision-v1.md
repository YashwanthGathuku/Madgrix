# Spec amendment: quarantine-decision-v1 — a review decision is one of two spellings

**Status:** proposed · **Date:** 2026-10-13
**Affects:** `PROMOTION_PROTOCOL.md` (FROZEN) §9.5, by this amendment file
only. The frozen spec is not edited.

## (1) The invariant

`PROMOTION_PROTOCOL.md` §9.5:

> "A quarantined candidate state can NEVER be promoted."

A review moves a `QUARANTINED` record to `RELEASED` or `REVOKED`. Those are the only two determinations. `RELEASED` still requires the mechanical re-check to pass. `REVOKED` does not.

## (2) The conflict this closes

`reviewQuarantine` typed its decision as `"RELEASED" | "REVOKED"` and stored that value. Runtime JSON is not checked by the type. A signed `revoked`, `REVOKED `, `APPROVED`, or any other value was stored as the record status. `authorityRefusal` matched only the exact spellings `QUARANTINED`, `REVOKED`, and `RELEASED`, so the stored value fell through and the pre-quarantine permit promoted.

## (3) The transition

`reviewQuarantine` accepts a decision only when it is exactly `RELEASED` or exactly `REVOKED`. The check runs before any state write. There is no trim, no case-folding, and no alias. Any other value, including a signed one, throws and leaves the record `QUARANTINED`.

`authorityRefusal` fails closed when a stored quarantine status is anything other than exact `QUARANTINED`, `REVOKED`, or `RELEASED`. That refusal is `QUARANTINED_CANDIDATE`. An unknown status does not fall through to promotion.

`RELEASED` still requires `recheck.passed`. `REVOKED` still follows the epoch in `quarantine-authority-epoch-v1.md`: taint, blocked SHAs, and voided permit ids stay.

## (4) What this amendment does not say

It does not add a review route to the worker. It does not treat a misspelled decision as `REVOKED`. It does not clear a quarantine that failed the allow-list.
