# Competition finalization

Baseline recorded before any code change in this pass. Later sections of this
file are updated only when a later commit changes the fact.

Status words used below:

- **IMPLEMENTED** — the behavior is in the tree at the SHA named in that section.
- **TESTED LOCALLY** — a command in this session exercised it. The command and the result are named.
- **TESTED ON CLOUDFLARE** — a deployed Worker, Artifact, Queue, Durable Object, Workflow, or Container run produced the result. A local fake does not count.
- **NOT YET VERIFIED** — not exercised by a command in this session, or exercised only against a stand-in.

## Baseline SHA

| Item | Value |
|---|---|
| Repository | https://github.com/YashwanthGathuku/Madgrix |
| Branch | `git4agents/combined` |
| SHA | `4d9790599e44e853f637961bde1f8a2369042d6e` |
| Subject | Gate the combined commit on a TheUstad FINAL VERIFIED run. |
| `origin/main` | `f68c250488ccdd70a3da76ca4e26e35c451bd044` |
| Merge base | `6a03a3ce9b1f16cdd1c545fb2c783a96c77515c8` |
| Ahead of `origin/main` | 85 commits |
| Behind `origin/main` | 1 commit: `f68c250` Finish MADGRIX competition-critical production path |
| Working tree at record time | clean, tracking `origin/git4agents/combined` |

`git fetch --all --prune` was run on 2026-10-06 before these SHAs were read. The previously observed tip `4d9790599e44e853f637961bde1f8a2369042d6e` was still current.

Recent commits on `git4agents/combined`:

```
4d97905 2026-10-04 Gate the combined commit on a TheUstad FINAL VERIFIED run.
cc1ef1b 2026-10-04 Apply both sub-agent edits when their changed lines do not overlap.
2bf17d8 2026-10-04 Document the git problems that actually showed up, and the smallest fixes before the deadline.
0d6cd13 2026-10-04 Let one parent fork host role-scoped sub-agents and promote their combined SHA.
1ad3804 2026-10-04 Launch contenders from the Agentfleet manifest instead of a hardcoded trio.
f2346ed 2026-10-04 fix: wait for a new Artifacts subscription before the contender push
66610ce 2026-10-04 fix: confirm contender forks with readCommit, not getHead or log
a88c4e8 2026-10-04 fix: read fork tips with ArtifactsRepo.log, not RPC getHead
7d9122f 2026-10-04 promotion: run each permit's promotion in a Workflow instance
c01b837 2026-10-03 promotion: permits only at heads the candidate descends from
```

`docs/GIT_PROBLEMS.md` still names tip `0d6cd130`. Commits after it changed same-file merge (`cc1ef1b`) and vendored TheUstad as a baseline gate (`4d97905`). That document is a historical plan, not a description of this SHA.

## Environments

### Windows host (checkout used for editing)

- OS: Windows, PowerShell
- Node: v22.17.0 (does not strip TypeScript types unless `--experimental-strip-types` is set)
- npm: 10.9.2
- Git: 2.55.0.windows.5, `core.autocrlf=true`
- Working tree line endings: CRLF. Git blobs for `container/promote.sh` are LF (`git ls-files --eol` shows `i/lf w/crlf`, blob CR count 0).
- `python3`: WindowsApps store stub. `python` is 3.13.5. `py -3` is 3.14.7.
- Docker: not installed
- `bash`: WSL GNU bash 5.2.21

Commands on this checkout, 2026-10-06:

| Command | Result |
|---|---|
| `npm ci` | exit 0 |
| `npm run typecheck` | **FAIL** exit 1. `scripts/lib/fork-crew.mjs(406)` TS7006 on `repo`, `crew`, `runSub`. The JSDoc for `runCrewOnFork` sits above `THEUSTAD_MIT_COMMIT`, so `checkJs` does not apply it. `npx tsc --noEmit` (src project only) is clean. |
| `node --check scripts/evaluate-candidate.ts` | **FAIL**. Node 22.17.0: `ERR_UNKNOWN_FILE_EXTENSION` for `.ts`. |
| `bash -n container/promote.sh` | **FAIL** exit 2. CRLF checkout: `syntax error near unexpected token done`. |
| `npm test` | **FAIL**. Every suite failed to load: same `.ts` extension error. This is not a protocol failure. |
| `npm run slice`, `headmove`, `bench` | **FAIL** for the same Node 22.17.0 type-stripping reason. Not a measured protocol result. |

