# Cloudflare architecture

Status words: **IMPLEMENTED**, **TESTED LOCALLY**, **TESTED ON CLOUDFLARE**, **NOT YET VERIFIED**.

Source of the bindings: `cloudflare.config.ts` at `4a8c4cc7b521688f839f0f332605dcefa3984c38`. This file describes that config. It does not describe a deployment of this SHA.

## Bindings in the config

| Binding | Config | Role in this tree |
|---|---|---|
| Worker `madgrix` | `src/worker/index.ts`, compatibility date `2026-10-01` | HTTP routes and the queue consumer. |
| `ARTIFACTS` | `bindings.artifacts({ namespace: "default" })` | Git-compatible repos. Forks and the canonical repo. The config comment says local `dev: { remote: true }` cannot reach Artifacts through the sandbox proxy. |
| `TASK_AUTHORITY` | Durable Object, sqlite, class `TaskAuthority` | One object per task. Claims, composition, evidence, verdicts, permits. |
| `PROMOTION_CONTAINER` | Durable Object bound to container `madgrix-promotion` | Runs `container/promote.sh` and `container/rebase.sh`. |
| Container image | `container/Dockerfile`, instance type `lite`, `maxInstances: 4` | The promotion and rebase scripts. |
| `PROMOTION_WORKFLOW` | Workflow `madgrix-promotion`, class `PromotionWorkflow`, step limit 8 | One instance per permit id. |
| Queue trigger | `madgrix-events`, batch 10, timeout 30s | `cf.artifacts.repo.pushed` events. Delivery is at-least-once and unordered. |
| Secrets | `EVALUATION_SERVICE_TOKEN`, `CONTROL_SERVICE_TOKEN`, `AGENT_SERVICE_TOKEN`, `AUTHORITY_SIGNING_KEY` | Zone bearers and the signing key. Not placed in agent or resolver env by the runners. |

`npm run build` (`cf build`) was not re-run after these commits. At the baseline SHA, the worker bundle was produced and the image step failed because the Docker CLI was not installed. The container image for `4a8c4cc` is **NOT YET VERIFIED**.

## What the local suite substitutes

**TESTED LOCALLY** means `FakeArtifacts`, in-memory Durable Object storage, `FakeWorkflow`, and the fake container in `src/harness/fake-container.ts`, except tests that execute `container/promote.sh` and `container/rebase.sh` with local git. Those script tests passed in the LF archive (296 tests, 0 fail). They are not a Container instance on Cloudflare.

The slice harness's `VERIFIED` line is a local bundle signed by the harness key. It is not a bundle fetched from the deployed Worker.

## What has been seen on the public hostname

On 2026-10-06, unauthenticated `GET https://madgrix.ygathuku96.workers.dev/` returned `{"error":"not_found","path":"/"}`. That does not identify the deployed SHA. **NOT YET VERIFIED** as this commit.

No Queue consumer, Workflow instance, Container, or Artifact write was invoked against the account in this work. Do not create `madgrix-events` or deploy without an explicit owner request. The config comment says that queue must exist before a deploy.

## Artifacts calls the code actually uses

The adapter does not call a `getHead` method. Tips are read with `ArtifactsRepo.log()`. Baseline presence is `readCommit`. `fork()` may fall back to `container/copy-baseline.sh` on the known 10101 error. A new push subscription can drop the first push; `scripts/run-fork-crew.mjs` waits 30 seconds after creating one, then may push an empty commit if the authority has not observed the SHA. That empty commit is a new SHA and needs its own evaluation. This wait is **IMPLEMENTED** in the script and **NOT TESTED ON CLOUDFLARE** for this SHA.
