# Scale: how many agents can one Git4agents task coordinate?

Measured 2026-10-14 (ET) with `scripts/scale-agents.mjs`. Every number here was
measured; raw results are in `docs/scale-results/`. **live** = the deployed
`madgrix` Worker on workers.dev (version `ae4e1616`, deployed from this branch:
`grok/final-showcase` c043107 + the conflict-report fix below). **local** = the
same pure state machine (`src/lib/task-state.ts`) in-process, no Workers runtime.

## What one scripted agent does

1. Is enrolled at task freeze (`POST /tasks`, `agent_ids`) and gets its own secret.
2. Claims a distinct path with its intent (`POST /tasks/:id/claim`, `X-Madgrix-Agent-Secret`).
   Every 20th agent also claims its neighbour's path (seeded overlap).
3. After the run, the task ledger (`GET /tasks/:id/ledger`) is fetched and its
   hash chain verified with `verifyLedgerChain`; the count of `claim_registered`
   entries must equal the claims granted.

None of these steps creates an Artifacts fork (`forks_created: 0` in every run).
Submitting commits does need a contender fork. At scale that is the fork-crew
shape: many sub-agents commit on **one** parent fork (`scripts/run-fork-crew.mjs`),
so forks grow with crews, not with agents. The scale test does not push commits per agent.

**Conflicts are flagged, not refused.** The authority records every claim and
reports overlaps (risk + explanation) to the claimant; it does not reject an
overlapping claim. "Flagged" below = the overlapping agent's claim response
named the neighbour's `work_id` with a `path overlap` finding.

## Results: one task, N agents, concurrency 25

| N | mode | claims granted | seeded overlaps flagged | false overlap flags | p50 ms | p95 ms | claims/s | ledger chain + count |
|---|---|---|---|---|---|---|---|---|
| 10 | live | 10/10 (100%) | 0/0 | 0 | 140 | 166 | 59 | OK |
| 100 | live | 100/100 (100%) | 4/4 | 0 | 106 | 216 | 104 | OK |
| 500 | live | 500/500 (100%) | 24/24 | 0 | 176 | 375 | 116 | OK |
| 1,000 | live | 1,000/1,000 (100%) | 49/49 | 0 | 291 | 658 | 75 | OK |
| 2,000 | live | 2,000/2,000 (100%) | 99/99 | 0 | 593 | 1,447 | 37 | OK |
| 3,000 | live | 3,000/3,000 (100%) | 149/149 | 0 | 827 | 2,407 | 23 | OK |
| 5,000 | live | 4,997/5,000 (99.94%) | 249/249 | 0 | 1,829 | 4,849 | 12 | OK (4,997 entries = 4,997 granted) |

The 3 failures at N=5,000 were client-side `UND_ERR_SOCKET` (connection reset seen
by Node fetch), not authority refusals. No HTTP 429 was seen at any N.

### Before the fix (live, previous deployment, same script)

| N | claims granted | overlaps flagged | p50 ms | p95 ms |
|---|---|---|---|---|
| 10 | 10/10 | 0/0 | 163 | 180 |
| 100 | 100/100 | 4/4 | 388 | 1,129 |
| 200 | 192/200 (96%) | 1/9 | 1,025 | 4,287 |

Ramp stopped at 200 (error rate 4% > 2%). The 8 failures were HTTP 422
`claim_rejected`; the error detail was not captured in that run, so the exact
cause is not proven. The local model below shows the state value passing 2 MiB
at claim ~116 under the old code, which is consistent with a storage failure.

## The cap we found and fixed

