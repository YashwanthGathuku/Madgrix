# Production Deployment (internal codename: seam — NOT a public brand)

How this project runs on Cloudflare, what is validated, and what is not.
Companion to the frozen runtime contract (`./specs/CLOUDFLARE_RUNTIME_MODEL.md`,
FROZEN-v1 — this document never overrides it).

## (a) What runs where

| Component | Cloudflare primitive | Role (per frozen spec 5) |
|---|---|---|
| Ingestion Worker (`seam`) | Worker (`src/worker/index.ts`, `fetch` + `queue` exports) | Receives Artifact lifecycle events from the Queue; derives `event_key`; forwards to the task's DO |
| Task authority | Durable Object, class `TaskAuthority`, **one instance per task id** (`env.TASK_AUTHORITY`, `idFromName(task_id)`) | Authoritative state machine: `event_key` dedupe, claims, contenders, evidence, permits, quarantine, ledger. Every transition inside a storage transaction; returns `Effect[]`, never executes side effects |
| Event ingestion | Cloudflare Queue `seam-events` (at-least-once, unordered) | `triggers.queue({ name: "seam-events" })` in `cloudflare.config.ts` → Worker's `queue()` export → DO `/event` → `executeEffects` |
| Orchestration | Workflows (`PromotionWorkflow` in `src/worker/index.ts`) | **SKELETON.** Step names are the idempotent operation ids (fork/evaluate/promote). Not registered in config; step bodies call route logic. Full wiring (WorkflowEntrypoint, workflow binding/export) is deferred to the protocol-layer completion |
| Repository substrate | Artifacts binding (`env.ARTIFACTS`, namespace `default`) | Forks, tokens, git protocol. No merge API (spec 5 §7) |
| Merge machinery | Sandbox + git (isolated sandbox holding destination HEAD + winning tree + merge-scoped token) | Performs the actual merge after verifying the exact-state permit. **Not implemented in this slice** — the `/promote` route performs all platform preconditions and stops before the canonical write |
| Decision authority | This platform | What may be merged, and the proof (permit = `SHA256(task_hash ‖ baseline ‖ winning_tree ‖ eval_bundle ‖ policy ‖ expected_destination_head)`) |
| Verdict seam / attestation | Protocol layer (sibling workstreams) | `/verdict` returns 501 here; full verdict + in-toto/DSSE/Sigstore attestation live in `src/lib/` and the sibling-owned protocol layer |

Zone credentials (spec 3 §5), as implemented in `src/worker/index.ts`:
contender = WRITE on its fork only, TTL ≤ 1h (`issueContenderCredentials`
rejects TTL > 3600); evaluator = READ per-evaluation; verifiers = none.

## (b) Deploy commands and required bindings/secrets

No real secret values appear below. Nothing here has been deployed.

```bash
cd seam

# 1. Prereqs (account <CLOUDFLARE_ACCOUNT_ID> — see ../SETUP_STATUS.md)
cf queues create seam-events            # queue must exist before deploy
# cf artifacts namespaces ...           # namespace "default" already exists

# 2. Typecheck + build (must be clean)
npx tsc --noEmit
npm run build        # cf build → vite build via vite.config.ts

# 3. Deploy (NOT RUN — first deploy happens on a direct-egress machine)
cf deploy
```

Bindings/secrets required at deploy time (all declared in `cloudflare.config.ts`):

| Name | Kind | Source | Notes |
|---|---|---|---|
| `ARTIFACTS` | Artifacts binding, namespace `default` | platform-managed | Local dev on a direct-egress machine uses `dev: { remote: true }` |
| `TASK_AUTHORITY` | Durable Object binding → class `TaskAuthority` in this same Worker | declared via `exports.durableObject({ storage: "sqlite" })` + `bindings.durableObject({ worker: "seam", exportName: "TaskAuthority" })` | sqlite storage for transactional state |
| Queue trigger `seam-events` | Queue consumer | `triggers.queue(...)` in config; queue must pre-exist | `maxBatchSize: 10`, `maxBatchTimeout: 30`; add a dead-letter queue for poison messages (the `queue()` consumer throws on malformed bodies, which redelivers until the retry limit) |

