# Spec amendment: frozen-readme-rehash — re-record the hash of the specs index

**Status:** proposed · **Date:** 2026-10-03
**Affects:** `specs/FROZEN.json`, the recorded content hash of `specs/README.md`.
`specs/README.md` is the index of the six specs. `FROZEN.json` lists it under
"Stable cores (hardening in parallel)", not FROZEN-v1. No spec text is edited.

## (1) The invariant

`specs/FROZEN.json`:

> "To verify: `sha256sum <file>` must reproduce the hash above. Any mismatch
> means the frozen contract was altered — treat as an unrecorded amendment
> and halt."

## (2) The finding

- `sha256sum specs/README.md` gives
  `9f4d24609ced99afba1a3dd9fedf51d02e54f415b614d3559ed2b056445d28b5`.
  `FROZEN.json` records
  `0d2a1f7038f6387134d4d7ff0244160c9565e40729a4ce0dd1504cded7feebbe`.
  The six spec files reproduce their recorded hashes.
- No committed content produces the recorded hash. A scan of every blob in the
  repository's full history (all branches, unshallowed: 454 objects) found
  none that hashes to `0d2a1f70…`. Neither does the current text with CRLF line
  endings, a byte-order mark, or with its trailing newline removed or doubled.
- `specs/README.md` and `FROZEN.json` entered the repository together in
  `1e514a3` ("Madgrix: public competition release"), which imported the specs
  from the pre-release workspace. The current text is the only version of the
  file ever committed, and it is unchanged from `1e514a3` to `6a7ac47`. So the
  text changed after its hash was recorded and before the import, and the
  hashed text is not in the repository.
- Inference, not provable from the repository: the file's first line, "Build
  status: UNPAUSED — implementation green-lit against FROZEN-v1 contracts",
  describes a state after the freeze. `docs/DEVELOPMENT_LOG.md` records the
  freeze, then the naming decision, then the start of implementation. A status
  edit after hashing is the likely change.

`FROZEN.json` says to halt on a mismatch. Left in place, this one could never
be resolved, so every hash check failed and the check stopped meaning anything.

## (3) The change

1. `FROZEN.json` records `README.md` as `sha256:9f4d2460…` (full value in the
   file), the hash of the only version in the repository. The previous value
   stays in `FROZEN.json` as a note that points to this amendment.
2. `test/frozen-specs.test.ts` recomputes every recorded hash as part of
   `npm test`, which CI runs. An edit to any listed file now fails the suite
   until an amendment records it and `FROZEN.json` is updated with it.

## Not claimed

- This does not establish what the index said when it was frozen. Anyone who
  still has the pre-release workspace can check its copy against `0d2a1f70…`.
- Re-recording makes the current index text the baseline. It is not a review
  of that text. The six spec files and their hashes are unchanged.
