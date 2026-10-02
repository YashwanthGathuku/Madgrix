# Evaluation Threat Model (v1.0 — FROZEN-v1)

> Frozen 2026-10-01. Content hash recorded in `FROZEN.json`.
> Implementers MUST NOT silently change this contract. If implementation
> exposes a contradiction, stop the component and open a spec amendment
> citing the failing invariant and the proposed change.

**Status:** CONTRACT. This is the most implementation-critical spec: it defines
the trust zones, the credential matrix, and the attack tree. Implementation
MUST satisfy every MUST/MUST NOT herein. **[OPEN]** marks undecided points.

## 1. Purpose

Draw the trust boundaries such that a malicious or compromised contender
**cannot** influence its own evaluation, forge evidence, or write canonical
state — even if it achieves arbitrary code execution inside its own sandbox.
The design assumes the contender is adversarial; the reward-hacking literature
(SpecBench: agents saturate visible validation while failing held-out
behavior, gap growing with task length; 2026 evaluator-tampering benchmarks:
evaluator locking eliminated observed tampering) makes this a requirement,
not paranoia.

## 2. Trust zones

```
┌────────────────────────────────────────┐
│ TRUSTED CONTROL PLANE                  │
│  Worker + Durable Object (per task)    │
│                                        │
│  task state · policy · secrets         │
│  attestation signing · permit ledger   │
│  conflict graph · verdict seam         │
└───────┬───────────────────┬────────────┘
        │                   │
        ▼                   ▼
┌──────────────┐    ┌──────────────┐
│ CONTENDER A  │    │ CONTENDER B  │   …one Firecracker microVM each
│ Sandbox VM   │    │ Sandbox VM   │
│ own repo     │    │ own repo     │
│ own token    │    │ own token    │
│ (WRITE fork  │    │ (WRITE fork  │
│  only)       │    │  only)       │
└──────┬───────┘    └──────┬───────┘
       │ candidate SHA     │ candidate SHA
       ▼                   ▼
┌────────────────────────────────────────┐
│ EVALUATION DOMAIN                      │
│  read-only candidate input             │
│  independent environment & credentials │
│  NO canonical write token              │
│  hidden oracles live here, never in    │
│  contender sandboxes                   │
└───────────────────┬────────────────────┘
                    │ evidence (hashes + results)
                    ▼
┌────────────────────────────────────────┐
│ VERDICT PLANE                          │
│  reads evidence · runs the seam        │
│  CANNOT mutate candidate, evaluation   │
│  outputs, or canonical state           │
└───────────────────┬────────────────────┘
                    │ ACCEPT + permit only
                    ▼
┌────────────────────────────────────────┐
│ PROMOTION                              │
│  The ONLY component allowed to write   │
│  canonical state. Verifies permit,     │
│  writes tree, records ship, consumes   │
│  permit — atomically (spec 5).         │
└────────────────────────────────────────┘
```

### 2.1 Zone definitions

| Zone | Runs on | Holds | MUST NOT |
|---|---|---|---|
| Trusted control plane | Worker + Durable Object | Task state, policy, secrets, signing keys, permit ledger, conflict graph | Hand model/attestation credentials to any other zone |
| Contender sandbox | Separate Cloudflare Sandbox per contender (separate Firecracker microVM) | Its fork repo, a short-lived WRITE-scoped token for that fork only | See hidden tests, judge/verifier prompts, other contenders' code or tokens, policy, ledger |
| Evaluation domain | Separate sandbox(es) / external evaluator | Read-only candidate input, hidden oracles, independent credentials | Hold any canonical write token; persist state across evaluations |
| Verdict plane | Worker (control plane code path) | Evidence, policy | Mutate candidate state, evaluation outputs, or canonical state |
| Promotion service | Worker (control plane code path) | Canonical write token, signing key access | Be reachable by contenders, reviewers, or test harnesses |

## 3. The Sandbox constraint (honest)

Cloudflare's Sandbox documentation warns explicitly: **everything inside one
sandbox is shared** — processes see the same files and each other, and
deployed sandbox processes effectively have **root-level capabilities**.

Therefore this is NOT a serious adversarial boundary:

```
ONE SANDBOX containing:
  candidate + tests + hidden tests + judge config + evaluation script
```

A malicious candidate in that sandbox can inspect or tamper with anything in
it. The architecture MUST NOT place hidden evaluation material in the
contender's sandbox and call it isolated.

What the platform gives us instead:
- **Separate sandboxes run in separate Firecracker microVMs** with
  independent kernel/network isolation — one sandbox per contender is a real
  boundary between contenders.
- The Worker can **retain model credentials** rather than handing them into
  the sandbox, and can **restrict outbound destinations** for sandbox
  processes.

## 4. Two evaluation strengths

### 4.1 Strong / black-box evaluation (preferred)

```
candidate service (sandbox A)
        │ network/API only
        ▼
external evaluator (separate domain)
        │ hidden request vectors, hidden oracle
        ▼
   evidence (no candidate influence possible)
```

- The candidate NEVER receives the hidden test implementation — only
  network/API interactions.
- Best suited to web services/APIs. This is the strongest configuration and
  SHOULD be the default wherever the task shape allows it.

### 4.2 White-box evaluation (libraries, unit-test tasks)

1. Fresh evaluator sandbox is created.
2. The **immutable candidate SHA** is cloned read-only.
3. The sandbox gets **no candidate credentials** and **no canonical write
   credentials**.
4. The test suite runs; the environment is **destroyed afterwards**.

**Honest caveat (MUST be documented, never claimed otherwise):** in
white-box mode we MUST NOT claim that test *contents* are secret from
arbitrary malicious candidate code executing in the same sandbox. What
white-box evaluation protects is **evaluation authority and persistence**:
the candidate cannot alter the recorded result, the policy, or anything
outside its destroyed sandbox. Test secrecy holds only in black-box mode.