### Linux-compatible rerun of the same SHA

WSL Ubuntu, Node **v24.21.0** unpacked at `/tmp/node24` (the version named in `README.md` and `.github/workflows/ci.yml`), npm 11.19.0, Python 3.12.3, Git 2.43.0. Fresh clone of this SHA at `/tmp/madgrix-baseline`. `container/promote.sh` CR count 0. Docker not installed. PATH excluded Windows `npm`.

| Command | Result |
|---|---|
| `npm ci` | exit 0. npm reported 5 high severity audit findings. Not investigated. Not treated as a functional failure. |
| `npm run typecheck` | **FAIL** exit 1. Same three TS7006 errors. |
| `npx tsc --noEmit` | exit 0 |
| `node --check` on `scripts/run-contenders.mjs`, `scripts/evaluate-candidate.ts`, `scripts/live-e2e.ts`, `scripts/adapters/claude-code-tool-log.mjs`, `scripts/run-fork-crew.mjs`, `scripts/lib/fork-crew.mjs` | exit 0 |
| `bash -n` on `container/promote.sh`, `container/rebase.sh`, `container/copy-baseline.sh` | exit 0 |
| `npm test` | **PASS**. `tests 289`, `suites 89`, `pass 289`, `fail 0`, `cancelled 0`, `skipped 0`, `duration_ms 10417.950898` |
| `npm run slice` | **PASS**. `SLICE OK` |
| `npm run headmove` | **PASS**. `HEAD-MOVE OK: the same SHA is refused at the moved head; only the rebased SHA was promoted.` |
| `npm run bench` | **PASS**. `trials_passed 26`, `trials_total 26`, `zero_tolerance_ok true`. The benchmark text labels the ordinary stratum synthetic. |
| `npm run build` | **PARTIAL**. Vite built the Worker bundle (`.cloudflare/output/v0/workers/default/bundle/index.js`, 188.20 kB). **FAIL** exit 1 after that: `UserError: The Docker CLI is needed to build the configured image`. No container image was built. |

Fork-crew, promotion-fixture, rebase, environment-isolation, evaluator-isolation, forged-bundle, and TheUstad baseline-gate tests are inside `npm test`. On this run they are part of the 289 passes. They were not executed as separate processes.

`npm run live:e2e` was **not** run. It needs deployed credentials and would talk to a live account. No deploy was performed.

Unauthenticated `GET https://madgrix.ygathuku96.workers.dev/` on 2026-10-06 returned `{"error":"not_found","path":"/"}`. That matches the root behavior described in `docs/GIT_PROBLEMS.md`. It does not identify which SHA is deployed. **NOT YET VERIFIED** as a run of this SHA.

## Frozen contracts

`specs/FROZEN.json` names these hashes. They were not edited in this baseline.

- `PROMOTION_PROTOCOL.md` `sha256:05e807bbcffe01d6465397f1bef38b49f4c6aa45202e5effe568befe8ef7b34f`
- `EVALUATION_THREAT_MODEL.md` `sha256:4c1bfdaa51745639c7cbbf0ae5a38005c041498d0934b78ee1ed6dd1c3a03e4c`
- `CLOUDFLARE_RUNTIME_MODEL.md` `sha256:3f1dc83ebe0f8c9276f259c6561475f231bb564ba012f498f8029e71a9294ae3`

Amendments live in `specs/amendments/`. They are the only allowed semantic changes to those contracts. `test/frozen-specs.test.ts` passed inside the 289.

## Audit at `4d979059`

Classification is of the tree at the baseline SHA. "Tested locally" means the Node 24 suite above, which uses `FakeArtifacts`, in-memory Durable Object storage, a fake Workflow binding, and fake Container APIs except where a test runs `container/promote.sh` or `container/rebase.sh` against local git.

