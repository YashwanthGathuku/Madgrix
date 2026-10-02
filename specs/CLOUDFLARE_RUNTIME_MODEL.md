# Cloudflare Runtime Model (v1.0 — FROZEN-v1)

> Frozen 2026-10-01. Content hash recorded in `FROZEN.json`.
> Implementers MUST NOT silently change this contract. If implementation
> exposes a contradiction, stop the component and open a spec amendment
> citing the failing invariant and the proposed change.

**Status:** CONTRACT. This document defines the hard execution semantics the
implementation runs on. It MUST be frozen before implementation because
changing it later forces rebuilding the central control path. **[OPEN]**
marks undecided points.

## 1. Purpose

Make the platform **production-correct on Cloudflare's actual semantics**:
Queues are at-least-once and unordered; Workflow steps retry; Artifacts has
rate limits and no merge API. Every pattern below is derived from those
facts — not from how we wish the platform behaved.

## 2. Queue semantics: at-least-once, unordered

Artifacts repository lifecycle events (push, fork, …) reach Workers via
**Event Subscriptions published into Cloudflare Queues**.

Cloudflare's documented guarantees for Queues:

- **At-least-once delivery** — a message can occasionally be delivered more
  than once.
- **No ordering guarantee** — delivery order is not guaranteed.

Consequences (non-negotiable):

- **NEVER** write a plain event handler of the form:

  ```
  on push:
      evaluate()
      merge()
  ```

  A duplicated push event would evaluate twice and — without idempotency —
  promote twice.

- **ALWAYS** ingest via: event → `event_key` → Durable Object → dedupe →
  Workflow (§3).

## 3. Ingestion pattern

```
Artifact event (Queue, at-least-once, unordered)
        │
        ▼
derive event_key = SHA256(namespace || repo || ref || before || after)
        │
        ▼
Durable Object (per task ID — the task authority)
        │
        ├─ event_key already seen? → ACK, do nothing
        │
        └─ new event_key?
                │
                ▼
        authoritative state transition
        (strongly consistent, serializable — §4)
                │
                ▼
        Workflow (retryable orchestration — §5)
```

- `event_key` MUST be derived from content, not from Queue metadata
  (message IDs are not stable across redelivery).
- The Durable Object's seen-set is the **single source of truth** for
  "already processed". A redelivered event MUST converge to ACK-without-effect.
- Out-of-order events MUST NOT corrupt state: transitions are validated
  against current state (e.g. "evidence for unknown candidate" is rejected,
  not applied blindly). **[OPEN]** `event_key` derivation for non-push events
  (fork events, lease expiry, manual triggers).

## 4. Durable Object: the task authority

**One Durable Object per work/task ID.** It holds the authoritative state
machine:

```
intent               (frozen task record + task_hash — spec 1 §5)
baseline             (repo + commit)
contenders           (id → fork repo, token metadata, status)
leases               (claim leases — spec 2)
latest_commits       (per contender: last observed SHA per ref)
evaluations          (per candidate SHA: evaluation bundle hashes)
sanctions            (quarantine findings — spec 1 §9.3)
selected_candidate   (verdict output, if any)
promotion_state      (none | permitted(permit_id) | consumed(permit_id))
consumed_permits     (permit_id set — single-use enforcement)
seen_event_keys      (dedupe set — §3)
```

- Durable Objects provide **strongly consistent, serializable transactional
  storage** — this is why the task authority lives here and not in KV or in
  event ordering.
- All state transitions in §3–§5 MUST go through the task's Durable Object.
  No component may hold competing authoritative state.
- **[OPEN]** Sharding beyond one-DO-per-task if a task fans out very wide
  (v1: not needed; document the ceiling).

## 5. Workflows retry: idempotent side effects

Cloudflare documents that **Workflow steps can retry** and advises making
external mutations idempotent. Therefore every side effect gets an
**operation id**; repeating the operation MUST converge to the same state:

| Operation | Operation id | Idempotency mechanism |
|---|---|---|
| fork | `H(task_id, contender_id)` | Fork name derived from the id; re-run finds the existing fork instead of creating a second |
| evaluate | `H(task_id, candidate_sha, eval_policy_hash)` | Evaluation bundle content-addressed; re-run reuses the stored bundle |
| promote | `H(task_id, candidate_sha, destination_head, policy_hash)` | = `permit_id` (spec 1 §10); single-consume in the DO |

- Workflow step code MUST be written so that a retry after a partial failure
  (e.g. fork created but token minting failed) resumes to the same end state
  rather than duplicating the effect.
- The promotion step MUST check `consumed_permits` inside the DO transaction
  before performing the canonical write (spec 1 §11).

## 6. Artifacts limits (design from the current page)

Current documented limits (October 2026 docs):

