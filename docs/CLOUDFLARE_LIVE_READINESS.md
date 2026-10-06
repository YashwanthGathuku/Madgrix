# Cloudflare live readiness

Status words used in this file:

- **LOCAL VERIFIED** — a command or a file read in this session produced the result named here.
- **CLOUDFLARE VERIFIED** — a Cloudflare response was observed in this session. A local stand-in does not count.
- **NOT VERIFIED** — not executed, or executed only against a stand-in.

Inspected commit: `424b2b15425a65a25a230e949dea0f4d94192d9e` on `competition/cloudflare`. No deploy. No queue create. No Artifact write. No `npm run build`.

The parent record for this SHA says an LF archive passed 296 tests, `SLICE OK`, `HEAD-MOVE OK`, and benchmark `zero_tolerance_ok true`. That suite was **not re-run in this session**. Those results stay the parent's record. They are **NOT VERIFIED** again here, and they are not a Cloudflare result.

## 1. Local build readiness

| Check | Status | Evidence this session |
|---|---|---|
| `docker` on Windows PATH | **LOCAL VERIFIED** absent | `docker` is not a command. `where.exe docker` found nothing. |
| `docker` in WSL | **LOCAL VERIFIED** absent | `wsl -e bash -lc "command -v docker"` printed `docker: command not found`. |
| `npm run build` | **NOT VERIFIED** | Not run. The Worker config includes a Container image, and the installed builder refuses to build that image without a Docker CLI. |
| Node | **LOCAL VERIFIED** | `node --version` is `v22.17.0`. `npm --version` is `10.9.2`. CI and the README name Node 24. |
| `npm ci` | **LOCAL VERIFIED** | Exit 0. 58 packages added. npm reported 5 high severity audit findings. Not investigated. |
| Installed `cf` | **LOCAL VERIFIED** | `node_modules/.bin/cf --version` is `cf · v1.0.0-beta.10`. It is not on PATH until that binary is used. |
| `cf` authentication | **LOCAL VERIFIED** logged out | `cf auth list` printed `[]`. `cf auth whoami` printed `{"authenticated":false,"error":"Not logged in"}`. |

`npm run build` is `cf build`. `@cloudflare/vite-plugin` (locked with `cf@1.0.0-beta.10`) builds the configured image only after `docker info` succeeds. The message it throws when that fails is:

> The Docker CLI is needed to build the configured image before `<operation>` but could not be launched.

On Windows the same message says to install Docker from <https://docs.docker.com/get-started/get-docker/> and to open Docker Desktop. A Docker-compatible CLI is not guaranteed; the plugin names `WRANGLER_DOCKER_BIN` and `DOCKER_HOST` as the override. The image is `container/Dockerfile`: `debian:trixie-slim` plus `git`, `ca-certificates`, `bash`, and `coreutils`.

The same `cf` package, on the local-dev container path, says local development with containers is not supported on Windows and to use WSL. That sentence was read from the package. It was not produced by running `cf dev`.

Do not treat a Worker-only bundle as `npm run build`. This session did not produce one.

## 2. Configuration against installed types

Source: `cloudflare.config.ts` at the inspected SHA. Types: `@cloudflare/config` `0.22.0` (`node_modules/@cloudflare/config/dist/public-DFY8wDEh.d.mts`) and `workerd` `1.20260930.2` (`node_modules/workerd/worker.mjs`). **LOCAL VERIFIED** that the config uses helpers those files export. **NOT VERIFIED** as a deployed version.

