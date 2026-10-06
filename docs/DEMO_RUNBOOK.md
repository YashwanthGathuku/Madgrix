# Demo runbook

Status words for this integration: **TESTED ON FINAL SHA LOCALLY**, **TESTED ON CLOUDFLARE**, **NOT VERIFIED**.

This runbook describes `competition/final`. The command log is `docs/FINAL_INTEGRATION_REPORT.md`. `npm run live:e2e` was not executed. The live command, the queue, and the deploy boundary are in `docs/CLOUDFLARE_LIVE_READINESS.md`. That note records the readiness session at `424b2b15425a65a25a230e949dea0f4d94192d9e`. It is not a Cloudflare run of this tree.

## What the local fixture does

**TESTED ON FINAL SHA LOCALLY** as part of the Linux Node 24 suite named in the integration report, including `test/demo-composition.test.ts`. That is not a Cloudflare run. The steps below are what that test exercises.

`configs/demo-composition.json` has three sub-agents on one parent fork:

- `sub-api` writes `src/api/handler.js` and `src/contract.js` (`label = "api"`).
- `sub-ui` writes `src/ui/view.js` and `src/contract.js` (`label = "ui"`).
- `sub-test` writes `test/integration/check.js` only. Its command does not receive `CONTROL_SERVICE_TOKEN` or `EVALUATION_SERVICE_TOKEN`.

The test runs the three commands in separate git worktrees at the same time. A stamp file shows each start before any end. The contract lines overlap, so the result is **CONFLICTED**: no candidate commit, `HEAD` stays on the baseline, and the conflict names the baseline, the agents, the path `src/contract.js`, the classification `textual-line-overlap`, and the two side bodies.

`scripts/demo-resolve.mjs` copies each agent's non-overlapping files and writes `export const label = "api+ui"`. If `CONTROL_SERVICE_TOKEN`, `EVALUATION_SERVICE_TOKEN`, `AGENT_SERVICE_TOKEN`, or `AUTHORITY_SIGNING_KEY` is set in its environment, it exits 1. The test sets `CONTROL_SERVICE_TOKEN` and observes that exit. The production resolver spawn does not pass those names.

The resolved commit is a new SHA. It is not one of the three contributing SHAs. The test records that SHA on a local authority and `submitEvaluation` of a contributing SHA throws.

## What the local fixture does not do

- It does not run the resolved tree's tests. The admission flags in other authority tests are harness flags.
- It does not issue a permit or fast-forward a canonical repo for this demo SHA.
- It does not call TheUstad on the resolved tree. TheUstad runs on the baseline before combine, as in the fork-crew tests.
- It does not talk to Cloudflare.

On the tested final tree, `npm run slice` printed `SLICE OK` and the harness word `VERIFIED` for its own bundle and pinned key. `npm run headmove` printed `HEAD-MOVE OK`. Those harnesses are not a run of `configs/demo-composition.json`, and the harness word `VERIFIED` is not a Cloudflare result and not a semantic check of the demo candidate. TheUstad remains a frozen-baseline and clean-worktree check before combine.

## Local commands

From a checkout whose shell scripts are LF (WSL `git archive`, or Ubuntu CI). On this Windows tree, `core.autocrlf=true` makes `bash` reject `container/*.sh`.

```
export PATH="$HOME/node24/bin:/usr/bin:/bin"
node --test test/demo-composition.test.ts test/fork-crew.test.ts test/composition-authority.test.ts
```

Node >= 24 is required. Node 22.17 does not strip TypeScript types unless `NODE_OPTIONS=--experimental-strip-types` is set for the parent and every child. Node 22 is not the competition suite.

## Live path

`scripts/live-e2e.ts` is **NOT VERIFIED** against Cloudflare.

When it is run, the operator supplies the deployed base URL and the zone tokens in the parent process. The parent posts composition with `MADGRIX_CONTROL_SERVICE_TOKEN`. The fork-crew child receives the agent token only. A CONFLICTED result is posted, then evaluation and promotion are refused. A resolved or composed SHA is posted, then the existing evaluation, verdict, promotion, and offline verify steps run. Do not put a service token in the resolver environment.

The local demo test calls `loadForkCrew` and `runCrewOnFork` directly. It does not call `fleet validate`. The live runner does. `configs/git4agents-demo-composition.yaml` is the manifest for `configs/demo-composition.json`. Its agents are `parent`, `sub-api`, `sub-ui`, `sub-test`, in that order. `scripts/run-fork-crew.mjs` selects that manifest when `MADGRIX_FORK_CREW_CONFIG` points at the demo JSON and `MADGRIX_FLEET_CONFIG` is unset. `configs/git4agents-fork-crew.yaml` remains the three-id roster (`parent`, `sub-api`, `sub-ui`) and is not the demo manifest.

MADGRIX checks that manifest itself: ids, roles, and bounded paths. `fleet validate` runs only when `MADGRIX_FLEET_BIN` is set, and then only as a roster cross-check. It does not execute the sub-agents. The default suite does not fail because an older fleet omits `summary.agent_ids`. On the readiness session, `fleet 0.3.0` validate of the three-agent `configs/git4agents-fork-crew.yaml` returned `is_valid: true` and `summary.total_agents: 3`, and `summary` had no `agent_ids`. That observation belongs to that session and that manifest. The sibling contender swarm still needs Agentfleet `summary.agent_ids` or `MADGRIX_AGENT_IDS`. A live run of the demo JSON is **NOT VERIFIED**.

The sibling live command that does not call `fleet` sets `MADGRIX_AGENT_IDS`. It is written in `docs/CLOUDFLARE_LIVE_READINESS.md`. It was not run. Success still requires a real Artifacts push through the queue. A green local test is not that result.

On 2026-10-06 the readiness session observed `GET https://madgrix.ygathuku96.workers.dev/` → `404` `{"error":"not_found","path":"/"}`. That response does not name a SHA. It is **NOT VERIFIED** as a result for this tree. Nothing here is **TESTED ON CLOUDFLARE**.