### P0 — must fail closed

| ID | Finding at baseline | Status |
|---|---|---|
| P0-A | Coding-agent and evaluator children are spawned with `minimalEnv()` (`scripts/lib/child-env.mjs`). Allowlist rejects `MADGRIX_*`, `SERVICE_TOKEN`, and `CLOUDFLARE` / `CF_*` names. `test/env-isolation.test.ts` passed. | **IMPLEMENTED. TESTED LOCALLY.** Not an OS boundary: the agent runs as the operator user. **NOT TESTED ON CLOUDFLARE.** |
| P0-B | `/claim` and `/contenders` derive the agent from `X-Madgrix-Agent-Secret`. A body `agent_id` that disagrees is 403. Contender id is `H(task, agent)`. Enrollment tests passed. | **IMPLEMENTED. TESTED LOCALLY.** Fork crew then puts every sub-agent in one parent checkout. That is not a second Artifacts write token, and it is not a separate microVM. **NOT TESTED ON CLOUDFLARE.** |
| P0-C | Evaluator rebuilds the run directory from the baseline's runner config and tests. A candidate `package.json` `"test": "exit 0"` fails `no_eval_tampering`. Evidence naming changed eval files quarantines. | **IMPLEMENTED. TESTED LOCALLY.** White-box caveat in `docs/SECURITY.md` still applies: candidate code runs beside hidden tests. **NOT TESTED ON CLOUDFLARE.** |
| P0-D | `src/cli/verify.ts` verifies with a pinned key (`--trust-key` or `keys/authority.pub`). The bundle's embedded key must match. Forged-bundle tests passed. | **IMPLEMENTED. TESTED LOCALLY.** **NOT TESTED ON CLOUDFLARE.** |
| P0-E | Permit id binds task, baseline, tree, bundle, policy, destination head. Promotion checks consumed, head, tree, bundle hash, quarantine. Rebase produces a new SHA; the old SHA is `REBASE_REQUIRED` at the new head. `HEAD-MOVE OK`. | **IMPLEMENTED. TESTED LOCALLY.** **NOT TESTED ON CLOUDFLARE.** |
| P0-F | Queue ingest dedupes `event_key = SHA256(namespace \|\| repo \|\| ref \|\| before \|\| after)`. Duplicate delivery is `ACK_DUP`. Unknown repo is `REJECTED_OUT_OF_ORDER` and still recorded. Permit replay is `ALREADY_CONSUMED`. | **IMPLEMENTED. TESTED LOCALLY** against in-memory delivery. Real Queue redelivery **NOT YET VERIFIED.** |
| P0-G | Overlapping sub-agent edits become an ordinary commit. `combineSubagentBranches` writes conflict markers into the file and commits it with `resolution: "conflict-both-intents-kept"`. `run-fork-crew.mjs` pushes that SHA as `candidate_sha`. Nothing in `issuePermit` refuses it. | **NOT IMPLEMENTED.** A known unresolved conflict can be pushed as a normal candidate. This is the competition gap. |
| P0-H | Contender credentials are minted on the fork repo only. `executeEffects` does not perform `canonical_write`; it logs and skips. Canonical fast-forward is `container/promote.sh`, invoked from the promotion path. FakeArtifacts tests deny cross-repo and read-scoped pushes. | **IMPLEMENTED** in the Worker and scripts. **TESTED LOCALLY** against fakes and local git. Live Artifacts token scope for this SHA **NOT YET VERIFIED.** |

### P1 — competition flow

