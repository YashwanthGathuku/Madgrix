# Spec amendment: governed-resolution-v1 — overlapping work is resolved, and the resolution is governed

**Status:** proposed · **Date:** 2026-10-18
**Builds on:** `resolution-lease-v1.md`, `conflict-capsule-v1.md`, `composition-result-v1.md`.
**Affects:** `PROMOTION_PROTOCOL.md` (FROZEN-v1) §9.5 and the promotion bundle of
`authority-signing-v1.md`, by this amendment file only. The frozen spec files are not edited.

## (1) The gap

Before this amendment a fork crew whose agents changed the same lines stopped
at CONFLICTED. A resolver command could be supplied, but nothing produced a
resolution, nothing judged whether one kept both agents' work, and nothing tied
a RESOLVED candidate to the conflict it answered. Overlap was flagged, not
resolved.

Resolution itself is the easy part to automate badly. Published evaluations of
LLM merge resolution report under 60% agreement with developers (Merge-Bench,
ICPR 2026) and show that textual similarity is not correctness (SWE-Git-Bench,
NeurIPS 2026). This amendment therefore treats every resolver — a structured
merge tool, a language model, a person's command — as an untrusted producer,
and governs what it may write and what may be admitted.

## (2) Hunk-level lease and Conflict Capsule v2

- A two-sided conflict in one file is split into **hunks** with
  `git merge-file --diff3` (`conflictHunks`). The clean regions are written by
  the authority; each hunk holds its baseline text. The resolved file must keep
  every clean region in order and unchanged (`matchTemplate`), or the resolution
  is refused. Three or more sides on one file, or a split that is not exact
  (marker-like input lines, a missing final newline), lease the whole file.
- The conflict record carries per-hunk digests (`CompositionFile.hunks`: base
  and side SHA-256, no text). The authority stores them.
- **Conflict Capsule v2** (`madgrix-conflict-capsule/v2`, `buildConflictCapsuleV2`)
  adds the hunk digests and `witness_manifest_sha256` to v1. `capsule_id` is
  SHA-256 over the canonical JSON of the rest. **The authority computes it** when
  CONFLICTED is recorded; a supplied id that disagrees is refused. The ledger's
  `composition_recorded` payload carries it.

## (3) Frozen intent witnesses

- A crew config declares witnesses per sub-agent (`witnesses: [{ id, script }]`)
  and crew-wide regressions (`regressions: [{ id, script }]`). Scripts are `.mjs`
  (node) or `.sh` (bash), run with a checkout of the tree under test as the
  working directory and the minimal child environment.
- Witnesses are **frozen when the crew is loaded**, before any agent runs: their
  bytes are read once and hashed into a `madgrix-witness-manifest/v1`. They run
  from copies outside every candidate tree, so neither an agent nor a resolver
  can weaken them by editing files in its tree. Outcomes on the baseline and on
  each side's own commit are fixed before any resolver sees the conflict.
- A witness counts for side *i* only if it **discriminates** that side:

  ```
  witness_i(t)  ⇔  ¬pass(t, baseline) ∧ pass(t, sha_i)
  ```

- The gate on a candidate R (`madgrix-witness-report/v1`):

  | Verdict | When |
  |---|---|
  | REFUSE | a discriminating witness fails on R, or a check that passed on the baseline fails on R |
  | REVIEW | otherwise, some required side (a side of a conflicted file) has no discriminating witness |
  | ADMIT | otherwise |

  Absence of a witness is not evidence that intent survived (the same rule as
  "L2 unavailable is never GREEN" in `INTENT_AND_CONFLICT_GRAPH.md` §4).

Prior art: SAM (Da Silva, Borba et al., arXiv:2310.02395) runs generated unit
tests on base, parents and merge and flags a test a parent passes that the
merge fails. The criterion is theirs. What is different here is where it sits:
witnesses frozen before an untrusted resolver runs, used as a
non-compensatory admission gate rather than a detector after the fact.

## (4) The resolution ladder

`resolveWithLadder` (control plane) runs each rung under the lease and gates
every candidate:

1. **structured** — Mergiraf (syntax-aware merge; GPL-3.0, run as an external
   binary, never vendored), when installed.
2. **replay** — an untrusted replayer (`MADGRIX_REPLAYER`; an LLM adapter is
   provided for the Anthropic Messages API and Workers AI) is asked to re-apply
   one side's intent onto the other side's version of each hunk, **in both
   orders**. A and B are the two sides sorted by agent id.
   - R_AB and R_BA both ADMIT → admitted; R_AB is kept;
     `order_agreement` is `identical` (same leased text) or `behavioral`.
   - Exactly one ADMIT → the outcome depends on order. This is escalated, not
     decided by picking the admitted order.
   - Neither ADMIT → escalated.
