# Spec amendment: authority-signing-v1 — authority-signed bundles, pinned verification, chained ledger

**Status:** proposed · **Date:** 2026-10-02
**Affects:** `ATTESTATION_PROTOCOL.md` (stable core) §4 (one field added to the
custom object), §6 (resolves the [OPEN] signing-key choice for v1) and §7
(transcript, failure table, and the "bundle carries everything" rule). It also
implements `PROMOTION_PROTOCOL.md` §11 (FROZEN-v1) "record the ship record"
without changing it. These are changed via this amendment file only; spec files
are NOT edited.

## (1) The invariants (quoted from the specs)

`ATTESTATION_PROTOCOL.md` §6:

> "The signing key lives in the **control plane only** (SLSA trust boundary,
> spec 3 §2)."

§4 rules:

> "`predicate.authority.permit_id` MUST equal the recomputation from spec 1 §10."

§7:

> "promotion authority ... CONSUMED ONCE   # permit_id present exactly once in the ledger"
>
> "The verifier MUST be runnable offline (bundle carries everything it needs)."

`PROMOTION_PROTOCOL.md` §11 (FROZEN-v1):

> "On success: write the tree to the canonical repo, record the ship record
> (spec 4), mark the permit consumed, append to the ledger. All four MUST be
> atomic from the task authority's perspective (Durable Object transaction,
> spec 5)."

## (2) What the implementation violated, and what §7 got wrong

- `src/cli/verify.ts` verified every signature against
  `bundle.authority_pubkey_der_hex`, the key inside the bundle. A bundle for a
  commit that never existed, signed by any freshly generated key, printed
  VERIFIED (reproduced by `test/forged-bundle.test.ts` before this change).
  "Bundle carries everything it needs" had made the trust anchor part of the
  data being verified.
- No component held a stable authority key. `scripts/live-e2e.ts` generated a
  fresh key per run and signed statements it built from its own local results.
  The slice did the same, so there was nothing a verifier could pin.
- `CONSUMED ONCE` was printed from `ledger_hashes`, which held the permit id
  itself, not any ledger hash. Consumption cannot be checked offline from that.
  The §4 rule that the permit id recomputes from its bound fields was not
  checked at all.
- `/promotion/finalize` consumed the permit and appended to the ledger but
  recorded no ship record (§11).
- Ledger entries (`seq, ts, kind, payload_hash`) were not chained, so no bundle
  could prove what the ledger contained.

## (3) The change

1. **Authority key.** `AUTHORITY_SIGNING_KEY` is an Ed25519 private key in
   PKCS8 form (PEM or base64 DER), held as a Worker secret. Its SPKI public key
   is pinned in `keys/authority.pub` (`keys/README.md`). This resolves §6's
   [OPEN] "Fulcio vs. long-lived key" for v1 as a long-lived key; Sigstore stays
   future hardening.
2. **Ship record at finalize.** `TaskAuthority` `/promotion/finalize` (whose
   body now carries `promoted_sha`) runs `attemptPromotion`. In the same storage
   transaction it builds the four statements from its own state and signs them
   (`recordPromotionBundle`):
   - every permit-bound value comes from the permit;
   - the test result comes from the stored evaluation bundle;
   - the verification result comes from the winner's ACCEPT verdict;
   - the candidate repo comes from the contender record;
   - `ship.commit` is the promoted SHA the promotion service reported.

   The test-result configuration digest is the evaluation bundle hash, because
   the authority holds the content-addressed evaluation record, not the
   evaluator's command lines. (Superseded where the evaluation carries
   `evaluation_config_sha256`: `evaluation-config-digest-v1.md`.)

   Without the key, finalize answers 503 and consumes nothing. A retry returns
   the stored bundle. `GET /tasks/:id/bundle[?permit_id=]` (CONTROL token)
   serves it.
3. **Hash-chained ledger.** Each entry gains `prev_hash` and
   `entry_hash = SHA-256(canonical_json({ seq, ts, kind, payload_hash, prev_hash }))`.
   The genesis `prev_hash` is 64 zeros. Because `createAuthority` is
   synchronous, the genesis entry is sealed at the first append. Ledgers
   persisted before this change are sealed the same way on their next append.
4. **Bundle v2.** `ledger: { head_sha256, entries }` replaces `ledger_hashes`.
   The `AgentPromotionAuthority/v1` predicate gains `ledger: { head_sha256 }`,
   the only addition to the custom object, so the authority's signature covers
   the ledger the bundle ships with.
5. **Verification.** `verify` requires a pinned key: `--trust-key <file>`, or
   `keys/authority.pub`; it exits 2 if neither is readable. Statements that do
   not verify under the pinned key are not evaluated at all. The transcript, in
   order:

   ```
   subject digest........ OK
   candidate digest...... OK
   chain integrity....... OK
   hidden evaluation..... PASSED
   policy digest......... OK
   destination parent.... OK
   authority key......... PINNED                        # embedded key equals the pinned key
   signature............. VALID                         # every envelope verifies under the pinned key
   permit id............. RECOMPUTED FROM BOUND FIELDS  # the §4 rule; replaces CONSUMED ONCE
   ledger chain.......... OK                            # entries chain to the signed head and record this promotion exactly once

   VERIFIED
   ```

   §7's "bundle carries everything it needs" becomes: **the bundle carries
   everything except the trust anchor, which the verifier pins.** Failure-table
   additions:

   | Tamper | Detected at |
   |---|---|
   | Bundle signed by any key other than the pinned key | `authority key` / `signature` |
   | Ledger entry changed, inserted, removed or reordered (with or without re-linking) | `ledger chain` |
   | Promotion recorded twice in the signed ledger | `ledger chain` |
   | `permit_id` not derived from its bound fields | `permit id` |

## Not claimed

- Offline verification cannot show that a permit was consumed exactly once
  everywhere. It shows that the authority's signed ledger records this promotion
  once.
- A pinned key is only as trustworthy as its distribution (here, a file in the
  repository). Rotation and transparency logging are future work.
- No production key is provisioned yet. `keys/authority.pub` must be generated
  together with the deployed Worker's secret; until then, live verification needs
  `--trust-key`.
- The slice signs with a harness key generated per run. Its VERIFIED shows the
  mechanism working, not anything about a production key.

Implementation notes: `src/lib/authority-key.ts`, `src/lib/ledger.ts`,
`src/lib/task-state.ts` (`appendLedger`, `recordPromotionBundle`),
`src/lib/attestation.ts`, `src/do/TaskAuthority.ts`, `src/worker/index.ts`,
`src/cli/verify.ts`, `scripts/live-e2e.ts`, `src/harness/slice.ts`. Tests:
`test/forged-bundle.test.ts`, `test/promotion-bundle.test.ts`,
`test/attestation.test.ts`, `test/slice.test.ts`, `test/env-isolation.test.ts`.
