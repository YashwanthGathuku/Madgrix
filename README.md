# Verdict Seam

**A governed promotion protocol for autonomous software agents** — built on Cloudflare Workers + Durable Objects.

"Verdict Seam" is the working name of the verdict policy layer. The repo's internal
codename is `seam/` (the folder keeps that name; it is not a public brand — the public
name is still undecided, see `docs/NAME_SHORTLIST.md`).

## What it is

A governed path from an agent's *intent* to shipped code:

```
INTENT → competing implementations → independent evidence
       → VERDICT → exact-state authorization → promotion → verifiable history
```

Git records *what changed*. Verdict Seam records everything else: *why the work began,
what alternatives were tried, what each one claimed, what was independently checked,
why one was chosen, what authority permitted shipping — and whether the shipped state
is exactly the reviewed state.*

## Why it matters

Giving each agent its own fork is commodity infrastructure now. The hard part — and the
invention here — is **adjudication plus enforcement**:

1. **Competing implementations, one task.** Several agents (contenders) tackle the same
   frozen task in isolated forks.
2. **Independent evidence.** Each candidate is tested against checks the agents never
   see, then judged by blind verifiers who score anonymized code.
3. **A verdict with fixed rules.** Selection follows a published order — correctness,
   then regressions, then security, then blast radius, then minimality — followed by a
   blind 2-of-3 vote. No vibes, no loudest-agent-wins, and ties mean *abstain*, not a
   coin flip.
4. **Exact-state authorization.** The permit to ship binds the *exact* reviewed code,
   baseline, and destination. If anything moved since the review, the permit dies.
5. **Proof you can check offline.** The whole chain is signed into a promotion bundle
   anyone can verify with no network and no trusted server.

Humans can resolve genuine ambiguities and trade-offs — but they can never override an
integrity gate (a failed test, a tampered file, a signature mismatch). Those require
starting over, not an exception.

## Architecture

Five trust zones with a strict credential matrix:

```
┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│ Control plane │ → │ Contender    │ → │ Evaluation   │ → │ Verdict      │ → │ Promotion    │
│ TaskAuthority │   │ microVMs     │   │ domain       │   │ plane        │   │ service      │
│ (Durable      │   │ (one fork    │   │ (hidden      │   │ (gates →      │   │ (sole        │
│  Object)      │   │  per agent)  │   │  oracles,    │   │  dominance →  │   │  canonical   │
└──────────────┘   └──────────────┘   │  blind       │   │  blind vote) │   │  writer)     │
                                      │  verifiers)  │   └──────────────┘   └──────────────┘
                                      └──────────────┘
```

Contenders hold short-lived write tokens for *their own fork only*. Verifiers get no
repo access at all. Only the promotion service can write canonical state, and it is
unreachable from contender sandboxes. Full detail with diagrams:
`docs/ARCHITECTURE.md`.

## Quickstart (fresh machine)

Requirements: **Node 24** (tested on v24.20.0), **npm 10**. Everything runs locally —
no credentials, no network, no deploys.

```bash
npm install
npm run typecheck                     # must pass
npm test                              # 74 tests, 20 suites
npm run slice                         # the full loop: task → claims → forks → evaluation
                                      # → blind verifiers → verdict → permit → promotion
                                      # → signed bundle → offline verification
                                      # ends with SLICE OK
npm run verify -- .slice-output/promotion.bundle   # offline check: 8-line transcript + VERIFIED
npm run bench -- --quick              # benchmark harness (synthetic / harness-validation only)
```

Notes:

- `npm run slice` writes `.slice-output/promotion.bundle` (gitignored). No credentials,
  no network, no deploys. Node 24 type-stripping runs the `.ts` sources directly.
- `node --test test/` (directory form) fails on this Node build
  (`Cannot find module '…/test'`), so the `test` script uses the equivalent glob
  `node --test "test/**/*.test.ts"`, which runs the identical test set.
- The slice's *outcomes* are deterministic (verdict ACCEPT, winner contender-1,
  quarantine, replay consumed, bundle VERIFIED) but its *IDs* are fresh each run: task
  hashes, nonces, tokens, and permit values differ run to run. Quote assertions, not hex.
  See `docs/DEMO_SCRIPT.md`.

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
   `ALREADY_CONSUMED` ACK; canonical head moves exactly once.
10. **Attestation** — in-toto link → test result → verification result →
    authority predicate, all DSSE-signed into one bundle.
11. **Offline verify** — `node src/cli/verify.ts` prints the exact 8-line
    transcript and exits 0 (`VERIFIED`) or 1 (`NOT VERIFIED`).

Any unexpected outcome fails the slice with a non-zero exit and a clear message.

## Honest limitations

- **In-memory Artifacts stand-in.** `FakeArtifacts` implements the `ArtifactsPort`
  interface (repos, scoped tokens, content-addressed commits, queue events) in memory.
  Nothing touches real git, Cloudflare, or the network. The platform layer
  (`src/do/TaskAuthority.ts`, `src/worker/index.ts`) is written against the port, so
  production swaps in real Artifacts without changing protocol logic.
- **Remote binding untested from this sandbox.** The port is written against the real
  Artifacts API, but no live Cloudflare end-to-end run has happened from here yet —
  that needs a direct-egress machine or deploy permission.
- **Deterministic verifier stand-ins.** The slice's "contenders" and "verifiers" are
  deterministic harness code, not LLMs. The ordering guarantees (commit before seeing
  candidates, no retry after an invalid reveal) are real; the judgments are scripted.
- **Ed25519 slice signer vs production Sigstore.** The slice signs with Ed25519; the
  DSSE envelope shape is identical to production's Sigstore path.
- **Frozen specs.** `../specs/` holds the protocol specs; specs 1, 3, and 5 are
  FROZEN-v1 (amendment-only). Never silently change a frozen contract while
  implementing — open a spec amendment with the failing invariant and the proposed
  change instead.

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
  never on the baseline, the evaluation material, policy, or the ledger.
- **Idempotent promotion.** The same permit presented twice returns
  `ALREADY_CONSUMED` (no-op ACK): no duplicate promotions, no duplicate effects,
  canonical head unchanged.
- **Mechanical quarantine only.** Agent accusation is never a trigger; revocation
  cancels side effects, freezes evidence, and taints downstream. Quarantined state
  can never be promoted.

## Docs

- `docs/DEMO_SCRIPT.md` — 7-minute narrated demo: exact commands, expected output,
  tamper-rejection showcase.
- `docs/ARCHITECTURE.md` — system architecture, with a mermaid diagram and a rendered
  SVG (`docs/architecture.svg`).
- `docs/SECURITY.md` — threat model: the 13-attack battery, trust zones, credential
  matrix, honest sandbox constraint, non-claims.
- `docs/NAME_SHORTLIST.md` — public-name candidates with collision verdicts (nothing
  renamed; decision pending).
- `docs/SUBMISSION_CHECKLIST.md` — competition requirements mapped to repo locations,
  plus remaining decisions.

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
docs/             submission docs (demo script, architecture, security, naming, checklist)
../specs/         FROZEN-v1 protocol specs (amendment-only)
```

Conventions: TypeScript strict, erasable syntax only, `.ts` import extensions,
`import type` for type-only imports.

## License

MIT — see [LICENSE](LICENSE).
