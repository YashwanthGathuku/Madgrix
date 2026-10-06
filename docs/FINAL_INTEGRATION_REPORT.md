# Final integration report

Status words: **TESTED ON FINAL SHA LOCALLY**, **TESTED ON CLOUDFLARE**, **NOT VERIFIED**.

This file is documentation. The commands below ran on the parent of the commit that adds it:

`4ed4e7ab0af5a6beb7200957c0ccc17db4a3b3c1`

That parent is the tested tree. This commit does not change runtime code. Nothing here was run on Cloudflare. This report does not say the tree is production-ready, end-to-end verified, or independently verified.

## SHAs

| Item | SHA |
|---|---|
| Repository | https://github.com/YashwanthGathuku/Madgrix |
| Branch | `competition/final` |
| Base, already present | `competition/security` `9670893f36a986a59d153de4fbbf3ef10f1d9687` |
| Tested tree | `4ed4e7ab0af5a6beb7200957c0ccc17db4a3b3c1` |
| Not merged | `main` |
| Not pushed | `competition/final` |

Source commits incorporated, by cherry-pick `-x` unless noted:

| Source | On this branch |
|---|---|
| `49e53c3205ceccebeb4ae84df84ecd591e966bc2` collaboration implementation | `b067f5b40bc3c38d526b1952e2badb9a2471307c` |
| `99adfa9d89ee42536667bfb8e618e4a9af92374e` Cloudflare readiness | `1a5d50637fe224aa8b8a7c2b8f2339db3f3d74bf` |
| `7bad8e787c8e7922efdacedf4d308e1da2ba6b6b` demo page | `8cb1079059e3d6c6db9bae688342c60017c7d396` |
| `664beddbdf2e7d04ddf4e7c5d28b37855d93e539` promotable candidate | `9944c0532e6ec5c9605d11e01ea423c0fd9e6876` |
| One WorkGraph object. Not a cherry-pick. | `3ca9e9dd87bec8b64fe0db41c3dcbecf3fbcd5a2` |
| Demo roster check. Not a cherry-pick. | `9cecd6a7de14116bc8ec211e1928f8a62f200281` |
| Typecheck assertion order. Not a cherry-pick. | `4ed4e7ab0af5a6beb7200957c0ccc17db4a3b3c1` |

`16dbd7565966aa4160c0762a2a2eeb4e4a4e1378` was not cherry-picked. It records that collaboration `49e53c3` was pushed to `origin/competition/collaboration`. That source branch was not merged to `main` and was not run on Cloudflare. This integration was not pushed.

`origin/competition/collaboration` tip remains `16dbd756`. The implementation used here is `49e53c3`.

## Conflict resolutions

No conflicted file was taken with `-X ours` or `-X theirs`. No conflict was left unresolved.

`49e53c3` conflicted only in `docs/KNOWN_LIMITATIONS.md`. The resolution keeps the 296-test record on `4a8c4cc` and the 300-test record on `49e53c3`, and it keeps the security scan note. Neither count is this integration. These auto-merged and were reviewed before the commit:

- `src/lib/types.ts` keeps `merge_artifact_scan` and the CrewContender / composition types.
- `src/lib/task-state.ts` keeps scan refusal and `compositionBlocks`. Only `COMPOSED` and `RESOLVED` pass, and a contributing SHA does not.
- `src/worker/index.ts` keeps the scan refusal before a write token, and the context and graph routes.

`99adfa9` conflicted only in `docs/DEMO_RUNBOOK.md` (the fleet paragraph). Readiness prose that said no manifest lists `parent`, `sub-api`, `sub-ui`, and `sub-test` was true of parent `424b2b1` and false after the collaboration commit. The banner on `docs/CLOUDFLARE_LIVE_READINESS.md` says that. Status words from that session were not copied forward as results for this SHA.

`7bad8e7` conflicted in `src/worker/index.ts` and `test/composition-authority.test.ts`. The route keeps `buildWorkGraph` for JSON and calls `renderWorkGraphPage` for HTML. The inline HTML from the security branch was not restored. The test keeps the JSON assertions and the demo HTML assertions. `scripts/lib/fork-crew.mjs` and `test/demo-composition.test.ts` auto-merged: demo manifest pairing stayed, and the TheUstad baseline command uses forward slashes.

`664bedd` conflicted only in the `handleWorkGraph` comment. The page does not restore a green / amber / red legend.

`3ca9e9d` then removed the page's own candidate decision. `pageView` formats the `WorkGraph` it is given. `GET /tasks/:id/graph?format=json` and `GET /tasks/:id/graph` build one object. The HTML renderer receives that object. A promotable SHA is present only for `COMPOSED` and `RESOLVED`, and only when that SHA is not a contributing or member SHA.

`9cecd6a` changes `scripts/lib/fork-crew.mjs` and `test/fleet-manifest.test.ts`. `scripts/lib/agentfleet-slots.mjs` was not changed.

`4ed4e7a` only reorders two assertions in `test/unresolved-merge-artifact.test.ts`. `assert.deepEqual(..., [])` had narrowed `effects` to an empty tuple, so the later `.kind` check did not typecheck. Both assertions remain. No promotion outcome changed.

