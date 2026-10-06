# Demo runbook

Status words: **IMPLEMENTED**, **TESTED LOCALLY**, **TESTED ON CLOUDFLARE**, **NOT YET VERIFIED**.

The fixture section matches `git4agents/combined` at `4a8c4cc7b521688f839f0f332605dcefa3984c38`. The live-path fleet paragraph matches `competition/collaboration` at `49e53c3205ceccebeb4ae84df84ecd591e966bc2`, which is on `origin` (https://github.com/YashwanthGathuku/Madgrix). It does not describe a Cloudflare run. `npm run live:e2e` was not executed for either SHA. That commit was not merged to `main`.

## What the local fixture does

**IMPLEMENTED. TESTED LOCALLY** by `node --test test/demo-composition.test.ts` (1 pass, WSL Node v24.21.0, 2026-10-06).

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

The promotion path that is **TESTED LOCALLY** is the existing slice and head-move harnesses, on other fixtures:

- `node src/harness/slice.ts` printed `SLICE OK` and `VERIFIED` for its own bundle.
- `node src/harness/head-move.ts` printed `HEAD-MOVE OK`.

Those are not a run of `configs/demo-composition.json`.

## Local commands

From a checkout whose shell scripts are LF (WSL `git archive`, or Ubuntu CI). On this Windows tree, `core.autocrlf=true` makes `bash` reject `container/*.sh`.

```
export PATH="$HOME/node24/bin:/usr/bin:/bin"
node --test test/demo-composition.test.ts test/fork-crew.test.ts test/composition-authority.test.ts
```

Node 24 is required. Node 22.17 does not strip TypeScript types unless `NODE_OPTIONS=--experimental-strip-types` is set for the parent and every child.

## Live path, not run

`scripts/live-e2e.ts` is **IMPLEMENTED** and **NOT YET VERIFIED** against Cloudflare for this SHA.

When it is run, the operator supplies the deployed base URL and the zone tokens in the parent process. The parent posts composition with `MADGRIX_CONTROL_SERVICE_TOKEN`. The fork-crew child receives the agent token only. A CONFLICTED result is posted, then evaluation and promotion are refused. A resolved or composed SHA is posted, then the existing evaluation, verdict, promotion, and offline verify steps run. Do not put a service token in the resolver environment.

The local demo test calls `loadForkCrew` and `runCrewOnFork` directly. It does not call `fleet validate`. The live runner does. `configs/git4agents-demo-composition.yaml` is the manifest for `configs/demo-composition.json`. Its agents are `parent`, `sub-api`, `sub-ui`, `sub-test`, in that order. `scripts/run-fork-crew.mjs` selects that manifest when `MADGRIX_FORK_CREW_CONFIG` points at the demo JSON and `MADGRIX_FLEET_CONFIG` is unset. `configs/git4agents-fork-crew.yaml` remains the two-sub-agent roster. `node --test test/fleet-manifest.test.ts` runs `fleet validate --config <manifest> --json` and reads `summary.agent_ids`. That command needs Agentfleet `paper-hardening` `49032db` or newer (`MADGRIX_FLEET_BIN` when the `fleet` on PATH is older). It was not run on Cloudflare.

Do not treat a green local test as a live Artifact, Queue, Workflow, or Container result.