No API keys, tokens, or signing keys are required by the platform slice
itself. Plaintext contender tokens are minted at runtime via the Artifacts
binding and returned once in the `/contenders` response body — never logged,
never persisted. Sigstore/DSSE signing keys belong to the protocol layer
(spec 4), not this slice.

## (c) Honest status table

| Item | Status | Evidence |
|---|---|---|
| `npx tsc --noEmit` strict | ✅ Clean | run 2026-10-01 |
| `npm run build` (`cf build` → vite) | ✅ Clean | required adding `vite.config.ts` (registers `@cloudflare/vite-plugin`; worker-only project has no `index.html`, which vite otherwise demands) |
| Unit suite | ✅ 74/74 pass | `npm test` (node --test), 2026-10-01 |
| Worker boots locally in workerd | ✅ | `cf dev` with `CLOUDFLARE_VITE_FORCE_LOCAL=true` — see `docs/dev-boot-local-20261001.log`; transcript below |
| Fetch router (all routes) | ✅ | 501 verdict skeleton, 404 JSON on unknown path, 404 task_not_found on ledger for unknown task |
| Worker → DO RPC (`env.TASK_AUTHORITY`, `idFromName`, `fetch`) | ✅ | `POST /tasks/:id/claim` with valid claim input → DO returned `not_initialized` 404 through the Worker (proves DO class boots in workerd, storage read works, RPC round-trips) |
| Claim-input contract Worker↔DO | ✅ fixed | Bug found during boot test: Worker required `claim.work_id` but the DO rejects inputs carrying `work_id` (authority assigns it) — the route could never succeed. Fixed to accept `ClaimInput` (no `work_id`); body with `work_id` now 400s at the edge, matching the DO |
| DO binding + export in config | ✅ added | Verified helper shapes against vendored `@cloudflare/config` (not guessed): `exports.durableObject({ storage: "sqlite" })`, `bindings.durableObject({ worker: "seam", exportName: "TaskAuthority" })`; queue consumer `triggers.queue({ name: "seam-events", ... })` |
| Local Artifacts binding callable | ✅ (local simulation only) | `POST /tasks` → `baseline_repo_not_found` 404: binding works locally, but the local simulation is empty — it cannot see the remote `default` namespace |
| Remote Artifacts binding (`dev: { remote: true }`) | ❌ blocked-by-sandbox | workerd outbound TLS fails through this sandbox's egress proxy (`WRONG_VERSION_NUMBER`); documented in `../SETUP_STATUS.md`. The `cf` CLI works (proxy-aware). Do not attempt a proxy workaround from here |
| **Live Artifacts control plane via `cf` CLI** | ✅ validated 2026-10-01 | Repo create returns a repo-scoped token; `git push` with `Authorization: Bearer <token>` extraHeader works; scratch repos created and deleted cleanly |
| Scoped-token enforcement (live) | ✅ validated 2026-10-01 | Read-scoped token: clone/fetch OK, push → 403 "Insufficient permissions". Write-scoped token: push OK. Scopes are enforced server-side, not advisory |
| Token revocation (live) — quarantine's kill switch | ✅ validated 2026-10-01 | `tokens revoke <id> --namespace default -f` → subsequent push with the same token → 403 "Invalid or expired token" (effective within ~10s). Revoking a contender's write token genuinely stops their writes. Note: the token-id index is eventually consistent — revoking within ~1s of creation can 404; retry after a short delay |
| **Fork endpoint** | ❌ broken in the Artifacts beta | `POST .../repos/{name}/fork` returns 400 `[10101] Invalid repo name` for every repo tried (starter-repo and scratch repos) — the endpoint takes no name parameter, so this is a server-side bug, not a caller error. **Architectural consequence:** the "fork per contender" flow needs a fallback until Cloudflare fixes it — create a fresh repo and push the baseline into it (import pattern) instead of forking. The `ArtifactsPort` interface should expose `fork` with a documented `forkWithImportFallback` |
| Token format note | ℹ️ | Tokens look like `art_v2_x_...?expires=...` — the `?expires=` suffix is part of the token; pass it verbatim as the Bearer value in the git `http.extraHeader`, no URL-encoding. `tokens create` needs `--repo`, `--scope read|write`, `--ttl` (seconds); the `plaintext` value is shown once — the `id` is what `revoke` takes |
| Full `/tasks` flow (DO init via real baseline repo) | ❌ blocked-by-sandbox | Needs the remote Artifacts binding (above) |
| Queue consumer end-to-end (real redelivery/dedupe) | ⚠️ needs-direct-egress-machine | `queue()` logic reviewed statically; local miniflare queue was not exercised in the boot test. On a direct-egress machine: send duplicate `event_key` messages, verify second is ACK-without-effect |
| `PromotionWorkflow` real execution | ⚠️ skeleton, untested | Class exists with idempotent step names; not registered as a workflow export/binding. Needs the Workflow runtime + `WorkflowEntrypoint` wiring (protocol-layer completion) |
| Merge sandbox (spec 5 §7) | ⚠️ not implemented | `/promote` performs all platform preconditions and stops before the canonical write — by design in this slice |
| Evaluation-domain auth on `/evidence` | ⚠️ TODO in code | Currently accepts + records; production must authenticate the evaluation domain (spec 3 §2) before recording |
| `cf deploy` to the account | ❌ not attempted | Per hard rules: no deploy from this machine without explicit instruction; first deploy belongs on a direct-egress machine |