## What the tree keeps

`merge_artifact_scan` is mandatory evaluation evidence: `status` `COMPLETE`, `scanner` `madgrix-merge-artifact/v1`, `candidate_sha`, `tree_sha256`, and `paths`. A missing, malformed, unsupported, or mis-bound scan is ineligible: no ACCEPT, no permit, no canonical write. Non-empty paths fail `no_unresolved_merge_artifacts` and are rejected. A legacy `unresolved_merge_artifacts` list, when present, has to agree with the scan. `container/promote.sh` still scans fetched blobs and can return `UNRESOLVED_CONFLICT` before fast-forward. That path does not consume the permit and does not move canonical HEAD.

A trusted evaluator can submit `COMPLETE` with `paths: []` for a tree that contains markers. The authority may permit that statement. The container is the check that reads the blobs. An empty path list is not proof the tree is clean.

Credential isolation, per-agent identity binding, evidence binding, evaluator-config binding, quarantine, replay protection, destination-head checks, and pinned authority verification remain. A rebase produces a new SHA and needs a new evaluation.

A CrewContender carries the parent, members, member intents, member scopes, claim ids, member commit SHAs, the baseline, the composition state, and a candidate SHA only when that state may expose one. `PENDING`, `COMPOSING`, `CONFLICTED`, and `RESOLVING` do not. `COMPOSED` and `RESOLVED` may. A member SHA is not the candidate. `RESOLVED` uses a new SHA and still needs an evaluation, a verdict, and a permit.

The demo page shows `PROMOTABLE CANDIDATE: NONE` for `CONFLICTED`. For `RESOLVED` it separates member contribution SHAs from the new candidate. Offline verification on the page is the literal string `Not run` until a real offline verification result exists. The page does not invent gate colors, evaluation passes, Cloudflare events, agent activity, or metrics. A stored risk word can be shown as stored authority data. Fixture input is labeled only when the caller passes the fixture banner. The worker route does not pass that banner.

TheUstad checks that HEAD is the frozen baseline and the worktree is clean before combine. It does not score the candidate.

## Fleet

The competition demo manifest is `configs/git4agents-demo-composition.yaml`, paired with `configs/demo-composition.json`. MADGRIX checks that the crew is `parent`, `sub-api`, `sub-ui`, `sub-test`, in that order, with bounded paths. `configs/git4agents-fork-crew.yaml` remains the three-id roster and is not the demo manifest.

`fleet validate` runs only when `MADGRIX_FLEET_BIN` is a non-empty string. It is a roster cross-check. It does not execute the sub-agents. The default suite does not need `summary.agent_ids`.

The sibling contender swarm still does. `configs/git4agents-contenders.yaml` and the non-fork path in `scripts/live-e2e.ts` still need Agentfleet `summary.agent_ids` or `MADGRIX_AGENT_IDS`. That dependency was not redesigned.

## Commands

Supported suite: Linux or WSL2, Node >= 24, LF files.

Host for the suite: WSL Ubuntu-24.04, Node v24.21.0 at `/home/gathu/node24/bin/node`. The tree was `git -c core.autocrlf=false -c core.eol=lf archive` of `4ed4e7a`, extracted at `/home/gathu/madgrix-final`. `container/promote.sh` matched blob `b8dca733b98dc1ae489e08de09c88c68513c6f71`, CR count 0. A plain `git archive` on this Windows Git rewrote the export to CRLF. That copy was not used. `MADGRIX_FLEET_BIN` was unset.

| Command | Result |
|---|---|
| `npm ci` | exit 0. 60 packages. `workerd@1.20260930.2` install script was not approved. npm reported 5 high severity findings. Not investigated. Not audit-fixed. |
| `npx tsc --noEmit` | exit 0 |
| `npx tsc --noEmit -p tsconfig.node.json` | exit 0 after `4ed4e7a`. Before that commit the same command failed with TS2339 at `test/unresolved-merge-artifact.test.ts` lines 360 and 544. |
| `npm test` | **331 pass, 0 fail, 102 suites, 0 skipped.** `duration_ms` 12916.135174. Exit 0. |
| `npm run slice` | exit 0. Printed `SLICE OK`. The harness also printed `VERIFIED` for its own bundle and pinned key. That word is the harness output. It is not a Cloudflare result and not a semantic check of the demo candidate. |
| `npm run headmove` | exit 0. Printed `HEAD-MOVE OK`. |
| `npm run bench` | exit 0. `zero_tolerance_ok: true`. The softer stratum is `N/A`, synthetic, as-measured: precision 1.000, recall 0.667, FPR 0.000 over 30 pairs. |
| Named `node --test` list below | **184 pass, 0 fail, 65 suites.** `duration_ms` 10296.229869. Exit 0. |

The named list was: `unresolved-merge-artifact`, `promotion-fixtures`, `promotion-container`, `promotion-workflow`, `fork-crew`, `fleet-manifest`, `composition-authority`, `work-graph-page`, `demo-composition`, `env-isolation`, `evaluator-isolation`, `evidence-auth`, `verdict-seam`, `promotion-attacks`, `rebase-ancestry`, `rebase-route`.

