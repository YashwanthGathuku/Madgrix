# Live run results — with Madgrix vs without

**Date:** 2026-10-14 · **Branch:** `grok/final-live` · **Worker:** `madgrix.ygathuku96.workers.dev`
**Baseline repo:** `starter-repo` (real Cloudflare Artifacts repository, `default` namespace)

This document compares the governed pipeline against the same work done as
plain git. Both ran against real Artifacts repositories on the same account,
on the same day.

---

## The comparison

Same code changes in both cases: an API handler (`src/api/handler.js`), a UI
view (`src/ui/view.js`), and per-agent run records — produced by two
concurrent scripted sub-agents under one parent coordinator and combined into one
contender commit.

### WITHOUT Madgrix — raw git (measured 2026-10-14)

| Step | Time |
|---|---|
| Create fork repository (import fallback; the fork endpoint was 400ing) | 3.6s |
| Clone | 1.3s |
| Push baseline into fork | 1.3s |
| Two agent commits | 0.0s |
| Combine (octopus merge) | 0.1s |
| Push combined | 1.3s |
| **Total machine time** | **~7.6s** |

What you get: a merged commit on a branch. What you do **not** get: any
record of why the work began, any check that the agents stayed in scope,
any independent evaluation, any verdict, any binding between the reviewed
state and the shipped state, any signature, any audit trail. In practice
this path continues with **human code review** — the stage research shows
is the bottleneck (PR review time +91% to +441% under AI adoption; 61% of
agent PRs receiving no review at all).

### WITH Madgrix — governed pipeline (measured 2026-10-14, run 3)

| Step | What happens |
|---|---|
| 1/9 | Task frozen: intent, baseline, path scope — immutable from here |
| 2/9 | Verifiers commit blind reference reports before candidates exist |
| 3/9 | Parent forks once; sub-agents commit concurrently in declared scopes; combined into one SHA |
| 4/9 | Real push events travel Queue → TaskAuthority (at-least-once, deduped) |
| 5/9 | Independent evaluation domain (read-only credential): hidden tests, regressions, static, security, provenance |
| 6/9 | Blind reveal + signed verdicts; TheUstad frozen-baseline/clean-parent gate: **FINAL VERIFIED** |
| 7/9 | Verdict Seam issues one exact-state permit (candidate + baseline + tree digest + bundle hash + policy + destination head) |
| 8/9 | Promotion container fast-forwards canonical main to the reviewed SHA — no new commit |
| 9/9 | Authority-signed bundle fetched and verified offline: all checks `OK`, `VERIFIED` |
| **Total wall time** | **~30 min, zero human intervention** |

Most of the 30 minutes is automated waiting: queue delivery windows,
evaluation runs, and promotion-workflow polling. No human was in the loop at
any step.

---

## What the overhead buys

| Without Madgrix | With Madgrix |
|---|---|
| Anyone can push anywhere with a shared credential | Per-agent scoped credentials; sub-agents never hold the canonical write |
| Scope is a convention | Scope is enforced: attempt 1 today was **rejected** because the claim missed `.madgrix/**` — the gate worked, the claim was fixed, attempt 2 passed |
| Review is a human reading a diff | Blind verifiers commit references before seeing candidates; invalid reveal = inadmissible |
| The merged SHA is whatever git produced | The permit binds the exact tree digest, evaluation hash, policy, and destination head; a moved destination voids the permit |
| Trust me, it was reviewed | Signed DSSE bundle, verifiable offline against a pinned key with no network |
| History says what changed | History says why: intent, alternatives, evidence, verdict — all recorded |

## The four live runs

| Run | Date | Task | Promoted SHA | TheUstad | Bundle |
|---|---|---|---|---|---|
| 1 | 2026-10-13 | `task_0090714a…` | `3b71d3a` | FINAL VERIFIED | VERIFIED |
| 2 | 2026-10-14 | `task_6cdb2087…` | `fc9c1e7` | FINAL VERIFIED | VERIFIED |
| 3 | 2026-10-14 | `task_735cca4a…` | `b3ee4c86` | FINAL VERIFIED | VERIFIED |
| 4 | 2026-10-14 | `task_79b1f9d6…` | `d55332b5` | FINAL VERIFIED | VERIFIED |

Each run promoted onto `starter-repo` main; each run's baseline was the
previous run's promotion. The authorized SHA and the shipped SHA were
identical in all four runs (independently confirmed via `git ls-remote`
against the Artifacts remote).

## Honest limits

- Four runs are evidence, not a statistic.
- The demo sub-agents run scripted commands, not language models. What is
  demonstrated is coordination and enforcement, not agent intelligence.
- The ~30 min is wall time dominated by queue/evaluation polling, not
  compute. It parallelizes: the human alternative (review) does not.
- The without-Madgrix timing is machine time only. Its true cost is the
  human review that follows — unmeasured here, and the known bottleneck.

---

*Run 4 is the recorded competition source run; the final narrated submission video is produced separately from that evidence.*