`registerClaim` classified the new claim against every live claim and **stored
every pair report**. Without a dependency map every pair is AMBER ("L2 analysis
unavailable"), so storage grew O(n²) in the DO's single `authority-state` value
(local: 4,950 reports and 1.58 MB at N=100). Fix (`src/lib/task-state.ts`,
`isActionableReport`): store and return only reports with a concrete finding
(path, symbol, impact, contract, state) or an amendment; the ledger entry keeps
`pairs_checked`. Storage is now O(n) claims + O(real overlaps) reports
(N=1,000 local: 49 reports stored, 49/49 overlaps flagged).

## Where it scales and where it caps

| Component | Behaviour | Evidence |
|---|---|---|
| TaskAuthority DO (one per task) | Single-threaded; every claim is one transaction that reads and rewrites the whole state value. Claim latency grows ~linearly with N (p50 140 ms at 10 → 1.8 s at 5,000) and throughput falls from ~116 to ~12 claims/s. This, not errors, is the practical ceiling for one task. Separate tasks are separate DOs and do not share this limit (not measured in parallel). | live table |
| DO storage size | State is one value. Local JSON size is ~1 KB per claim (1.0 MB at 1,000; 2.04 MB at 2,000). The local model flags >2 MiB at claim 2,021, but live accepted 5,000 claims, so the live serialized size or limit differs from this JSON model. The real live ceiling is above 5,000 and was not reached. | local.json vs live |
| Path claims | O(n) pair classification per claim, in memory. No false overlap flags at any N. | live table |
| Queue | Only fork pushes produce queue events; claims produce none. Not load-tested here; the big-crew run used one fork → one push subscription. | not measured |
| Artifacts (2,000 req / 10 s / namespace) | Claims make zero Artifacts calls. Forks, tokens and pushes are per contender fork; the fork-crew shape keeps that to one fork per crew. | forks_created 0 |
| Per-fork push subscriptions | One per contender fork. Scales with crews, not agents. | design |
| Container evaluation | One evaluator container run per candidate SHA; a crew composes to one SHA, so 12 sub-agents cost one evaluation. | big-crew run |

## Big-crew live run (real external repo)

`ext-ky` = `sindresorhus/ky` (MIT), imported into Artifacts namespace `default`
via `cf artifacts namespaces repos import`. Parent + 12 sub-agents, one fork, each
sub-agent writes one file in a real ky directory (`source/core`, `source/errors`,
`source/types`, `source/utils`, `source`, `test-d`, `media`, `.github/workflows`, `.github`, root).
Config: `configs/git4agents-fork-crew-big.{json,yaml}`.

- Take 1: task `task_a9f87f3d2cc3a92d1ec9ca4b`, baseline `3541888` (ky main),
  combined SHA `a2315ef00d9f1b34257c9bc2862e4ab22846c9e0`, TheUstad FINAL VERIFIED,
  promoted, offline bundle VERIFIED (`MADGRIX_LIVE_E2E_OK`).
- Take 2 (recorded end to end): task `task_99f82dca34d72b85dc1ee92a`, baseline
  `a2315ef`, combined SHA `d5bcf018194b9797edd80f3655a10b0632cc42d8` from 12 sub-agent
  commits on one fork, TheUstad FINAL VERIFIED, promoted, offline bundle VERIFIED
  (`MADGRIX_LIVE_E2E_OK`). The first combined push was not applied and the
  runner pushed again (logged).
- An earlier attempt (`task_d3e890030e2549d1429dad86`) put two notes under `test/`; the
  evaluator correctly refused it (`security_policy: test material changed`), no promotion.

## Honest claim

One Git4agents task coordinated 3,000 of 3,000 live scripted agents (and 4,997 of
5,000) with every seeded path overlap flagged, zero false flags and an intact
hash-chained ledger, and with no Artifacts fork per agent. The limit is latency
on the task's single Durable Object, not correctness.

Reproduce: `node scripts/scale-agents.mjs --mode live --ramp 10,100,500,1000,2000 --concurrency 25`
(needs MADGRIX_BASE_URL, MADGRIX_CONTROL_SERVICE_TOKEN, MADGRIX_AGENT_SERVICE_TOKEN,
MADGRIX_BASELINE_REPO, MADGRIX_BASELINE_COMMIT) or `--mode local`.
