# Seam (internal codename)

**A governed promotion protocol for autonomous software agents** — built on Cloudflare Workers + Durable Objects.

"Seam" is an internal codename, not a public brand (the name is crowded and trademark-risky). "Verdict Seam" is kept only as in-architecture terminology for the verdict policy layer.

Git records *what changed*. Seam adds, for autonomous work: *why it began, what alternatives existed, what each claimed, what was independently verified, why one was chosen, what authority permitted shipping — and whether the shipped state is exactly the reviewed state.*

```
INTENT → competing implementations → independent evidence
       → VERDICT → exact-state authorization → promotion → verifiable history
```

## What this repo actually is (honest status)

This is a **locally runnable prototype**, not a production deployment:

- **Real, production-shaped logic:** the protocol layer (`src/lib/`) is the actual
  state machine — task lifecycle, claim classification, evaluation/admission gates,
  blind-verifier commit→reveal, the verdict seam (eligibility gates → objective
  dominance → blind 2-of-3 vote), exact-state single-consume permits, quarantine
  lifecycle, and the in-toto attestation chain with Ed25519 DSSE signatures.
- **Fake substrate:** `FakeArtifacts` implements the `ArtifactsPort` interface
  (repos, scoped bearer tokens, content-addressed commits, queue events) in memory.
  Nothing touches real git, Cloudflare, or the network. The platform layer
  (`src/do/TaskAuthority.ts`, `src/worker/index.ts`) is written against the port,
  so production can swap in real Artifacts without changing protocol logic.
- **Simulated agents:** the slice's "contenders" and "verifiers" are deterministic
  harness code, not LLMs. The blind-verifier ordering guarantee (commit before
  seeing candidates, no retry after an invalid reveal) is real; the judgments are
  scripted.
- **Frozen specs:** `../specs/` holds the FROZEN-v1 protocol specs. Never silently
  change a frozen contract while implementing — open a spec amendment with the
  failing invariant and the proposed change instead.

## Quickstart

```bash
npm install
npm run typecheck   # must pass
npm run slice       # full vertical slice: task → claims → forks → evaluation
                    # → blind verifiers → verdict → permit → promotion
                    # → signed bundle → offline verification. Ends with SLICE OK.
npm test            # 70 tests, 20 suites — includes the slice as an integration test
npm run bench -- --quick   # benchmark harness (synthetic/harness-validation only)
npm run verify -- .slice-output/promotion.bundle   # offline bundle verification
```

`npm run slice` writes `.slice-output/promotion.bundle` (gitignored). No credentials,
no network, no deploys. Node 24 type-stripping runs the `.ts` sources directly.

> Note: `node --test test/` (directory form) fails on this Node build
> (`Cannot find module '…/test'`), so the `test` script uses the equivalent glob
> `node --test "test/**/*.test.ts"`, which runs the identical test set.

## The vertical slice

`src/harness/slice.ts` (`runSlice()`) is the proof the whole protocol works together —
one realistic task ("`isTokenExpired` returns true iff `exp <= now`"), three contenders
(one correct, one subtly wrong at the boundary, one that tampers with test material),
four blind verifiers (one reveals with the wrong nonce → inadmissible, no retry):

1. **Freeze task** — intent → task record → task authority (task_hash pins
   intent, baseline, policy).
2. **Work claims** — 3 registrations; contract conflict on `JWTClaims` classifies
   RED (proceed-with-awareness, counted in blast radius).
3. **Forks** — idempotent fork per contender, 3600s write-scoped tokens.
4. **Contender work** — pushes via the fake git-protocol stand-in.
5. **Queue ingestion** — at-least-once delivery, dedupe (`ACK_DUP`), out-of-order
   rejection.
6. **Evaluation** — admission gates, hidden oracle, manifest-hash tamper →
   mechanical quarantine (token revoked, downstream effects canceled).
7. **Blind verifiers** — commit → anonymized judging → reveal → report; invalid
   reveal is inadmissible with no retry (frozen rule).
8. **Verdict seam** — eligibility gates, objective dominance
   (correctness → regressions → security → blast radius → minimality), then blind
   2-of-3 vote → `ACCEPT` with contender-1 the unique dominant candidate.
9. **Permit + promotion** — single-use exact-state permit; replay is a no-op
   `ALREADY_CONSUMED` ACK; canonical head unchanged.
10. **Attestation** — in-toto link → test result → verification result →
    authority predicate, all DSSE-signed into one bundle.
