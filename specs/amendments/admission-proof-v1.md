# Admission proof v1 (payload v2 since round 4)

Status: implemented (src/lib/admission-proof.ts, recordComposition in src/lib/task-state.ts,
attachAdmissionProofs in scripts/lib/governed-resolution.mjs).

## Problem
The authority cannot run witnesses and cannot read git objects. Before this
amendment it accepted any `witness_report_sha256`/`verdict` the control plane
sent (a forged ADMIT) and any `candidate_sha` string (a commit that does not exist).

## Rule
When the authority has a pinned witness runner key (`Ctx.witnessRunnerPublicKey`,
from `MADGRIX_WITNESS_RUNNER_PUBLIC_KEY`: SPKI DER hex of an Ed25519 key), every
COMPOSED or RESOLVED record must carry `admission_proof`:

1. `commit_object` (base64): the candidate's raw commit object. The authority
   computes `sha1("commit <len>\0" + body)`; it must equal `candidate_sha`.
   The commit's parents must be exactly `{baseline} ∪ contributing_shas`
   (the shape `commitIndex` writes). A made-up SHA, or a real commit that is
   not this composition, fails.
2. `attestation` (when the record carries a witness verdict: RESOLVED
   `resolution.witness`, or COMPOSED `witness_check`): an Ed25519 signature by
   the runner key over the canonical JSON of
   `{format: "madgrix-witness-attestation/v1", task_hash, contender_id, baseline,
   contributing_shas (sorted), candidate_sha, candidate_tree, capsule_id,
   witness_manifest_sha256, witness_report_sha256, verdict, review_cleared_by}`.
   The authority rebuilds this payload from ITS view of the record (task hash
   from state, capsule from the recorded CONFLICTED, tree from the verified
   commit object), so a change to any field fails the signature.

The proof is checked and not stored: the ledger and promotion bundle are
unchanged, so offline `verify` does not re-check it.

## Runner
`run-fork-crew` signs with `MADGRIX_WITNESS_RUNNER_KEY_FILE` (PKCS8 PEM).
`governCrewResult(..., { witnessSigner })` attaches the proof.

## What this does not do
- Without a pinned key the authority behaves as before (the gap remains).
- The runner key holder can still sign any verdict: this moves trust from
  "whoever can call the control endpoint" to "whoever holds the witness runner
  key"; it does not let the authority re-run witnesses.
- The commit object proves the commit id, tree id and parents, not the tree's
  contents; tree contents are bound later by the evaluation's tree digest.

## Round 4 (payload `madgrix-witness-attestation/v2`)

Supersedes the sections above where they differ.

1. **A key is required.** With no witness runner key pinned the authority
   refuses every COMPOSED and RESOLVED record ("no witness runner key is
   pinned"). `MADGRIX_INSECURE_UNPINNED_WITNESS_RUNNER=1`
   (`Ctx.insecureUnpinnedWitnessRunner`) accepts them without a proof, for
   local development only, and prints a warning once per process.
2. **Several keys, key ids, revocation.** `MADGRIX_WITNESS_RUNNER_PUBLIC_KEY`
   is a comma/whitespace-separated list of SPKI hex keys
   (`Ctx.witnessRunnerKeys`). A key's id is `wr-` + the first 16 bytes of
   SHA-256(SPKI DER), hex. The attestation names its `key_id` (also inside
   the signed payload); it must be pinned and not listed in
   `MADGRIX_WITNESS_RUNNER_REVOKED_KEY_IDS`. Rotation: pin old and new keys
   together, move the runner to the new key, then drop or revoke the old one.
3. **Stored and re-checked.** The verified proof is stored on the composition
   (`admission_proof`); `composition_recorded` carries its SHA-256, and a
   RESOLVED record's `resolution_recorded` payload (which the promotion
   bundle carries) includes the proof, `contributing_shas` and
   `rebased_onto`. Offline `verify` re-runs the whole check under ITS pinned
   witness keys (`--witness-key <file>` repeatable, `--revoked-witness-keys`,
   else the same env variables). A resolution with no proof, no witness key
   pinned for verify, a revoked or unpinned key, or any failed check is
   NOT VERIFIED.
4. **File contents.** The proof carries `tree_objects` (raw tree objects from
   the root down to every bound file, each hashed to its id) and `files`
   (bound paths with mode, blob id and SHA-256 of the bytes). Bound paths:
   RESOLVED's leased (conflicted) paths; COMPOSED's record files. The
   attestation also names the candidate's tree-digest/v1
   (`candidate_tree_digest_v1`, SHA-256 over every file's bytes). The
   authority walks the trees and checks each bound blob id and mode; the
   attestation signs the rest. Offline verify also requires the attested
   tree-digest/v1 to equal the promoted `ship.tree_sha256`.
5. **Rebased candidates.** `rebased_onto` (when set) replaces the baseline in
   the parents check and is part of the signed payload. The authority cannot
   check that it descends from the baseline; the runner vouches for that.
6. Every COMPOSED/RESOLVED record carries an attestation now (verdict `NONE`
   when there is no witness verdict).

### Limits (round 4)
- Whoever holds a pinned, unrevoked runner key can still sign any verdict and
  any per-file SHA-256 and tree-digest/v1; the authority cannot re-run
  witnesses or read file bytes. What is proven by hashing alone is: candidate
  SHA → commit → parents and tree → bound blob ids (SHA-1).
- Revocation has no time dimension: revoking a key makes every proof it
  signed fail, including bundles verified earlier. There is no timestamping,
  no transparency log, and no key expiry.
- The insecure opt-in records no proof; such a resolution can never verify
  offline.
- COMPOSED proofs are stored and hashed into the ledger, but a promotion
  bundle carries only RESOLVED resolution payloads, so offline verify
  re-checks proofs of resolutions only.
- In the bundle the proof is inside the ledger-hashed resolution payload, so
  editing it is first caught as a ledger mismatch; the independent re-check
  catches proofs that were recorded but no longer verify under the
  verifier's keys (revoked, not pinned).
