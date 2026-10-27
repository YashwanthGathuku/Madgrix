# Spec amendment: promotion-runtime-v1 — the promotion runs in a Workflow instance per permit; the container retries, bounds and destroys each operation; every error is JSON

**Status:** proposed · **Date:** 2026-10-03
**Affects:** `CLOUDFLARE_RUNTIME_MODEL.md` (FROZEN-v1) §5 (Workflow retries and
operation ids), §7 (the isolated merge sandbox) and §10 (failure semantics);
`EVALUATION_THREAT_MODEL.md` (FROZEN-v1), quarantine requirements ("cancel that
contender's pending Workflow steps"). Spec files are NOT edited; this file records
the change.

## (1) The invariants (quoted from the specs)

`CLOUDFLARE_RUNTIME_MODEL.md` §5:

> "Cloudflare documents that **Workflow steps can retry** and advises making
> external mutations idempotent. Therefore every side effect gets an
> **operation id**; repeating the operation MUST converge to the same state"
>
> "| promote | `H(task_id, candidate_sha, destination_head, policy_hash)` | = `permit_id` (spec 1 §10); single-consume in the DO |"

§7: "The merge itself MUST run in an isolated sandbox holding only: the destination
HEAD, the winning tree, and a merge-scoped token".

§10: "| Workflow step retry | Operation id → converge to same state, no duplicate side
effects |".

`EVALUATION_THREAT_MODEL.md`, on entering `QUARANTINED`:

> "the control plane MUST revoke the contender's repo write token (`revokeToken`),
> cancel that contender's pending Workflow steps, remove the candidate from
> selection, …"

## (2) What the implementation violated

- `PromotionWorkflow` was exported (`exports.workflow` in `cloudflare.config.ts`)
  but nothing bound or created it. `POST /tasks/:id/promote` ran the promotion
  synchronously inside the request, so a promotion was retried only if the caller
  retried the request, and the permit id was not the id of anything durable.
- `PromotionContainer` called `exec()` once, right after `start()`. A container
  that was still starting threw "not running" out of the Durable Object; a script
  that hung was waited on forever; the container was never destroyed, so a work
  directory holding fetched objects outlived the operation.
- The Worker called `.json()` on every Durable Object answer without looking at its
  content-type, so a runtime error page became an unhandled `SyntaxError`; an
  exception inside a route reached the runtime as an error page; the TaskAuthority
  let a storage exception escape the same way; a request body sent as anything but
  JSON was read as JSON.
- Every route that reads the task authority's state answered any failure of that
  read as 404 `task_not_found`. With the promotion in a Workflow step, a transient
  authority failure would have completed the instance with a 404 instead of being
  retried.
- The `cancel_workflow` effect of a quarantine was logged and dropped ("SKELETON:
  … no workflow runtime wired"): a contender's pending promotion was not cancelled.
- `POST /tasks/:id/contenders`, when the fork endpoint failed and the baseline copy
  through the container failed, left an empty fork behind; retrying the request
  found the fork, skipped the copy and answered 409
  `contender_fork_not_at_frozen_baseline` forever.
- `cloudflare.config.ts` told deployers to `cf queues create seam-events`; the
  Worker consumes `madgrix-events`.

## (3) The change

### One PromotionWorkflow instance per permit (`src/worker/index.ts`, `cloudflare.config.ts`)

- `cloudflare.config.ts` binds the Workflow:
  `PROMOTION_WORKFLOW: bindings.workflow({ name: "madgrix-promotion", worker: "madgrix", exportName: "PromotionWorkflow" })`.
- `POST /tasks/:id/promote` (control plane; body `{ permit_id }`) checks the permit
  id is 64 lowercase hex (else 400 `invalid_permit_id`) and that the task authority
  holds it (else 404 `UNKNOWN_PERMIT`), then creates an instance with
  `id = permit_id` and `params = { task_id, permit_id }`, and answers **202**
  `{ instance_id, status, status_url }`. If the id is taken, the existing instance
  is reported instead (the platform refuses a second instance with the same id); an
  instance in status `errored` is restarted (`instance.restart()`), so a permit is
  not stuck behind an instance whose retries ran out.
- `GET /tasks/:id/promotions/:permit_id` (control plane) reports the instance:
  `{ instance_id, status }`, plus `result: { status, body }` when it is `complete`
  (the promotion's answer, e.g. 200 `PROMOTED` or a 409 refusal) and `error` when
  it is `errored`. 404 `promotion_not_started` when the permit has no instance (a
  `get()` that fails for any reason is read as "no instance").
- `PromotionWorkflow.run` has one step, `promote/<permit_id>`, with
  `retries: { limit: 5, delay: "10 seconds", backoff: "exponential" }` and
  `timeout: "2 minutes"` (inside the five minutes the step's Artifacts tokens live).
  The step runs `runPromotion` (the former synchronous route body). A 5xx answer or
  an exception is thrown, so the step retries it; 2xx and 4xx answers (including
  every 409 refusal, which leaves the permit unconsumed) are returned and complete
  the instance. A retry converges because promotion creates no commit
  (`specs/amendments/rebase-ancestry-v1.md`: a retry after the push finds
  `ALREADY_WRITTEN`) and the task authority consumes a permit once.

### The container operation (`src/do/PromotionContainer.ts`)

For each of `promote`, `rebase` and `copy_baseline`:

1. `start()` the container if it is not running;
2. `exec()` the script; while `exec()` throws an error whose message matches
   `/not running/i`, wait 100, 200, 400, 800, 1600, 3200 ms and try again (seven
   attempts, six retries); after the last, answer **503**
   `{ error: "container_not_running", retryable: true, attempts: 7 }`;
3. the run has **60 s** from the first `exec()` attempt to the script's output; when
   that expires, `kill()` the process (also one whose `exec()` resolves later) and
   answer **503** `{ error: "container_exec_timeout", retryable: true, deadline_ms: 60000 }`;
4. any other `exec()` or `output()` failure is **502**
   `{ error: "container_exec_failed", retryable: true, detail }`;
5. `destroy()` the container afterwards, whatever happened (a `destroy()` error is
   ignored), so no token, work directory or process outlives the operation.

Operations on one Durable Object run one at a time. Any exception the object does
not otherwise handle is a JSON 500 `promotion_container_internal_error`.

The Worker passes a container 503 through: `runPromotion` answers 503 (the step
retries it), `/rebase` answers 503, and `/contenders` answers 503
`{ error: "fork_baseline_import_failed", retryable: true, detail }`. A retried
`/contenders` request that finds the fork existing but empty copies the baseline
again with a fresh five-minute write token, which it revokes afterwards.

### Every error is JSON

- The Worker reads a Durable Object's answer only after its `content-type` is
  `application/json` (or `application/*+json`); anything else is never passed to
  `.json()` and becomes 502 `{ error: "upstream_not_json", upstream, upstream_status }`
  (`upstream` is `task_authority` or `promotion_container`). The queue consumer
  throws on it, so the message is redelivered.
- Any other exception a route throws is 500 `{ error: "internal_error" }`; the
  detail goes to the log, not the response.
- A request body whose `content-type` is not JSON is 415
  `{ error: "content_type_must_be_json" }`; a JSON body that does not parse is 400
  `invalid_json` as before.
- The TaskAuthority answers an exception in any route as 500
  `{ error: "authority_internal_error" }`.
- Only the task authority's own 404 is `task_not_found`. Any other failure to read
  its state is 502 `{ error: "task_authority_failed", task_id, upstream_status, detail }`,
  which the promotion step retries.

### Quarantine cancels pending promotions (`src/lib/task-state.ts`, `src/worker/index.ts`)

The `cancel_workflow` effect carries `permit_ids`: the contender's permits that are
not consumed. `executeEffects` gets the Workflow binding (from the evidence route
and the queue consumer) and calls `terminate()` on each permit's instance; a permit
with no instance, or whose instance already finished, has nothing to stop. A
promotion that reached the authority's finalize before the quarantine is still
refused there (`QUARANTINED_CANDIDATE`), as before.

### Deploy note

`cloudflare.config.ts` now says `cf queues create madgrix-events`.

## (4) What is not claimed

- Nothing here has run on Cloudflare. The Workflow binding is exercised only through
  `test/helpers/fake-workflow.ts` (instances run when a test drains them; step
  retries without delays); the container only through fakes of the Container API
  (`test/promotion-container.test.ts`, with mock timers) and through local bash runs
  of the scripts (`test/promotion-fixtures.test.ts`). The real platform's
  instance-id rules, status values, retry timing, `restart()` and `terminate()`
  behaviour, and the Container API's exact "not running" error text are assumed from
  the runtime type declarations and documentation, not observed.
- Terminating an instance does not undo a push already running in the container; the
  destination can then hold a quarantined contender's commit without a signed
  promotion bundle (finalize refuses it).
- `copy-baseline.sh` itself is not run by any test; the `/contenders` retry is tested
  with a stand-in for the container's answers. Whether the Artifacts binding's
  `log()` returns an empty list or throws for an empty repository is not known; the
  retry treats an unreadable head as empty and lets `copy-baseline.sh` decide.

Implementation notes: `src/worker/index.ts` (`runPromotion`, `handlePromote`,
`handlePromotionStatus`, `PromotionWorkflow`, `PROMOTION_STEP_CONFIG`,
`executeEffects`, `readUpstreamJson`, `fetch`), `src/do/PromotionContainer.ts`,
`src/do/TaskAuthority.ts` (`fetch`), `src/lib/task-state.ts`
(`quarantineContender`), `cloudflare.config.ts`. Tests:
`test/promotion-container.test.ts`, `test/promotion-workflow.test.ts`,
`test/worker-errors.test.ts`, `test/rebase-route.test.ts`,
`test/env-isolation.test.ts` (live-e2e polls the status route).