| Item | Declared | Type check |
|---|---|---|
| Worker | name `madgrix`, entry `src/worker/index.ts` with `{ type: "cf-worker" }` | `compatibilityDate` is required. Set to `2026-10-01`. |
| Compatibility flags | omitted | Optional. The type default is `[]`. No flags are set. |
| Routes | none | No `triggers.fetch`, no `domains`. A custom route is not declared. |
| `ARTIFACTS` | `bindings.artifacts({ namespace: "default", dev: { remote: true } })` | `artifacts({ namespace, dev?: { remote?: boolean } })` exists. Namespace `default` must already exist at deploy time. This session did not list namespaces. |
| `TASK_AUTHORITY` | `bindings.durableObject({ worker: "madgrix", exportName: "TaskAuthority" })` | Matches `durableObject({ worker, exportName })`. |
| `PROMOTION_CONTAINER` | same shape, `exportName: "PromotionContainer"` | Same helper. |
| Durable Object exports | both `exports.durableObject({ storage: "sqlite" })`. `PromotionContainer` also passes `container: promotionContainer` | Containers are only offered with `storage: "sqlite"`. Default export state is `created`. There is no `deleted`, `renamed`, `transferred`, or `expecting-transfer` entry. |
| `PROMOTION_WORKFLOW` | `bindings.workflow({ name: "madgrix-promotion", worker: "madgrix", exportName: "PromotionWorkflow" })` | Matches the binding type. |
| Workflow export | `exports.workflow({ name: "madgrix-promotion", limits: { steps: 8 }, defaultRetention: { successRetention: "3 days", errorRetention: "7 days" } })` | `name`, `limits.steps`, and those retention fields exist on `WorkflowExportOptions`. |
| Container | `defineContainer({ name: "madgrix-promotion", image: { dockerfile: "./container/Dockerfile" }, instanceType: "lite", maxInstances: 4 })` | `instanceType: "lite"` is a listed type: 1/16 vCPU, 256 MiB memory, 2 GB disk. `maxInstances` exists (type default 20). Also listed in top-level `containers`. |
| Queue trigger | `triggers.queue({ name: "madgrix-events", maxBatchSize: 10, maxBatchTimeout: 30 })` | `name`, `maxBatchSize`, and `maxBatchTimeout` exist. `deadLetterQueue` and `maxRetries` are optional and are **not** set. |
| Secrets | `bindings.secret()` for `EVALUATION_SERVICE_TOKEN`, `CONTROL_SERVICE_TOKEN`, `AGENT_SERVICE_TOKEN`, `AUTHORITY_SIGNING_KEY` | `secret()` takes no options. Values are not in the repo. `keys/authority.pub` is **absent** (**LOCAL VERIFIED**). |

Account migration state of the Durable Object namespaces is **NOT VERIFIED**. The config does not carry a Wrangler `migrations` array. A first deploy of these `created` sqlite classes is what the type describes as provisioning. What the account already has was not listed.

## 3. Queue

