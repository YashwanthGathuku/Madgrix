# Security boundaries

Status words: **IMPLEMENTED**, **TESTED LOCALLY**, **TESTED ON CLOUDFLARE**, **NOT YET VERIFIED**.

Tree: `git4agents/combined` `4a8c4cc7b521688f839f0f332605dcefa3984c38`. Local evidence is the LF archive suite on 2026-10-06: 296 tests passed, slice OK, head-move OK, benchmark `zero_tolerance_ok: true`. None of this was re-run on Cloudflare.

`docs/SECURITY.md` is the longer note. This file is the competition map. It does not replace the frozen threat model. The composition rule is `specs/amendments/composition-result-v1.md`. The frozen files were not edited.

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

The gate is armed only when the control plane records the composition. See the residual in `docs/COMPETITION_FINALIZATION.md`.

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
| 14 | Unresolved conflict | `UNRESOLVED_CONFLICT` after the control plane records it. |
| 15 | Rebase conflict | Rebase report escalates. Container tests in the LF suite. |
| 16 | Old evidence on a new SHA | Seam hash mismatch. A rebased SHA needs a new permit. A contributing SHA is refused after RESOLVED. |
| 17 | Destination moves during promotion | Same as row 9. The container fast-forward refuses a missing ancestor. |
| 18 | Candidate pushes the canonical repo | Fork token is for the fork. `executeEffects` does not perform `canonical_write`. |

Rows 11 and 18 are **NOT YET VERIFIED** against a live Queue or a live Artifacts credential. The local fakes and local git are what passed.