### 4.3 Evaluator locking

The 2026 evaluator-tampering literature shows evaluator locking eliminates
observed natural-agent tampering attempts. Concretely: evaluation
configuration, oracle material, and result-signing are locked to the
evaluation domain before any contender output exists, and any contender
attempt to reference them is a tampering signal (→ QUARANTINE, spec 1 §6).

## 5. Credential matrix

| Holder | Git scope | Token lifetime | Notes |
|---|---|---|---|
| Contender | WRITE **only its own fork** | Short-lived (v1: ≤1h), minted at fork time | MUST NOT hold any token for the baseline repo or canonical repo |
| Evaluator | READ candidate SHA only | Per-evaluation | No write token of any kind |
| Conflict analyzer | READ contenders + baseline | Per-analysis | No write token |
| Judge / verifiers | **NO Git access** | — | They read evidence, not repos |
| Promotion service | WRITE canonical repo | Per-promotion, single use | Held only inside the control plane; never leaves it |

- All tokens are minted by the control plane via the Artifacts binding
  (`repo.createToken(scope, ttl)`); plaintext is delivered once, never logged,
  never persisted.
- The control plane MUST retain model/API credentials itself (Worker secrets
  / bindings) rather than injecting them into contender sandboxes.
- Sandbox outbound destinations MUST be restricted to an allowlist
  (package registries, the Artifacts remote). **[OPEN]** The exact allowlist
  mechanism in the Sandbox API.

## 6. Attack tree

The implementation MUST handle each of these; the benchmark (spec 6)
MUST test them.

**Against evaluation integrity:**
1. Candidate deletes or modifies visible tests → detected via baseline test
   manifest hash mismatch → REJECT + QUARANTINE.
2. Candidate fabricates tool success (claims OK without receipts) →
   admission gate `valid_tool_states` fails → REJECT.
3. Candidate modifies evaluator config → evaluator locking (§4.3);
   config hash verified before each run → QUARANTINE.
4. Candidate accesses hidden test material → only possible in white-box;
   black-box makes it structurally impossible. Access attempts are logged
   as tampering signals.
5. Candidate submits unrelated changes → scope gate fails → REJECT.
6. Candidate forges evidence (fake reviewer verdicts, fake test output) →
   evidence is only admissible from the evaluation domain and committed
   verifiers; contender-supplied "evidence" is inadmissible by construction.
7. Candidate swaps commit after evaluation (review SHA X, push SHA Y, promote
   X's verdict for Y) → exact-state permit binds `winning_tree_sha256`;
   mismatch at promotion → ABORT (spec 1 §10–11).

**Against platform integrity:**
8. Replay / duplicate / out-of-order Cloudflare events → idempotent
   ingestion via `event_key` + Durable Object dedupe (spec 5); promotion
   itself is single-consume (spec 1 §10).
9. Destination HEAD moves after verdict → permit EXPIRED; re-evaluate
   (spec 1 §10).
10. Candidate attempts canonical write → structurally impossible: no
    contender token has canonical scope; the Promotion Service is the only
    writer and is unreachable from contender sandboxes.
11. Reviewer/verifier collusion with a contender → verifiers are
    commit-reveal blind (spec 1 §8); non-committed reports are inadmissible.
12. Contender reads another contender's code/token → separate microVMs;
    tokens are per-fork and short-lived; cross-reads have no channel by
    construction.

## 7. Quarantine lifecycle (FROZEN)

Quarantine is a sanction track, NOT a verdict state. It is entered only from
a mechanically verified violation (never from agent accusation — see spec 1
§9.5 for the full lifecycle, triggers, and the no-promotion rule).

Implementation requirements in this spec's scope:

- On entering `QUARANTINED`: the control plane MUST revoke the contender's
  repo write token (`revokeToken`), cancel that contender's pending Workflow
  steps, remove the candidate from selection, freeze the evidence bundle
  (content-addressed, immutable), keep the fork repo read-only for forensics,
  and mark downstream artifacts (reviews, derived evaluations) as tainted.
- The review is conducted by the operator-of-record. `RELEASED` requires a
  determination of mechanical false positive plus passing re-verification;
  otherwise `REVOKED`.
- A quarantined candidate SHA MUST be rejected by the promotion path even if
  presented with an otherwise valid permit — the permit check (spec 1 §11)
  MUST consult the quarantine registry.

## 8. Security invariants

**MUST:**
- Assume the contender is adversarial up to arbitrary code execution in its
  own sandbox.
- Keep hidden evaluation material out of contender sandboxes (black-box) or
  out of contender *authority* (white-box, §4.2 caveat documented).
- Separate decision-making from execution for high-impact operations
  (OWASP agent-security guidance): the component that decides promotion
  MUST NOT be the component that ran the candidate.
- Never authorize on model output alone (spec 1).
- Destroy white-box evaluator sandboxes after each run.

**MUST NOT:**
- Place candidate, tests, hidden tests, and judge config in one sandbox and
  call it an evaluation boundary.
- Give contenders, reviewers, test harnesses, or judges any canonical write
  capability.
- Rely on model output for authorization decisions.
- Claim test secrecy in white-box mode.

## 9. [OPEN] questions

1. Sandbox egress allowlist: exact API/mechanism for restricting outbound
   destinations per sandbox.
2. Model credential retention: Workers AI binding vs. external provider keys
   via Worker secrets — decision per model used.
3. Black-box oracle hosting: who serves the external evaluator (Worker,
   separate sandbox, third-party harness)?
4. White-box test-secrecy hardening: any additional measures (e.g.
   oracle-as-service even for unit tasks) worth the complexity in v1?
