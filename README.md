# MADGRIX

**A governed promotion protocol for autonomous software agents** — built on Cloudflare Workers, Artifacts, Queues, Durable Objects, Workflows, and Containers.

MADGRIX turns concurrent agent work into a controlled software-change pipeline:

```
INTENT → work claims → isolated contenders → independent evidence
       → VERDICT SEAM → exact-state permit → canonical promotion
       → verifiable history
```

Git records *what changed*. MADGRIX records why the work began, what alternatives were tried, what was independently checked, why one candidate was allowed to ship, and whether the state that shipped is exactly the state that was reviewed.

## Why it exists

Fork-per-agent is becoming commodity infrastructure. The difficult problem is **adjudication plus enforcement**:

1. **Competing implementations.** Multiple agents can work on one frozen task in isolated Artifact repositories.
2. **Intent before action.** Each agent registers a machine-readable WorkClaim before writing code; deterministic conflict logic tracks path, symbol, dependency, contract, interface, and schema interactions.
3. **Independent evidence.** Candidate evidence enters through a separately authenticated evaluation domain with read-only repository credentials.
4. **No LLM authority.** Mandatory gates are non-compensatory. A security, provenance, tamper, or correctness failure cannot be outweighed by style or plausibility.
5. **Blind verification.** Verifiers commit a ReferenceReport before candidates are exposed, receive anonymized labels, reveal once, and submit signed reports. Invalid reveal means inadmissible; no rewritten retry.
6. **Exact-state promotion.** A single-use permit binds task, baseline, candidate tree digest, evaluation bundle, policy, and destination HEAD.
7. **Proof after shipping.** Promotion evidence is encoded as in-toto-style statements in DSSE envelopes, signed by the task authority at promotion together with its hash-chained ledger head, and checked offline against a pinned copy of the authority key (`keys/README.md`).

## Trust model

MADGRIX separates five trust zones:

```
Control plane
    │
    ├── Contender repositories / agent work
    │
    ├── Independent evaluation domain
    │
    ├── Verdict plane
    │
    └── Promotion service ──► canonical repository
```

Runtime identities are also separated:

- `AGENT_SERVICE_TOKEN` — WorkClaim/context/contender operations.
- Per-agent secret — issued once per enrolled agent by `POST /tasks`; every `/claim` and `/contenders` call presents it in `X-Madgrix-Agent-Secret`, and `/contenders` derives the agent from it, so a contender's write token is minted once, to that agent.
- `EVALUATION_SERVICE_TOKEN` — read-only evaluator credentials and evidence submission.
- `CONTROL_SERVICE_TOKEN` — task freeze, verifier protocol, verdict, and promotion.
- Artifacts repo tokens are short-lived and scoped to one repository and one access level.

Only the promotion path receives canonical write authority.

## Competition-critical implementation

The production path now includes:

- Real Artifacts binding through `ArtifactsPort`.
- WorkClaim registration before agent execution.
- Cloudflare Artifacts fork attempt plus a documented **baseline-copy fallback** for the current beta fork-endpoint failure observed during live Artifacts validation.
- Official `cf.artifacts.repo.pushed` envelope normalization.
- Queue → per-task Durable Object event routing and content-derived deduplication.
- Real Verdict Seam route; no `501` placeholder.
- Authority-owned candidate anonymization.
- Signed blind-verifier report validation.
- Exact-state permits.
- Trusted Cloudflare Container with Git for canonical promotion.
- Bit-for-bit promotion of the **reviewed candidate commit SHA**.
- HEAD-race protection through the permit plus Git fast-forward compare-and-swap.
- Durable `PromotionWorkflow` retry wrapper.
- External real-agent runner.
- Independent real-candidate evaluator.
- Full live-infrastructure orchestrator: `npm run live:e2e`.
- Offline promotion-bundle verifier that trusts only a pinned authority key, never the key embedded in a bundle.

### What has actually been validated

On GitHub Actions for the competition branch:

```
npm run typecheck        PASS
npm run build            PASS
npm test                 110 tests / 27 suites / 0 failures
npm run slice            SLICE OK
npm run headmove         HEAD-MOVE OK
npm run bench            26/26 adversarial trials; zero_tolerance_ok=true
```

