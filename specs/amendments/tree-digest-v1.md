# Spec amendment: tree-digest/v1 canonical exact-state digest

**Status:** accepted for competition implementation · **Date:** 2026-10-01  
**Affects:** `PROMOTION_PROTOCOL.md` definition of `tree_sha256`. The frozen
spec requires an exact SHA-256 tree identity but does not define the byte
encoding. This amendment supplies that missing deterministic encoding without
changing the frozen promotion semantics.

## Problem

Cloudflare Artifacts exposes Git commit/tree object ids as SHA-1 values. Those
ids are useful for Git transport, but the frozen MADGRIX permit deliberately
binds an independent `tree_sha256`. The earlier in-memory substrate hashed a
JSON map, which is not an interoperable definition for a real Git repository
and does not represent executable-bit changes.

## tree-digest/v1

For an immutable candidate commit:

1. Walk the candidate tree recursively in the exact byte order emitted by
   `git ls-tree -rz --full-tree <candidate>`.
2. For every **blob** entry, append these bytes to the digest stream:

   `mode NUL path NUL SHA256(blob-bytes) NUL`

3. Compute SHA-256 of the complete stream. The lowercase 64-character hex
   result is `tree_sha256`.
4. V1 rejects non-blob leaf entries such as gitlinks/submodules. A future
   version may define their content identity explicitly; it MUST use a new
   digest version instead of silently changing v1.

The mode is included, so a `100644 → 100755` executable-bit change alters the
digest. Blob contents are SHA-256 hashed independently of Git's SHA-1 object
id. Paths are NUL-delimited, so ordinary whitespace/newlines cannot make two
entry sequences ambiguous.

## Promotion rule

The trusted promotion environment MUST recompute `tree-digest/v1` from the
exact fetched `winner_candidate_sha` immediately before canonical write. A
mismatch with the permit-bound `winning_tree_sha256` produces
`TREE_MISMATCH`; no write occurs and the permit remains unconsumed.

The production implementation lives in `src/do/PromotionContainer.ts`.
(Later moved: the digest is computed by `container/promote.sh`, which
`src/do/PromotionContainer.ts` runs; `src/lib/tree-digest.ts` is the TypeScript
implementation the tests compare it with. See `rebase-ancestry-v1.md`.)
