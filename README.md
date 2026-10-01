# Seam

**A governed promotion protocol for autonomous software agents** — built on Cloudflare Workers + Artifacts.

Git records *what changed*. Git hosting adds *who changed it, discussion, CI, approval*.
Seam adds, for autonomous work: *why it began, what alternatives existed, what each
claimed, what was independently verified, why one was chosen, what authority permitted
shipping — and whether the shipped state is exactly the reviewed state.*

```
INTENT → competing implementations → independent evidence
       → VERDICT → exact-state authorization → promotion → verifiable history
```

## The idea in 30 seconds

1. A task registers **intent** (brief hash, baseline commit, behavior contract).
2. Each agent announces a structured **work claim** (paths, symbols, APIs) — the
   intent registry surfaces *semantic* collisions, not just file conflicts.
3. Each agent gets an **isolated fork** with a short-lived, write-scoped token.
   Forks can't see each other; contenders can't touch the evaluation plane.
4. Evidence accumulates per contender: deterministic checks, test results,
   machine-readable tool receipts, blind reviewer verdicts, mechanical trust.
5. The **verdict seam** — a policy engine, not an LLM judge — decides
   `accept / reject / abstain / escalate`. The LLM is a sensor, never the authority.
6. Promotion is **exact-state and single-consume**: `promotion_id =
   SHA256(task + baseline + candidate + policy)`, and the signed attestation
   invalidates if the shipped commit differs by even one bit from the reviewed one.

## Quickstart

```bash
npm install
npm run typecheck   # must pass
npm run dev         # local dev (needs direct egress for remote bindings)
```

Create a task and drive the protocol (Worker on http://localhost:8787):

```bash
# 1. Register intent
curl -s -X POST localhost:8787/tasks \
  -H 'Content-Type: application/json' \
  -d '{"intent":"Fix expired-JWT handling","baseline_repo":"my-app","baseline_commit":"abc123",
       "behavior_contract":"Expired JWT must return 401"}'
# → {"task_id":"…","task_hash":"…"}

# 2. Agent announces its work claim (collision report included)
curl -s -X POST localhost:8787/tasks/$TASK/claim \
  -H 'Content-Type: application/json' \
  -d '{"agent_id":"agent-a",
       "claimed_scope":{"paths":["packages/auth/"],"symbols":["validateToken()"],"apis":["POST /login"]},
       "behavior_contract":"Expired JWT must return 401",
       "expected_tests":["auth.expired-jwt.test.ts"]}'

# 3. Fork a contender repo (returns a short-lived write token — handle like a secret)
curl -s -X POST localhost:8787/tasks/$TASK/contenders \
  -H 'Content-Type: application/json' -d '{"agent_id":"agent-a"}'

# 4. Submit evidence → the seam returns its verdict immediately
curl -s -X POST localhost:8787/tasks/$TASK/evidence \
  -H 'Content-Type: application/json' -d '{…evidence vector…}'

# 5. Run the selector across contenders, then promote the winner
curl -s -X POST localhost:8787/tasks/$TASK/verdict
curl -s -X POST localhost:8787/tasks/$TASK/promote \
  -H 'Content-Type: application/json' \
  -d '{"winner_commit":"<sha>","candidate_commit":"<sha>","destination_repo":"my-app"}'

# 6. Read the ledger; verify the attestation offline
curl -s localhost:8787/tasks/$TASK/ledger
curl -s localhost:8787/tasks/$TASK/attestation/$PID/verify
```

Set `PROMOTION_SECRET` in the environment before using `/promote`
(v1 uses HMAC-SHA256; production moves to a KMS-held Ed25519 key —
the verification procedure is unchanged).

## API

| Method | Route | What it does |
|---|---|---|
| POST | `/tasks` | Register intent → `task_id`, `task_hash` |
| POST | `/tasks/:id/claim` | Register work claim → collision report |
| POST | `/tasks/:id/contenders` | Fork baseline per agent → fork repo + short-lived write token |
| POST | `/tasks/:id/evidence` | Submit evidence vector → immediate seam verdict |
| POST | `/tasks/:id/verdict` | Selector across contenders → winner or none |
| POST | `/tasks/:id/promote` | Exact-state, single-consume promotion → signed attestation |
| GET | `/tasks/:id/ledger` | Verifiable history for the task |
| GET | `/tasks/:id/attestation/:pid/verify` | Offline attestation verification |

## Design notes

- **Fail-closed.** Missing evidence abstains or rejects; nothing is accepted on narration.
- **Blind reviewers.** A reviewer report without a committed-first assessment is inadmissible.
- **Evaluation plane isolation.** Contenders hold write tokens on their forks only —
  never on the baseline repo, the judge prompt, hidden tests, policy, or the ledger.
- **Idempotent promotion.** Queue redelivery (at-least-once) replays to the same
  `promotion_id` and is a no-op, never a second merge.
- **v1 limits.** In-memory state (production: Durable Object); reviewer agents and
  hidden-test execution are interfaces; the git merge into the destination repo
  lands in v2 — v1 records the exact-state authorization the merge must satisfy.

## License

MIT — see [LICENSE](LICENSE).