The Cloudflare build includes the Worker and trusted promotion-container image.

Separately, real Cloudflare Artifacts validation has already demonstrated repository creation, Git push/clone, scoped read/write tokens, and token revocation. The beta repository `fork()` endpoint returned a Cloudflare server error during that validation, which is why MADGRIX carries the explicit baseline-copy fallback.

### What is **not** claimed yet

The new production path has **not yet been deployed and run end-to-end against the user's Cloudflare account** from this development environment. The remaining proof step is:

```
real deployed Worker
→ real task
→ 3 real agents
→ 3 real Artifact repos
→ real pushed events
→ Queue
→ TaskAuthority
→ independent evaluation
→ blind verifier reports
→ Verdict Seam
→ exact candidate promotion
→ promotion.bundle
→ VERIFIED
```

`npm run live:e2e` is written to execute exactly that path and fails if real Artifact push events do not arrive.

The ordinary benchmark stratum remains synthetic harness validation, **not evidence** of real-world accuracy uplift. The real SWE-bench/SpecBench procedure is pre-registered in `docs/BENCHMARK_RUNBOOK.md`.

Production Sigstore signing is also future hardening; the current competition verifier uses a long-lived Ed25519 authority key (`AUTHORITY_SIGNING_KEY`, public half pinned in `keys/authority.pub`) with the same DSSE envelope structure. No production key has been provisioned yet.

## Local verification

Requirements: Node 24, npm, Git, Docker for the Cloudflare container build.

```bash
npm install
npm run typecheck
npm run build
npm test
npm run slice
npm run headmove
npm run verify -- --trust-key .slice-output/authority.pub .slice-output/promotion.bundle
npm run bench
```

Expected test summary at the current competition-critical branch:

```
tests 256
suites 80
pass 256
fail 0
```

## Real competition run

The live path intentionally does not use `FakeArtifacts`.

High-level prerequisites:

1. Deploy the Worker with the `ARTIFACTS`, `TASK_AUTHORITY`, promotion-container, Workflow, Queue, and four secret bindings (three service tokens and `AUTHORITY_SIGNING_KEY`) declared in `cloudflare.config.ts`, and commit the matching `keys/authority.pub` (`keys/README.md`).
2. Configure Artifact push events from the competition namespace into `madgrix-events`.
3. Have a baseline Artifact repository and exact baseline commit.
4. Provide a real coding-agent command that writes its tool-status log (`specs/amendments/tool-status-v1.md`; for Claude Code, pipe `claude -p ... --output-format stream-json --verbose` through `scripts/adapters/claude-code-tool-log.mjs`), the claim scope (`MADGRIX_CLAIM_PATHS`; `"**"` is refused), and independent evaluation commands.

Then run:

```bash
npm run live:e2e
```

The orchestrator requires environment variables documented at the top of `scripts/live-e2e.ts`. It freezes verifier keys before candidate creation, launches three agents concurrently, waits for real push-event delivery, evaluates immutable candidate SHAs independently, runs the Verdict Seam, promotes the exact reviewed commit, fetches the promotion bundle the TaskAuthority signed (`GET /tasks/:id/bundle`), and verifies it offline against the pinned authority key (`MADGRIX_TRUST_KEY`, else `keys/authority.pub`).

Provider-specific coding agents are deliberately not hardcoded. `MADGRIX_AGENT_COMMAND` may invoke Codex, Claude Code, Aider, an AOS/Agent-Fleet runner, or another coding-agent command.

## API surface

