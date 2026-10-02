# Production Deployment — MADGRIX

This document describes the competition-critical Cloudflare deployment, what has
been validated, and the one proof that still must be collected on the real
account. The frozen runtime contract in `specs/CLOUDFLARE_RUNTIME_MODEL.md`
remains normative.

## Runtime map

| Component | Cloudflare primitive | Competition role |
|---|---|---|
| MADGRIX control plane | Worker (`src/worker/index.ts`) | HTTP API, trust-zone authentication, Queue consumer, Verdict Seam |
| Task authority | Durable Object `TaskAuthority`, one instance per task id | Frozen task state, WorkClaims, contenders, evidence, verifier protocol, permits, quarantine, ledger |
| Event ingestion | Queue `madgrix-events` | Receives `cf.artifacts.repo.pushed`; delivery is treated as at-least-once/unordered |
| Promotion retry | Workflow `PromotionWorkflow` | Durable retry wrapper around exact-state promotion |
| Repository substrate | Artifacts binding, namespace `default` | Baseline/candidate/canonical Git repositories and scoped credentials |
| Promotion execution | Cloudflare Container `madgrix-promotion` | Git fetch, tree-digest recomputation, HEAD check, exact reviewed-commit push |
| Evaluation | External/disposable evaluation domain | Read-only candidate credential, independent tests, content-addressed evidence |
| Offline proof | `src/cli/verify.ts` | Verifies the signed promotion bundle without calling MADGRIX |

The live competition runner launches coding agents externally through
`MADGRIX_AGENT_COMMAND`. It does **not** claim those processes are Cloudflare
Workflow instances. Quarantine revokes the contender repository token and marks
the candidate QUARANTINED in authority state, which prevents further authorized
writes/selection/promotion. The protocol's `cancel_workflow` effect is retained
for a future per-contender Workflow implementation but is not represented as an
active runtime kill operation in this competition runner.

## Required resources

The current `cloudflare.config.ts` declares:

- Worker: `madgrix`
- Artifacts binding: `ARTIFACTS`, namespace `default`
- Durable Object: `TASK_AUTHORITY` → `TaskAuthority`
- Durable Object/container: `PROMOTION_CONTAINER` → `PromotionContainer`
- Workflow export: `PromotionWorkflow` / `madgrix-promotion`
- Queue consumer: `madgrix-events`
- secrets: `AGENT_SERVICE_TOKEN`, `EVALUATION_SERVICE_TOKEN`,
  `CONTROL_SERVICE_TOKEN`

Use three different high-entropy secret values. They represent different trust
zones and MUST NOT be reused.

## Pre-deploy verification

```bash
npm install
npm run typecheck
npm run build
npm test
npm run slice
npm run headmove
npm run bench
```

The competition branch has passed CI with 110 tests / 27 suites / 0 failures,
the Cloudflare Worker+Container build, `SLICE OK`, `HEAD-MOVE OK`, and
26/26 adversarial harness trials.

## Account setup and deployment

The exact `cf` subcommand for secret creation can change while the CLI is beta;
use the installed CLI's help rather than copying an unverified command. The
resource sequence is:

```bash
# Inspect current CLI first.
cf --help
cf queues --help

# Queue must exist before the Worker consumes it.
cf queues create madgrix-events

# Build again immediately before deploy.
npm run typecheck
npm run build

# Deploy using the repository's Cloudflare config.
cf deploy
```

Before deployment, configure the three secret bindings with distinct values
using the current CLI-supported secret workflow.

After deployment, configure an Artifacts Event Subscription for
`cf.artifacts.repo.pushed` in namespace `default` with destination queue
`madgrix-events`. This subscription is essential: `npm run live:e2e`
deliberately times out if candidate pushes do not reach Queue → TaskAuthority.

## Live competition E2E

Prepare a baseline Artifact repository and exact commit SHA. The baseline should
contain the small real coding task used in the demo plus its public tests. Keep
the independent evaluation command outside the contender environment.

Set the variables documented at the top of `scripts/live-e2e.ts`, including:

```bash
export MADGRIX_BASE_URL='https://<deployed-worker>'
export MADGRIX_CONTROL_SERVICE_TOKEN='<control-secret>'
export MADGRIX_AGENT_SERVICE_TOKEN='<agent-secret>'
export MADGRIX_EVALUATION_SERVICE_TOKEN='<evaluation-secret>'

export MADGRIX_BASELINE_REPO='<baseline-artifact-repo>'
export MADGRIX_BASELINE_COMMIT='<exact-commit>'
export MADGRIX_DESTINATION_REPO='<canonical-artifact-repo>'
export MADGRIX_INTENT='<task intent>'
export MADGRIX_BEHAVIOR_CONTRACT='<acceptance contract>'

export MADGRIX_AGENT_COMMAND='<real coding-agent command>'
export MADGRIX_MODEL_NAME='<model/harness identity>'
export MADGRIX_HIDDEN_TEST_COMMAND='<independent test command>'
```

Then:

```bash
npm run live:e2e
```

A successful run ends with:

```
MADGRIX_LIVE_E2E_OK
```

and writes a promotion bundle (default
`.madgrix-live/promotion.bundle`). The orchestrator also invokes the offline
verifier. Archive the terminal transcript and bundle as competition evidence.

## Live validation already completed

Real Cloudflare Artifacts primitives were exercised on 2026-10-01:

| Primitive | Result |
|---|---|
| Repository creation | validated |
| Git push / clone | validated |
| READ-scoped token | clone/fetch allowed; push rejected |
| WRITE-scoped token | push allowed |
| Token revocation | subsequent write rejected after revocation propagated |
| Repository fork endpoint | Cloudflare beta returned 400 `[10101] Invalid repo name` for tested repositories |
| Import fallback | implemented: create isolated repo and import the exact baseline commit |

The fork error is treated as a beta/platform condition, not hidden. MADGRIX
attempts the native fork first and falls back only on the documented beta error
signature.

## Exact-state promotion invariant

A successful promotion must satisfy all of these conditions:

1. the permit is valid and unconsumed;
2. the destination HEAD equals the permit-bound expected parent;
3. the source commit equals `winner_candidate_sha`;
4. the trusted container recomputes `tree-digest/v1` and it equals
   `winning_tree_sha256`;
5. the reviewed candidate descends from the expected destination parent;
6. the canonical push fast-forwards to **that candidate commit itself**;
7. authority consumes the permit only after the canonical write is known to
   exist.

A retry after a lost response reconciles `ALREADY_WRITTEN` if the exact
candidate is already canonical. A destination race, tree mismatch, or baseline
mismatch fails closed.

## Current evidence status

| Item | Status |
|---|---|
| TypeScript strict typecheck | validated in CI |
| Cloudflare Worker + Container build | validated in CI |
| Unit/integration suite | 110/110 |
| Deterministic vertical slice | `SLICE OK` |
| Destination-head race loop | `HEAD-MOVE OK` |
| Adversarial harness | 26/26, `zero_tolerance_ok=true` |
| Real Artifacts primitives | validated as listed above |
| Real deployed MADGRIX E2E | **pending account deployment/run** |
| Real SWE-bench/SpecBench benchmark | pending; protocol is pre-registered |
| Production Sigstore/KMS signing | future hardening; competition bundle uses Ed25519 DSSE |

Do not describe the pending rows as completed until their artifacts exist.
