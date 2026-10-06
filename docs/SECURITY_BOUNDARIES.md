# Security boundaries

Status words: **IMPLEMENTED**, **TESTED LOCALLY**, **TESTED ON CLOUDFLARE**, **NOT YET VERIFIED**.

Tree: `git4agents/combined` `4a8c4cc7b521688f839f0f332605dcefa3984c38`. Local evidence is the LF archive suite on 2026-10-06: 296 tests passed, slice OK, head-move OK, benchmark `zero_tolerance_ok: true`. None of this was re-run on Cloudflare.

This file also records the 2026-10-06 pass on `competition/security` parent `424b2b15425a65a25a230e949dea0f4d94192d9e`. The unresolved-merge scan is uncommitted. The attack log is `docs/COMPETITION_RED_TEAM.md`. That pass used Node v22.17.0 and Git Bash. It was not run on Cloudflare.

`docs/SECURITY.md` is the longer note. This file is the competition map. It does not replace the frozen threat model. The composition rule is `specs/amendments/composition-result-v1.md`. A commit that contains merge-marker bytes is also refused without a composition record: `specs/amendments/unresolved-merge-artifact-v1.md`. The frozen files were not edited.

**Unresolved P0 from that pass:** none. **P1, still open:** an evaluation bundle that omits `unresolved_merge_artifacts`, or sends `[]`, can be eligible and can be permitted. The promotion container then refuses the write. This map does not say the system is production-ready.

## Zones

| Zone | Credential | What it may do | Status |
|---|---|---|---|
| Coding agent | `AGENT_SERVICE_TOKEN` plus that agent's `X-Madgrix-Agent-Secret` | Claim and fork as itself. Child env is `minimalEnv` plus the names the runner sets. | **IMPLEMENTED. TESTED LOCALLY** (`test/env-isolation.test.ts`, contender-binding tests). **NOT TESTED ON CLOUDFLARE.** |
| Evaluation | `EVALUATION_SERVICE_TOKEN` | Submit evidence. Short-lived read of one contender fork. | **IMPLEMENTED. TESTED LOCALLY.** **NOT TESTED ON CLOUDFLARE.** |
| Control | `CONTROL_SERVICE_TOKEN` | Freeze tasks, record composition, run the verdict, start promotion. | **IMPLEMENTED. TESTED LOCALLY.** **NOT TESTED ON CLOUDFLARE.** |
| Authority signer | `AUTHORITY_SIGNING_KEY` | Signs promotion bundles inside the TaskAuthority. Offline verify uses `keys/authority.pub` or `--trust-key`. | **IMPLEMENTED. TESTED LOCALLY** (slice verify printed `VERIFIED`; forged-bundle tests in the suite). **NOT TESTED ON CLOUDFLARE.** |

A caller cannot put its zone in JSON. The Worker sets the zone after the bearer check.

## Composition

**IMPLEMENTED. TESTED LOCALLY. NOT TESTED ON CLOUDFLARE.**

- A coding agent cannot `POST /tasks/:id/composition`. The route requires the control token. The demo test and the composition route test cover the agent and evaluation tokens (401).
- `CONFLICTED` has no candidate SHA. Evidence throws. `issuePermit` and `attemptPromotion` return `UNRESOLVED_CONFLICT`, store no permit, and return no canonical-write effect.
- `RESOLVED` and `COMPOSED` name a new SHA. A contributing SHA is rejected as evidence and as a permit winner.
- The same canonical record is an idempotent no-op. CONFLICTED cannot be replaced by COMPOSED.
- The resolver process is not given the control, evaluation, or agent service tokens. `scripts/demo-resolve.mjs` exits 1 if those names are present. The demo test observed that for `CONTROL_SERVICE_TOKEN`.

The composition record is still required for a fork-crew `CONFLICTED` result. It is not the only refusal.

## Unresolved merge artifacts

**IMPLEMENTED. TESTED LOCALLY. NOT TESTED ON CLOUDFLARE.**

A blob with a conflict-marker pair (N ≥ 7 `<` at the start of a line, and a later line of N `>`) is not an admissible candidate, whether or not anyone called `POST /tasks/:id/composition`. The trusted evaluator records the paths. Eligibility fails `no_unresolved_merge_artifacts` when that list is non-empty. Passing tests do not compensate. `issuePermit`, `attemptPromotion`, and `runPromotion` return `UNRESOLVED_CONFLICT` with no permit and no canonical write. `container/promote.sh` scans the fetched blobs and exits 48 before any fast-forward, including before `ALREADY_WRITTEN`.

An unmerged index is visible only when a caller has one. Git will not commit it, so a submitted SHA is caught by the blob scan.

This is not a semantic-conflict detector. A line of `=` alone is not a marker. Intentional marker quotes are refused.

**P1.** A bundle that omits `unresolved_merge_artifacts`, or sends an empty list, was not scanned by this rule. It can be eligible and it can be permitted. The container does not trust the field and does not fast-forward. Observed in `test/unresolved-merge-artifact.test.ts` (7 pass) and in the two new `test/fixtures/promotion-cases.json` rows (bash and the TypeScript model).

## Attacks the local suite refuses

Each row is fail-closed in the local suite named above. The real Queue and the live Artifacts token service were not observed.

| # | Case | Where it is refused locally |
|---|---|---|
| 1 | Coding agent environment contains the control token | `minimalEnv` / allowlist. `test/env-isolation.test.ts`. |
| 2 | Coding agent environment contains the evaluation token | Same allowlist. |
| 3 | Agent A asks for agent B's contender | Contender binding. 403, no token. |
| 4 | Candidate changes trusted tests | `no_eval_tampering`, quarantine on `eval_file_changes`. |
| 5 | Candidate changes evaluator configuration | Distinct `evaluator_config_modification` trigger. |
| 6 | Bundle hash does not match the candidate it names | Verdict seam recomputes the hash and rejects. |
| 7 | Forged evaluation evidence | Seam uses the authority's stored bundle, then recomputes the hash. |
| 8 | Attacker signing key inside a bundle | `verify.ts` requires the pinned key. |
| 9 | Permit after canonical HEAD moved | `EXPIRED_HEAD_MOVED`. Head-move harness. |
| 10 | Consumed permit presented again | `ALREADY_CONSUMED`, no second write. Slice harness. |
| 11 | Duplicate queue event | `ACK_DUP` on `event_key`. In-memory delivery. |
| 12 | Push for an unknown repo | `REJECTED_OUT_OF_ORDER`, ledgered, not applied. |
| 13 | Quarantined contender | Excluded from selection. Promotion returns `QUARANTINED_CANDIDATE`. |
| 14 | Unresolved conflict | `UNRESOLVED_CONFLICT` when composition is `CONFLICTED`, and also when the bundle lists merge-marker paths. `promote.sh` exits 48 if the blobs contain a marker pair even when the bundle omits the field. An omitted or empty field can still be eligible (P1). |
| 15 | Rebase conflict | Rebase report escalates. Container tests in the LF suite. |
| 16 | Old evidence on a new SHA | Seam hash mismatch. A rebased SHA needs a new permit. A contributing SHA is refused after RESOLVED. |
| 17 | Destination moves during promotion | Same as row 9. The container fast-forward refuses a missing ancestor. |
| 18 | Candidate pushes the canonical repo | Fork token is for the fork. `executeEffects` does not perform `canonical_write`. |

Rows 11 and 18 are **NOT YET VERIFIED** against a live Queue or a live Artifacts credential. The local fakes and local git are what passed.
