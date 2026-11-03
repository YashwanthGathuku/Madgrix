# g4a gap status (grok/g4a-gaps, PR #17)

| gap | status |
|---|---|
| 1 parallel batch landing | done: file-disjoint jobs land in one witnessed batch (batch.test, batch2.test edge cases) |
| 2 ForgeMark vs a g4a-fronted remote | partial: local ForgeMark-shaped harness `bench/race.mjs`, method + numbers in bench/FORGEMARK.md: governed landing 1.73 → 2.86 ops/s (user) and 2.66–2.71 (system, verify ok); raw scope-checked branch push 16.5–16.8 ops/s (`g4a-push`), 16 agents, 0 errors. Real ForgeMark is refused by design (push options, refs/forgemark/*); not run. |
| 3 no operator sudo, no API keys to agents | done: root-owned `g4a-admin` narrowed sudo (operator forced to SUDO_USER); local credential proxy (system mode) |
| 4 close bypasses | done for PATH (`install --login`, idempotent, reversible), land-time tamper audit, daemon watcher, refused+ledgered out-of-claim landings. Same-user mode remains detect-only: a same-uid process can read keys; use `--system`. |
| 5 dir/ claim bug, npm audit, merge #10-#16 | dir/ fixed (trailing slash = dir/**). npm audit: not cleared in this branch (needs network + dependency bumps reviewed by you). Merging PRs is not allowed for this agent; you merge. |
| 6 opt-in intent/session capture, search, review UI, eval hook | done (all off by default, outside the trust path): `G4A_CAPTURE=1` redacted local sessions, `g4a search`, `g4a review` (static escaped HTML), advisory `G4A_EVAL_HOOK` that never gates landing (gap6.test) |
| 7 license, multi-host sync | license is your choice (not chosen here). Multi-host: today only the anchor chain can be pushed to a fast-forward-only remote (G4A_ANCHOR_REMOTE); full multi-host authority sync is not built. |

Also done on this branch: an authority server in both modes (system mode checks peer uid with SO_PEERCRED), `g4a authority serve`/`g4a stop`, auto-sync of main before a claim, witness cache, adaptive batch. Full offline suite (no network namespace): 112/112.