| Property | Limit |
|---|---|
| Repositories | Unlimited |
| Repository storage | 1 GB per repo |
| Individual blob | 32 MB |
| Control-plane rate | 2,000 requests / 10 sec / namespace |
| Git rate | 2,000 requests / 10 sec / artifact |
| Account storage | 1 TB |

Design implications:

- **One repo per contender is affordable**: repos are unlimited, and contender
  forks are small. The binding constraint is the **1 GB per-repo** cap —
  contender forks MUST NOT import large histories or binaries unnecessarily.
- The **32 MB blob** cap rules out large-asset tasks for v1; document, don't
  work around.
- Control-plane calls (fork, token mint, list) count against **2,000/10s per
  namespace**: batch and cache; the ingestion path MUST NOT issue unbounded
  control-plane calls per event.
- **Caution:** an older preview document showed a 10 GB repository limit;
  today's production page says 1 GB. **Always design from the current docs
  page, never from preview docs or memory.** Recheck before the competition
  deadline.

## 7. No merge API: separation of concerns

The Artifacts control plane provides create/get/fork/read/tokens — **there is
no high-level merge API**. Actual content changes flow through the ordinary
Git protocol. This is fine; it gives us the clean separation:

- **Artifacts = repository substrate** (storage, forks, tokens, Git protocol).
- **Sandbox + git = comparison/rebase/merge machinery** (a dedicated,
  isolated sandbox performs the mechanical merge of the winning tree).
- **Our platform = decision authority** (what may be merged, and the proof).

The merge itself MUST run in an isolated sandbox holding only: the
destination HEAD, the winning tree, and a merge-scoped token — and MUST
verify the exact-state permit before writing (spec 1 §10–11, spec 3 §2).

## 8. Token least-privilege mapping (ties to spec 3 §5)

| Zone | Token scope | Minted by | Lifetime |
|---|---|---|---|
| Contender sandbox | WRITE, its fork only | Control plane at fork time | Short (v1 ≤ 1h) |
| Evaluator | READ, candidate SHA | Control plane per evaluation | Per-evaluation |
| Conflict analyzer | READ, contenders + baseline | Control plane per analysis | Per-analysis |
| Merge sandbox | WRITE, destination, merge-scoped | Promotion service at promotion time | Single promotion |
| Verdict plane / judges | none | — | — |

No other token shapes exist in v1.

## 9. Production data flow

```
Artifact events (push / fork / …)
        │
        ▼
Cloudflare Queue — at-least-once, UNORDERED
        │
        ▼
Ingestion Worker
  derive event_key = SHA256(namespace||repo||ref||before||after)
        │
        ▼
Durable Object (per task ID) — AUTHORITATIVE STATE
  dedupe → state transition → dispatch
        │
        ▼
Workflow (retryable; idempotent operation ids)
  ┌──────────────┼────────────────┐
  │              │                │
  ▼              ▼                ▼
Contender VM   Contender VM   Contender VM     (separate Firecracker microVMs)
  │              │                │
  ▼              ▼                ▼
Artifact       Artifact       Artifact         (forks; contender WRITE tokens)
Repo A         Repo B         Repo C
  │              │                │
  └──────────────┬┴───────────────┘
                 ▼ candidate SHAs
          Conflict Graph (spec 2)
                 │
                 ▼
          Evaluation VMs (spec 3)
          black-box preferred; white-box with caveats
                 │
                 ▼ evidence (hashes + results)
          Verdict Seam (spec 1)
          eligibility AND → selection → ACCEPT/REJECT/ABSTAIN/ESCALATE
                 │ ACCEPT only
                 ▼
          Promotion Authority
          permit_id; single-use; destination-bound
                 │
                 ▼
          Canonical Artifact (merge sandbox + git)
                 │
                 ▼
          Signed evidence bundle (spec 4)
```

## 10. Failure semantics

| Failure | Required behavior |
|---|---|
| Duplicate Queue delivery | `event_key` seen → ACK, no effect |
| Out-of-order delivery | Transition validated against DO state; invalid-for-current-state events rejected (logged), not applied |
| Workflow step retry | Operation id → converge to same state, no duplicate side effects |
| DO transaction conflict | Serialize; the DO is the authority — losers retry against fresh state |
| Control-plane rate limit (2,000/10s) | Backoff + retry inside Workflow; MUST NOT drop the event |
| Contender fork exceeds 1 GB / 32 MB blob | Fork creation fails → contender notified; task continues with remaining contenders |
| Promotion retry after partial write | `consumed_permits` check first → already-consumed = no-op ACK |

## 11. [OPEN] questions

1. `event_key` derivation for non-push events (fork, lease expiry, manual).
2. DO-per-task ceiling: at what fan-out do we need sharding?
3. Workflow step/time limits for long evaluations (black-box oracles with
   generous timeouts).
4. Merge-sandbox mechanics: exact git operations for applying the winning
   tree onto a moved destination HEAD (rebase vs. re-verify).
5. Rate-limit budgeting: per-task control-plane call ceilings.