| ID | Finding at baseline | Status |
|---|---|---|
| P1-A | `GET /tasks/:id/context` returns the frozen task, public claims, and contender id, agent, fork, claim, latest commit, status. Conflict reports are returned once from `POST /claim` and are not stored on `AuthorityState`. No parent/crew, dependency, or composition field. | **PARTIAL. TESTED LOCALLY** only as part of route tests that hit context indirectly. A live graph a judge can read is **NOT IMPLEMENTED.** |
| P1-B | Fork crew: one parent fork, sub-agent branches, disjoint files and non-overlapping lines in one file combine. Commands run one after another in one worktree. | **IMPLEMENTED. TESTED LOCALLY.** Concurrency is sequential. **NOT TESTED ON CLOUDFLARE.** `live:e2e` does not run this path in the recorded suite. |
| P1-C | Record values are `"combined"` and `"conflict-both-intents-kept"`. There is no authority state `COMPOSED` or `CONFLICTED`. | **NOT IMPLEMENTED** as a fail-closed protocol state. |
| P1-D | No resolver lane. Markers are the end state. | **NOT IMPLEMENTED.** |
| P1-E | `POST /tasks/:id/rebase` replays onto the destination and records a new SHA. Permits bind only a head the candidate descends from. Old evidence does not authorize the new SHA. | **IMPLEMENTED. TESTED LOCALLY** (`rebase-ancestry`, `rebase-route`, `headmove`, promotion fixtures). **NOT TESTED ON CLOUDFLARE.** |
| P1-F | `verifyFrozenBaseline` runs `third_party/theustad/theustad.py` before the combine commit. The verifier command is `scripts/theustad-baseline-check.py`: exit 0 only when `HEAD` is the expected baseline and the worktree is clean. It does not inspect the composed candidate. | **IMPLEMENTED** as a baseline-identity gate. **TESTED LOCALLY** (fork-crew test expects `FINAL FALSIFIED` for a wrong baseline). It is **not** an independent evaluation of candidate behavior. Do not describe it as one. |
| P1-G | Combined commits carry `.madgrix/subagent-intents.json` (agent id, role, intent, paths, claim work id, SHA). `GET /context` returns frozen intent and claims. | **PARTIAL. TESTED LOCALLY** for the intents file. Preservation across a deleted workspace is true only for what was committed. |
| P1-H | `scripts/live-e2e.ts` is the live orchestrator. It was not run. Worker bundle built. Container image did not build (no Docker). Queue, Workflow, Container, and Artifacts behavior of this SHA were not observed on Cloudflare. | **NOT YET VERIFIED.** The public worker root answers `not_found`. That is not an end-to-end run. |

### P2

| ID | Finding |
|---|---|
| P2 UI | No work-graph page. `GET /` is `not_found` by design. |
| P2 observability | Promotion and quarantine notify via `console.log`. No other channel. |
| P2 docs | `README.md` still says 281 tests and "nothing has been deployed". This run is 289 tests. `docs/DEMO_SCRIPT.md` still says 74 tests. `docs/GIT_PROBLEMS.md` predates TheUstad and the non-overlapping same-file merge. |
| P2 demo fixture | `configs/git4agents-fork-crew.json` has `sub-api` and `sub-ui` only. No test/integration agent, no deliberate conflict fixture, no resolution step. |
| P2 developer experience | Node 22.17 cannot run `npm test` without type stripping. Windows `autocrlf` breaks `bash -n` and the container scripts. CI is Node 24 on Ubuntu. |

## Risks

1. **P0-G.** Judges who overlap two agents get a commit full of conflict markers that the promotion path will treat as a normal tree if the other gates pass.
2. **Typecheck is red** on `tsconfig.node.json` at this SHA. CI on `main` and `codex/**` would fail this branch. CI does not run on `git4agents/combined`.
3. **Container image is unbuilt here.** `npm run build` cannot finish without Docker. Promotion-container behavior on Cloudflare is **NOT YET VERIFIED.**
4. **TheUstad gate is narrower than its commit subject.** It checks baseline identity, then the combine commit is created. A later candidate is not what TheUstad verified.
5. **Fork crew is one shared worktree, sequential.** An agent command can read sibling files. That matches the current design and does not match the frozen "one microVM per contender" picture for sub-agents.
6. **README deployment claim and `GIT_PROBLEMS.md` disagree.** This session confirmed only that the public hostname returns `not_found`. Deployed SHA is unknown.
7. **`origin/main` has one commit this branch does not** (`f68c250`). Not merged. This pass does not merge to `main`.

## What this pass will not do

No edit to the three frozen spec files. No deploy. No billing change. No new paid Cloudflare resource. No force-push. Local harness output will not be described as a Cloudflare result.