| Item | Status |
|---|---|
| Whether `madgrix-events` exists | **NOT VERIFIED**. `cf auth whoami` is logged out, so `cf queues list` was not run. The queue was not created. |
| Producer | Artifacts `pushed` subscriptions, created by `scripts/run-contenders.mjs` and `scripts/run-fork-crew.mjs` with `cf queues subscriptions create --body <json>`. The body sets `source.type` to `artifacts.repo`, `events` to `["pushed"]`, and `destination.type` to `queues.queue`. **NOT VERIFIED** against the live API. |
| Consumer | Worker `madgrix` export `queue`, batch 10, batch timeout 30 seconds. Attached only if this config is deployed. **NOT VERIFIED** on the account. |
| Delivery | Cloudflare Queues docs, last updated 2026-04-21: at-least-once by default, and order is not guaranteed (<https://developers.cloudflare.com/queues/reference/delivery-guarantees/>, <https://developers.cloudflare.com/queues/reference/how-queues-works/>). Each queue has one consumer. |
| Dedupe | `event_key = SHA256(namespace \|\| repo \|\| ref \|\| before \|\| after)` in `ingestQueueEvent`. A seen key returns `ACK_DUP` with no effects. **LOCAL VERIFIED** as source text. A live redelivery is **NOT VERIFIED**. |
| Out of order | A new key whose repo is not a known contender fork returns `REJECTED_OUT_OF_ORDER`, writes a ledger row, and applies nothing. A known repo sets `latest_commit` to `after`. **LOCAL VERIFIED** as source text. **NOT VERIFIED** on a live queue. |
| Unrelated events | `normalizeArtifactQueueBody` returns null for anything other than `cf.artifacts.repo.pushed` from `artifacts.repo`, or the internal test envelope. A null route is acknowledged and does not throw. Non-contender repo names (`mgx-<task>_<24 hex>-<12 hex>`) are also dropped before the Durable Object. |

CLI mismatch, **LOCAL VERIFIED** from `cf queues subscriptions create --help` and `cf schema queues subscriptions create`: `--source-type` lists `images`, `kv`, `r2`, `superSlurper`, `vectorize`, `workersAi.model`, `workersBuilds.worker`, `workers.script`, and `workflows.workflow`. It does not list `artifacts` or `artifacts.repo`. The runners pass `--body`, which the help says bypasses those flags. Public docs still describe the Artifacts envelope (Queues events schemas, last updated 2026-09-25; Artifacts event subscriptions, last updated 2026-05-21): type `cf.artifacts.repo.pushed`, source `artifacts.repo`, event name `pushed`. Whether the live API accepts the runner's body is **NOT VERIFIED**.

Read-only command, after the owner logs in. Do not create the queue from this command:

```
npx cf auth login
npx cf queues list
npx cf queues get <queue-id>
```

Create only if that list has no `madgrix-events` and the owner has authorized a new queue. Queues billing is documented at <https://developers.cloudflare.com/queues/platform/pricing/> (free tier 10,000 operations/day; Workers Paid after that).

```
npx cf queues create --queue-name madgrix-events
```

Expected effect of that one command: one queue named `madgrix-events` in the authenticated account. It does not attach the Worker. It does not create a dead-letter queue. This config's trigger does not name one.

## 4. Artifacts

| Item | Status |
|---|---|
| Namespace `default` | Named in config. Existence **NOT VERIFIED**. |
| Baseline repo and commit | Come from `MADGRIX_BASELINE_REPO` and `MADGRIX_BASELINE_COMMIT` at run time. No repo name is frozen in this tree. **NOT VERIFIED**. |
| Canonical destination | `MADGRIX_DESTINATION_REPO`, defaulting to the baseline repo. **NOT VERIFIED**. |
| Fork | `workerd@1.20260930.2` still types `ArtifactsRepo.fork(name, opts?)` and `cf artifacts namespaces repos fork` still exists. The 2026-10-01 live failure (`400 [10101] Invalid repo name`) was **not repeated**. `forkIdempotent` still falls back to `create` plus `container/copy-baseline.sh` when the error text contains `10101` or `Invalid repo name`. That fallback stays. Whether the endpoint still fails is **NOT VERIFIED**. |
| Git credentials | `ArtifactsRepo.createToken(scope?, ttl?)`. Contender write tokens are minted on the fork only, TTL at most 3600 seconds. Evaluator tokens are read scope. Promotion and rebase mint tokens for at most five minutes. Plaintext is returned once. **LOCAL VERIFIED** as source plus the workerd type (ttl default 86400, min 60, max 31536000). Live token enforcement for this SHA is **NOT VERIFIED**. |
| `readCommit` / `log` | Baseline presence is `readCommit`. Tips are `log({ ref: "main", limit: 1 })`. The workerd type has no `getHead`. `log` is documented to return an array (empty if the ref cannot be resolved). The adapter still treats a non-array as an empty history. **LOCAL VERIFIED** as source and types. **NOT VERIFIED** on a live repo. |
| Push subscription | Per contender repo, after the fork exists and before the push. A subscription the script just created waits 30 seconds, then may push an empty commit if the authority has not observed the SHA. That empty commit is a new SHA and needs its own evaluation. **NOT VERIFIED** on Cloudflare for this SHA. |

Read-only commands, after login. These do not create a namespace or a repo:

```
npx cf artifacts namespaces list
npx cf artifacts namespaces repos list --namespace default
```

Public docs (Artifacts open beta, 2026-10-01) say Artifacts requires the Workers Paid plan and that billing starts 2026-10-14. Creating a namespace or a repository is an account change. Do not do it until the owner authorizes it. The config assumes namespace `default` already exists.

## 5. What was seen on Cloudflare

**CLOUDFLARE VERIFIED** on 2026-10-06 18:28:41 GMT:

```
curl.exe -sS -D - --max-time 20 https://madgrix.ygathuku96.workers.dev/
```

`HTTP/1.1 404` and body `{"error":"not_found","path":"/"}`. That matches the Worker's unknown-path response. It does not name a commit, a Durable Object migration, or a container image. The deployed SHA is **NOT VERIFIED**.

No Queue, Workflow, Container, or Artifact call was made.

## 6. Deployment boundary

Do not deploy this branch unless the owner explicitly says to deploy a reviewed SHA. `cf deploy` in this CLI sets resource provisioning on. Expected effects of an authorized `cf deploy` of this config, not observed:

- Upload a version of Worker `madgrix`.
- Provision sqlite Durable Object classes `TaskAuthority` and `PromotionContainer` in the `created` state.
- Provision Workflow `madgrix-promotion` (class `PromotionWorkflow`, step limit 8).
- Build and roll out Container application `madgrix-promotion` (`lite`, max 4). This needs Docker and pulls `debian:trixie-slim`.
- Attach consumer `madgrix` to queue `madgrix-events`. The queue object is not created by the config comment's deploy step; create it first if `cf queues list` does not show it.
- With no fetch route declared, the previous public name `madgrix.ygathuku96.workers.dev` is the only hostname this session observed. What a new deploy does to that hostname is **NOT VERIFIED**.

Secrets are not in git. `cf deploy --help` accepts `--secrets-file` as JSON or `.env`. Workers secrets docs (updated 2026-07-03) use dotenv and say keys omitted from the file are kept from the previous version. Generate the authority key outside the repo (`keys/README.md`). Commit only `keys/authority.pub`. Put the private PEM in the secret file, not in git.

```
openssl genpkey -algorithm ed25519 -out /secure/location/authority.pem
openssl pkey -in /secure/location/authority.pem -pubout -out keys/authority.pub
```

`.env` shape, values supplied by the owner, file gitignored:

```
CONTROL_SERVICE_TOKEN="..."
AGENT_SERVICE_TOKEN="..."
EVALUATION_SERVICE_TOKEN="..."
AUTHORITY_SIGNING_KEY="..."
```

Authorized deploy, from the reviewed SHA, after Docker answers `docker info` and the queue list is known:

```
npm run build
npx cf deploy --secrets-file /secure/location/madgrix-secrets.env
```

`cf deploy --dry-run` still builds. It was not run. It is not a substitute for the image build, and it is not authorization to provision.

## 7. Live path

Target, and the only success condition:

Worker → Artifacts push → `cf.artifacts.repo.pushed` → queue `madgrix-events` → `TaskAuthority` `/event` → evaluation → verdict → `PromotionWorkflow` → `PromotionContainer` → canonical Artifact fast-forward of the reviewed SHA → signed bundle verified offline.

`FakeArtifacts`, the slice harness, and an in-memory queue do not meet that condition. `npm run live:e2e` was **NOT VERIFIED**. It must not be run until the reviewed SHA is deployed and the owner has supplied the tokens and the baseline.

Run it with Node 24. This machine's Node 22.17.0 does not strip TypeScript in `node` without a flag. The script holds all three service tokens. Children do not inherit that environment.

Unset `MADGRIX_AGENT_IDS` selects the fork crew. That child runs `fleet validate` and requires `summary.agent_ids` in crew order. **LOCAL VERIFIED** on this machine: `fleet 0.3.0` validate of `configs/git4agents-fork-crew.yaml` returned `is_valid: true` and `summary.total_agents: 3`, and the summary had no `agent_ids` field. `assertFleetRoster` then fails closed before a push. A live fork-crew run is blocked on that report shape.

The sibling path does not call `fleet` when `MADGRIX_AGENT_IDS` is set. That is the path that can reach a real push with the tools this session inspected. It still needs a real agent command, a real baseline, and a deployed Worker. It was not run.

```
npx --yes node@24 scripts/live-e2e.ts
```

with:

```
MADGRIX_BASE_URL=https://madgrix.ygathuku96.workers.dev
MADGRIX_CONTROL_SERVICE_TOKEN=...
MADGRIX_AGENT_SERVICE_TOKEN=...
MADGRIX_EVALUATION_SERVICE_TOKEN=...
MADGRIX_BASELINE_REPO=<namespace repo name>
MADGRIX_BASELINE_COMMIT=<40 hex sha already in that repo>
MADGRIX_DESTINATION_REPO=<canonical repo, or omit to use the baseline repo>
MADGRIX_INTENT=<one sentence>
MADGRIX_BEHAVIOR_CONTRACT=<what the hidden test checks>
MADGRIX_CLAIM_PATHS=<bounded paths, not **>
MADGRIX_AGENT_IDS=<two or more enrolled ids, comma-separated>
MADGRIX_AGENT_COMMAND=<command that commits and writes the tool-status log>
MADGRIX_HIDDEN_TEST_COMMAND=<command that tests the candidate sha>
MADGRIX_QUEUE_ID=<id from cf queues list for madgrix-events>
MADGRIX_ARTIFACTS_NAMESPACE=default
MADGRIX_TRUST_KEY=keys/authority.pub
```

Success is stdout containing `"status": "MADGRIX_LIVE_E2E_OK"` after `src/cli/verify.ts` prints `VERIFIED` for the bundle fetched from the Worker. A local bundle does not count.

`configs/demo-composition.json` adds `sub-test`. No fleet manifest lists `parent`, `sub-api`, `sub-ui`, and `sub-test`. Combined with the missing `agent_ids` field, a live run of that JSON is **NOT VERIFIED** and will not get past the roster check.

## 8. Reliability audit

All of these are **LOCAL VERIFIED** as source behavior. None is **CLOUDFLARE VERIFIED**.

| Risk | What the tree does |
|---|---|
| Container readiness | `PromotionContainer` calls `start` when `running` is false, then `exec`. Failures whose message matches `/not running/i` retry after 100, 200, 400, 800, 1600, and 3200 ms, then HTTP 503 `container_not_running`. |
| Exec timeout | 60 seconds from the first exec attempt. The process is killed. HTTP 503 `container_exec_timeout`. |
| Disposal | `container.destroy()` runs in `finally` after every promote, rebase, and copy-baseline. A destroy error is swallowed. |
| One at a time | Operations on one PromotionContainer share a promise chain. |
| Workflow retries | One step, `promote/<permit_id>`. Five retries, exponential from 10 seconds, step timeout 2 minutes. HTTP status `>= 500` throws and retries. 409 is returned and is terminal. The permit stays unconsumed on a terminal refusal. |
| Terminal exits | `promote.sh` maps 42, 43, 44, 46, 47 to 409. `rebase.sh` maps 42, 44, 45, 48, 49 to 409. Other non-zero exits are 502 `GIT_ERROR`, which the Workflow retries. |
| Duplicate queue delivery | Seen `event_key` is `ACK_DUP`. The consumer returns normally, so the platform can delete the message. |
| Out-of-order push | Unknown repo is `REJECTED_OUT_OF_ORDER` and the key is stored, so a redelivery is `ACK_DUP`. A known repo overwrites `latest_commit` with `after`. Two different pushes have different keys and can apply in either order. |
| Lost first subscription event | A subscription the runner just created waits 30 seconds before the first push. If the authority has not applied that SHA, the runner creates an empty commit and pushes again. The new SHA is the candidate. The first SHA is not evaluated. |
| Promotion idempotency | The Workflow instance id is the permit id. A second `POST /promote` gets that instance and restarts it only when status is `errored`. `promote.sh` fast-forwards the reviewed SHA. A retry that finds it already in history reports `ALREADY_WRITTEN` and does not create a second commit. |
| Credential revocation | `executeEffects` for `revoke_token` calls `revokeToken` and logs a failure. It does not fail the queue message. Quarantine also terminates unconsumed promotion instances. |
| Destination-head race | A head that moved before the fast-forward is exit 42, HTTP 409 `EXPIRED_HEAD_MOVED`. A push refused during the write is exit 44, HTTP 409 `PUSH_REJECTED`. Neither consumes the permit. A later head requires rebase to a new SHA and a new evaluation. |

## 9. Owner actions

1. Install Docker and start the engine so `docker info` exits 0. Then, on the reviewed SHA, run `npm run build` and keep the log.
2. Run `npx cf auth login` on the account that should host the competition.
3. Run `npx cf queues list` and `npx cf artifacts namespaces list`. Record whether `madgrix-events` and namespace `default` exist. Do not create either until you authorize the charge.
4. If the queue is missing and you authorize it: `npx cf queues create --queue-name madgrix-events`. Copy the queue id into `MADGRIX_QUEUE_ID`.
5. Generate `AUTHORITY_SIGNING_KEY`, commit `keys/authority.pub`, and keep the private key in a gitignored secrets file with the three service tokens.
6. Say which SHA may be deployed. Until then, do not run `cf deploy`.
7. After that deploy, run `npm run live:e2e` with Node 24 and the environment in section 7. Keep the bundle and the verifier output. That is the Cloudflare evidence. A 404 from `/` is not.
8. Decide the fork-crew fleet gap separately. `fleet 0.3.0` on this machine does not print `summary.agent_ids`. The sibling command in section 7 does not need that field. The demo JSON still has no matching manifest.