Boot transcript (remote-free instance, `CLOUDFLARE_VITE_FORCE_LOCAL=true`,
all bindings local; full log in `docs/dev-boot-local-20261001.log`):

```
POST /tasks/t1/verdict            → 501 {"error":"not_implemented","detail":"verdict seam is protocol-layer ..."}
POST /tasks/task_boot1/claim      → 404 {"error":"not_initialized"}          (from inside the DO, via the Worker)
POST /tasks/task_boot1/claim      → 400 {"error":"invalid_claim",...}        (body carried work_id — edge rejects)
  (with ClaimInput-shaped body)
GET  /tasks/unknown-task/ledger   → 404 {"error":"task_not_found","task_id":"unknown-task"}
POST /tasks                       → 404 {"error":"baseline_repo_not_found"}  (local Artifacts sim is empty)
```

Note: the first boot attempt (without `CLOUDFLARE_VITE_FORCE_LOCAL=true`)
printed "Establishing remote connection..." — the vite plugin defaults
`remoteBindings: true` and opens a remote proxy session at startup even when
every binding is local-only. The evidence above comes from the second boot,
with that flag set, where the line did not appear.

## (d) Smoke test after first real deploy

Run on a direct-egress machine, against the deployed Worker URL
(`$BASE`). All Artifacts calls go through the remote binding.

```bash
BASE=https://seam.<account>.workers.dev   # actual deployed URL

# 1. Router alive
curl -s $BASE/nope | grep not_found

# 2. Verdict seam is still protocol-layer (expect 501, not 500)
curl -s -X POST $BASE/tasks/t0/verdict -o /dev/null -w '%{http_code}\n'   # 501

# 3. Create a task against a real baseline repo (namespace "default")
curl -s -X POST $BASE/tasks -H 'content-type: application/json' \
  -d '{"intent":"smoke","baseline_repo":"starter-repo","baseline_commit":"<real-sha>"}'
# expect 201 {"task_id":"task_...","task_hash":"...","frozen_at":"..."}

# 4. Register a claim (expect work_id assigned by the authority)
curl -s -X POST $BASE/tasks/<task_id>/claim -H 'content-type: application/json' \
  -d '{"claim":{"agent":"smoke-agent","task":"<task_hash>","baseline":"<sha>", ...}}'
# expect 200 {"recorded":true,"work_id":"W-...","conflicts":[]}

# 5. Ledger shows the frozen task + claim
curl -s $BASE/tasks/<task_id>/ledger | grep <task_id>

# 6. Queue dedupe: publish the same push event twice to seam-events;
#    the second delivery must ACK without effect (no duplicate ledger entries).
#    Verify via the ledger (step 5) — event_key appears once.

# 7. DO isolation: POST /tasks/<other>/claim with a duplicate event_key
#    for the first task must not touch the second task's DO.
```

Pass criteria: steps 1–5 return the expected codes/shapes; step 6 shows
exactly-once effect under duplicate delivery; step 7 shows per-task
isolation. Any 500, any duplicate side effect, or any cross-task state leak
is a deployment blocker — record it as a spec-5 amendment candidate, do not
patch around it.