11. **Offline verify** — `node src/cli/verify.ts` prints the exact 8-line
    transcript and exits 0 (`VERIFIED`) or 1 (`NOT VERIFIED`).

Any unexpected outcome fails the slice with a non-zero exit and a clear message.

## API surface

Worker (`src/worker/index.ts`):

| Method | Route | What it does |
|---|---|---|
| POST | `/tasks` | Register intent → `task_id`, `task_hash` |
| POST | `/tasks/:id/claim` | Register work claim → conflict classification |
| POST | `/tasks/:id/contenders` | Fork baseline per agent → fork repo + short-lived write token |
| POST | `/tasks/:id/evidence` | Submit evaluation bundle for a contender |
| POST | `/tasks/:id/verdict` | Run the verdict seam across contenders |
| POST | `/tasks/:id/promote` | Present a permit → exact-state, single-consume promotion |
| GET | `/tasks/:id/ledger` | Verifiable history for the task |
| GET | `/tasks/:id/attestation/:pid/verify` | Offline attestation verification data |

Durable Object (`src/do/TaskAuthority.ts`) exposes `POST /init`, `/event`,
`/claim`, `/contender`, `/evidence` and `GET /state`. `/claim` rejects bodies
that carry a `work_id` (authority-issued only) and returns the conflict list;
`/evidence` runs the real evaluation submission against the state machine
(422 on task mismatch).

## Benchmark harness

`npm run bench` runs `src/lib/benchmark.ts` — a **synthetic, harness-validation**
implementation of `../specs/BENCHMARK_PROTOCOL.md`, not the real benchmark:

- Ordinary stratum: 20 tasks × 3 contenders (6×3 with `--quick`), seeded PRNG,
  arms B/C/D over identical fixed candidate sets, Selection Regret + paired
  bootstrap CIs. The ≥25% D-vs-C precommit is **reported, not exit-gated** —
  manufacturing it as evidence would be dishonest.
- Adversarial stratum: 26 trials (13 attack classes × 2) against the **real**
  protocol modules — zero-tolerance checks (no false/stale/duplicate/quarantined
  promotions, 100% fail-closed).
- Conflict stratum: 30 labeled claim pairs through the real classifier,
  precision/recall/FPR with 95% CIs, as-measured.

Nothing here is evidence for the competition claim; the report says so on every
page. The full benchmark on real datasets (SWE-bench etc.) is future work.

## Design notes

- **Fail-closed.** Missing evidence abstains or rejects; nothing is accepted on narration.
- **Blind verifiers.** Commit before seeing candidates; a wrong reveal is
  inadmissible, with no retry and no rewritten opinions.
- **Evaluation plane isolation.** Contenders hold write tokens on their forks only —
  never on the baseline, the evaluation material, policy, or the ledger. The slice
  demonstrates a write attempt via a READ token → `SCOPE_DENIED`.
- **Idempotent promotion.** The same permit presented twice returns
  `ALREADY_CONSUMED` (no-op ACK): no duplicate promotions, no duplicate effects,
  canonical head unchanged.
- **Mechanical quarantine only.** Agent accusation is never a trigger; revocation
  cancels side effects, freezes evidence, and taints downstream. Quarantined state
  can never be promoted.

## Layout

```
src/
  lib/            protocol layer (state machines, pure where possible)
    task-state.ts     task + authority lifecycle (transitions are async)
    claims.ts         work-claim registration + conflict classification
    evaluation.ts     evaluation bundles + admission gates
    verifiers.ts      commit→judge→reveal protocol + deterministic verifiers
    verdict-seam.ts   eligibility gates → dominance ranking → blind 2-of-3 vote
    permit.ts         exact-state single-consume permits
    attestation.ts    in-toto chain + DSSE envelopes + promotion bundle
    artifacts-port.ts platform interface
    fake-artifacts.ts in-memory platform substrate (NOT production)
    benchmark.ts      synthetic/harness-validation benchmark (NOT evidence)
  do/             TaskAuthority Durable Object (platform layer)
  worker/         Worker fetch router (platform layer)
  harness/        the vertical slice (src/harness/slice.ts)
  cli/            offline bundle verifier (src/cli/verify.ts)
test/             unit tests + slice integration test
../specs/         FROZEN-v1 protocol specs (amendment-only)
```

Conventions: TypeScript strict, erasable syntax only, `.ts` import extensions,
`import type` for type-only imports.

## License

MIT — see [LICENSE](LICENSE).