3. **REVIEW** — nothing is admitted; a person decides.

A REVIEW verdict stops the ladder: another resolver cannot add missing
evidence. A person may **clear** a REVIEW only for a candidate whose verdict is
REVIEW (an unwitnessed side — an ambiguity), and only for replay when both
orders produced identical text. A REFUSE verdict, or orders that disagree, is
never cleared: a person answers it with a resolver command
(`MADGRIX_RESOLVER_COMMAND`), whose output is leased and gated like any rung.

## (5) What the authority records

`recordComposition` (`src/lib/task-state.ts`, rules in `src/lib/resolution-authority.ts`):

- **CONFLICTED** gets the authority-computed capsule id.
- **RESOLVING / RESOLVED** must follow a recorded CONFLICTED (or RESOLVING)
  record with the same contributing SHAs. The conflict's files, capsule id and
  witness manifest are taken from the authority's record, not the caller's.
- **RESOLVED** requires a `resolution` block (`madgrix-resolution/v1`):
  `capsule_id` equal to the recorded capsule; `rung` one of structured, replay,
  command; replay must state `order_agreement`; `lease.paths` equal to the
  conflicted paths; `witness.witness_manifest_sha256` equal to the manifest
  frozen with the conflict; `witness.verdict` ADMIT, or REVIEW with a non-empty
  `review_cleared_by`. REFUSE is never recordable.
- A RESOLVED record appends a second ledger entry, `resolution_recorded`, whose
  payload hash is SHA-256 of `{ candidate_sha, contender_id, baseline, resolution }`.
- **COMPOSED** over member claims whose stored conflict report is RED or
  BLOCKED requires a `witness_check` (ADMIT, or REVIEW cleared) run against the
  manifest the composition names. A clean text merge is not evidence that two
  agents touching the same symbol or contract still agree. The runner goes
  further: whenever witnesses are declared it checks a COMPOSED candidate, and
  a REFUSE is reported as SEMANTIC_CONFLICT and not pushed.
- The resolution, capsule and witness verdict appear on the composition node of
  the causal proof graph (`/why`).

The authority does not run witnesses or resolvers. It binds what the control
plane reports (the same trust it gives the composition record itself) and
refuses the states that must never exist: a resolution of no recorded conflict,
of another capsule, against another witness manifest, or with a REFUSE verdict.

## (6) Promotion bundle and offline verify

- A promotion bundle for a RESOLVED candidate carries `resolution`: the exact
  payload whose hash the signed ledger recorded as `resolution_recorded`.
- `verify` adds an eleventh transcript line, **resolution**:
  - no resolution in the bundle and none in the signed ledger →
    `NONE (not a resolved candidate)`;
  - the ledger records a resolution but the bundle carries none → FAIL;
  - the bundle's resolution is not recorded exactly once in the signed ledger,
    or names another commit than the promoted one → FAIL;
  - otherwise `CAPSULE <id12> · <rung> · witnesses <verdict>`.

## (7) What this amendment does not say

- **Witness quality bounds everything.** The gate is exactly as strong as the
  witnesses: a resolution that keeps every witnessed behavior but breaks an
  unwitnessed one is admitted. "Behavioral" order agreement means agreement on
  the witnesses, nothing more.
- **The authority trusts the control plane's witness report.** It records the
  report digest; it does not re-run the witnesses. The evaluation domain does
  not yet re-run them independently.
- **No LLM resolution has been evaluated.** The replay rung and the LLM adapter
  are tested with deterministic replayers and a local mock server. No result
  about model resolution quality is claimed.
- **Replay supports two sides.** Three or more sides on one file reach REVIEW.
- **Resolvers are not sandboxed** (`docs/KNOWN_LIMITATIONS.md` #11): the lease
  is enforced on what is committed, not on what the process can touch.
- **No live Cloudflare run of a resolved crew yet.** The local path is tested
  end to end; `docs/DEMO_RUNBOOK.md` lists the live steps.
- Dual-order agreement as an admission signal is, to our knowledge, new.
  Novelty is not asserted without a broader prior-art review.

Tests: `test/governed-resolution-runner.test.ts`, `test/governed-resolution-authority.test.ts`,
`test/resolve-lease.test.ts`, `test/demo-composition.test.ts`.