| Method | Route | Identity | Purpose |
|---|---|---|---|
| POST | `/tasks` | CONTROL | Freeze task + verifier/operator keys; enroll `agent_ids`, returning each agent's secret once |
| GET | `/tasks/:id/context` | AGENT/CONTROL | Frozen task, claims, contender summaries |
| POST | `/tasks/:id/claim` | AGENT/CONTROL + `X-Madgrix-Agent-Secret` | Register an enrolled agent's WorkClaim + conflict findings |
| POST | `/tasks/:id/contenders` | AGENT/CONTROL + `X-Madgrix-Agent-Secret` | Create the calling agent's contender repo + scoped write token (once per contender) |
| POST | `/tasks/:id/evaluator-credentials` | EVALUATION | Mint short-lived read-only candidate credential |
| POST | `/tasks/:id/evidence` | EVALUATION | Submit content-addressed evaluation bundle for the contender's latest observed commit; a replacement bundle is refused (409) once the candidate is labeled |
| POST | `/tasks/:id/verifiers/commit` | CONTROL | Record blind-verifier commitment |
| POST | `/tasks/:id/verifiers/labels` | CONTROL | Assign anonymized candidate labels after commitments |
| POST | `/tasks/:id/verifiers/reveal` | CONTROL | Validate one-time reveal |
| POST | `/tasks/:id/verifiers/report` | CONTROL | Submit signed verifier report |
| POST | `/tasks/:id/verdict` | CONTROL | Execute Verdict Seam and issue permit on ACCEPT (409 `REBASE_REQUIRED` when the destination moved past the winner's base) |
| POST | `/tasks/:id/rebase` | CONTROL | Rebase a contender's latest commit onto the destination head; the new commit is pushed to its fork and must be evaluated again |
| POST | `/tasks/:id/promote` | CONTROL | Exact-state canonical promotion |
| GET | `/tasks/:id/bundle` | CONTROL | Promotion bundle the task authority signed at finalize |
| GET | `/tasks/:id/ledger` | current route | Task ledger |

The task authority also exposes internal RPC transitions for queue ingestion, permit issuance, verdict execution, and post-write promotion finalization.

## Exact-state promotion

Promotion preserves the reviewed candidate Git identity.

The trusted container:

1. fetches the permit-bound destination HEAD,
2. fetches the exact winner candidate SHA,
3. recomputes `tree-digest/v1`,
4. rejects a tree mismatch,
5. rejects a foreign destination-head move,
6. verifies the candidate descends from the permit-bound destination,
7. fast-forward pushes the **candidate SHA itself** to canonical `main`,
8. lets the Durable Object consume the permit only after the canonical write is known to exist.

A retry after a lost response finds the candidate already in canonical history, even under later commits, and reconciles as `ALREADY_WRITTEN`; it does not create a second change. The result names `BASE` (the permit-bound head) and `PARENT` (the candidate's own parent, read from git); the signed ship record carries both.

If the destination moved after the verdict, the permit expires and the same commit gets no new permit at the new head (`REBASE_REQUIRED`): the task authority only binds a head the candidate is known to descend from. `container/rebase.sh` replays the candidate onto the new head and pushes the result to the contender's fork as a new commit; that commit is evaluated again before it can get a permit. Conflicts escalate to the operator-of-record with the conflicting paths as data (`specs/amendments/rebase-ancestry-v1.md`). `test/promotion-fixtures.test.ts` runs both scripts against real git repositories, on a fixture table the in-memory harnesses' model must also pass.

`tree-digest/v1` is specified in `specs/amendments/tree-digest-v1.md`.

## Repository layout

```
src/
  lib/                    protocol + deterministic policy
  do/TaskAuthority.ts     authoritative per-task state machine
  do/PromotionContainer.ts trusted Git promotion container
  worker/index.ts         Cloudflare Worker + Queue + Workflow
  harness/                deterministic local protocol proofs
  cli/verify.ts           offline promotion-bundle verifier

container/
  Dockerfile
  promote.sh
  rebase.sh
  copy-baseline.sh

scripts/
  run-contenders.mjs      concurrent real-agent runner
  evaluate-candidate.ts   independent evaluation-domain runner
  live-e2e.ts             complete real Cloudflare competition path

test/                     unit/integration/adversarial tests
specs/                    engineering contracts + amendments
research/                 research report
docs/                     architecture, deployment, security, demo, benchmark
```

## Evidence discipline

MADGRIX deliberately distinguishes:

- **Implemented + CI-validated**
- **Live Artifacts primitive validated**
- **Live deployed MADGRIX E2E pending**
- **Synthetic benchmark harness**
- **Future production hardening**

Do not turn one category into another in demos, docs, or benchmark claims.

## License

MIT — see [LICENSE](LICENSE).