`rebase: conflict paths are data (a space, a newline, non-ASCII)` passed for Linux bash and for the TypeScript model. That is the newline-in-filename rebase row.

`npm run live:e2e` was not run.

Older counts stay on their SHAs. 296 is `4a8c4cc`. 300 is the LF copy of `49e53c3`. They are not this run.

## Image build

`npm run build` is `cf build`. It writes the Worker bundle and then asks Docker to build `container/Dockerfile`.

The attempts below failed. A later retry on an LF archive of `d45a7296613f629bdf26af28c8b959d166c8c68f` produced a local image. That image was not started and not deployed. `container/` is the same in the commit that records this paragraph.

### Failed attempts on 2026-10-06

1. From WSL Node 24, `WRANGLER_DOCKER_BIN` pointed at Windows `docker.exe`. The context argument was the Linux path `/home/gathu/madgrix-final/container`. The buildx `docker-container` builder stayed inactive on `pulling image moby/buildkit:buildx-stable-1`. That process was killed. It did not produce an image.
2. From Windows Node v22.17.0, without type stripping, `cf build` failed before Docker: `ERR_UNKNOWN_FILE_EXTENSION` for `cloudflare.config.ts`.
3. From an LF copy at `C:\Users\Gathu\AppData\Local\Temp\madgrix-lf` (`promote.sh` CR count 0), Windows Node v22.17.0 with `NODE_OPTIONS=--experimental-strip-types`. Vite wrote `.cloudflare/output/v0/workers/default/bundle/index.js` at 229.27 kB. Docker then pulled `debian:trixie-slim` and stopped at 28.31 MB of 29.84 MB. The build ended `BUILD_EXIT:1` with `rpc error: code = Unavailable desc = error reading from server: EOF`. The engine pipe `dockerDesktopLinuxEngine` was gone afterward.
4. Docker Desktop was started again. `docker info` printed `ver=29.8.2`. The pipe was gone again before the image step. `cf build` exited 1: the Docker CLI could not be launched. The same Worker bundle was written again. No image was tagged.

The first `docker info` in the session printed server `6.1.0`, operating system `fedora`, driver `overlay`. After a restart it printed Docker Desktop `29.8.2`. Those failed attempts did not leave an image.

### Retry that produced an image

`docker info` printed `ver=29.8.2`, `os=Docker Desktop`, `driver=overlayfs`. The tree was an LF archive of `d45a7296613f629bdf26af28c8b959d166c8c68f` at `C:\Users\Gathu\AppData\Local\Temp\madgrix-lf`. `container/promote.sh` had CR count 0. The CLI was Windows Node v22.17.0 with `NODE_OPTIONS=--experimental-strip-types`, because that Node does not strip TypeScript by default and the Windows Docker client needs a Windows context path. The suite above remains the WSL Node v24.21.0 run.

`npm run build` exited 0 (`BUILD_EXIT:0`). Vite wrote `.cloudflare/output/v0/workers/default/bundle/index.js` at 229.27 kB. BuildKit used the `desktop-linux` docker driver. It pulled `debian:trixie-slim` and installed the image packages. The log ended with:

`naming to docker.io/cloudflare-build/0e7aaa6dd861/madgrix-promotion:63f515387052`

`docker image inspect` of that tag reported id `sha256:e39ad5e3cf0ca5ac02743156e51884ee1eb036cccdb3bd01132ebda3b07f84f6`, created `2026-10-06T21:07:17.8687873Z`, size `263543467` bytes. The image was not started. It was not pushed to a registry. It was not deployed. That is a local Docker build of the archive named above. It is not **TESTED ON CLOUDFLARE**.

## Priorities

| Level | Item |
|---|---|
| P0 | None observed in the local suite on `4ed4e7a`. |
| P1 | A trusted evaluator can submit `COMPLETE` and `paths: []` for a tree that contains markers. The authority may permit that statement. `container/promote.sh` refuses the write, leaves the permit unconsumed, and leaves canonical HEAD unchanged. |
| P1 | No command on this SHA was run on Cloudflare. `live:e2e` was not run. The public worker 404 from the readiness session does not name a SHA. |
| P2 | The local image exists and was not started. Promotion-container behavior on Cloudflare is **NOT VERIFIED**. |
| P2 | The sibling contender swarm still needs Agentfleet `summary.agent_ids` or `MADGRIX_AGENT_IDS`. |
| P2 | Sub-agents share one machine. An empty republish is a new SHA and needs its own evaluation. TheUstad does not score the candidate. |
| P2 | npm reported 5 high severity findings. Not investigated. |
| P2 | CI does not run on `competition/final`. |

## Cloudflare

**NOT VERIFIED.** No deploy. No queue create. No Artifact write. No paid resource. No force-push. No push of `competition/final`.

## Next step before a Cloudflare deploy

The owner reviews this branch and this report, then explicitly authorizes a push of `competition/final`. The local image exists and was not started. A deploy still waits on `cf` login and on the owner's decision to provision anything named in `docs/CLOUDFLARE_LIVE_READINESS.md`. Do not deploy from this report.
