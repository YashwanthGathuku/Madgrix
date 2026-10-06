# Cloudflare architecture

Status words: **LOCAL VERIFIED**, **CLOUDFLARE VERIFIED**, **NOT VERIFIED**.

The binding source is `cloudflare.config.ts` at `424b2b15425a65a25a230e949dea0f4d94192d9e`. The commands and the type check are in `docs/CLOUDFLARE_LIVE_READINESS.md`. The status words below belong to that readiness session. They are not a deployment of the integrated tree, and they are not **TESTED ON CLOUDFLARE** for this SHA.

## Bindings

Checked against `@cloudflare/config` 0.22.0 and `workerd` 1.20260930.2 installed by `npm ci` in this session. **LOCAL VERIFIED** as a match to those types. **NOT VERIFIED** on the account.

| Binding | Config | Role |
|---|---|---|
| Worker `madgrix` | `src/worker/index.ts`, compatibility date `2026-10-01`, no compatibility flags | HTTP routes and the queue consumer. No fetch route and no custom domain are declared. |
| `ARTIFACTS` | `bindings.artifacts({ namespace: "default", dev: { remote: true } })` | Git repos. The namespace is a name in config. It was not listed. |
| `TASK_AUTHORITY` | Durable Object, sqlite, class `TaskAuthority`, default state `created` | One object per task. |
| `PROMOTION_CONTAINER` | Durable Object, sqlite, class `PromotionContainer`, container `madgrix-promotion` | Runs `container/promote.sh`, `container/rebase.sh`, and `container/copy-baseline.sh`. |
| Container | `container/Dockerfile`, `instanceType: "lite"` (1/16 vCPU, 256 MiB, 2 GB disk), `maxInstances: 4` | Image build needs a running Docker CLI. `npm run build` was not run. **NOT VERIFIED**. |
| `PROMOTION_WORKFLOW` | Workflow `madgrix-promotion`, class `PromotionWorkflow`, step limit 8, success retention 3 days, error retention 7 days | One instance per permit id. |
| Queue trigger | `madgrix-events`, batch 10, timeout 30 seconds. No dead-letter queue. | Consumer of `cf.artifacts.repo.pushed`. The queue's existence is **NOT VERIFIED**. |
| Secrets | `EVALUATION_SERVICE_TOKEN`, `CONTROL_SERVICE_TOKEN`, `AGENT_SERVICE_TOKEN`, `AUTHORITY_SIGNING_KEY` | Declared with `bindings.secret()`. `keys/authority.pub` is absent. **LOCAL VERIFIED**. |

There is no Wrangler migrations array. Both Durable Object classes are `created` sqlite exports. The account's current migration state is **NOT VERIFIED**.

## Local substitutes

The parent record for this SHA is an LF archive: 296 tests passed, `SLICE OK`, `HEAD-MOVE OK`, benchmark `zero_tolerance_ok true`. That suite was not re-run in this session. It is **NOT VERIFIED** here. It uses `FakeArtifacts`, in-memory Durable Object storage, a fake Workflow, and `src/harness/fake-container.ts`, except tests that run `container/promote.sh` and `container/rebase.sh` against local git. Those are not a Container on Cloudflare.

## Public hostname

**CLOUDFLARE VERIFIED** on 2026-10-06 18:28:41 GMT: `GET https://madgrix.ygathuku96.workers.dev/` returned `404` and `{"error":"not_found","path":"/"}`. That does not name a SHA. The deployed commit is **NOT VERIFIED**.

No Queue consumer, Workflow instance, Container, or Artifact write was invoked. Do not create `madgrix-events` or deploy without an explicit owner request.

## Artifacts calls the code uses

`workerd@1.20260930.2` types `ArtifactsRepo.fork`, `createToken`, `readCommit`, and `log`. It does not type `getHead`. Tips are `log({ ref: "main", limit: 1 })`. Baseline presence is `readCommit`. **LOCAL VERIFIED** as source and types. **NOT VERIFIED** on a live repo.

`fork()` is still in that type and in `cf artifacts namespaces repos fork`. The 2026-10-01 `400 [10101]` failure was not repeated. `forkIdempotent` still falls back to an empty repo plus `container/copy-baseline.sh` when the error text contains `10101` or `Invalid repo name`. That fallback stays.

A new per-repo push subscription can drop the first push. The contender and fork-crew runners wait 30 seconds after creating one, then may push an empty commit if the authority has not observed the SHA. That empty commit is a new SHA. The wait is in the scripts. It is **NOT VERIFIED** on Cloudflare.

The installed `cf` 1.0.0-beta.10 subscription command does not list `artifacts.repo` as a `--source-type`. The runners send that source in `--body`. Public docs still describe `cf.artifacts.repo.pushed`. Acceptance of that body is **NOT VERIFIED**.
