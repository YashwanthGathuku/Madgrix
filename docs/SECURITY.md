# Security — Verdict Seam

The normative threat model is `../specs/EVALUATION_THREAT_MODEL.md` (FROZEN-v1). This
document is the plain-language summary: what the system defends against, where the
boundaries are, and — just as important — what it does *not* claim.

**Working assumption:** the contender is adversarial up to arbitrary code execution
inside its own sandbox. Every boundary below is designed against that adversary.

## The 13-attack battery

From the frozen threat model (spec 3 §6) and benchmark protocol (spec 6 §7). The
benchmark runs each twice (26 trials) against the real protocol modules, with
zero-tolerance success criteria: **0 false promotions, 0 stale promotions, 0
duplicate promotions, 0 duplicate effects, 0 quarantined promotions, 100% fail-closed.**

**Against evaluation integrity:**

1. **Candidate deletes or modifies visible tests** → detected via baseline test
   manifest hash mismatch → REJECT + QUARANTINE.
2. **Candidate fabricates tool success** (claims OK without receipts) → admission
   gate `valid_tool_states` fails → REJECT.
3. **Candidate modifies evaluator config** → evaluator locking: config hash verified
   before each run → QUARANTINE.
4. **Candidate accesses hidden test material** → structurally impossible in
   black-box mode; access attempts are logged as tampering signals.
5. **Candidate submits unrelated changes** → scope gate fails → REJECT.
6. **Candidate forges evidence** (fake reviewer verdicts, fake test output) →
   evidence is only admissible from the evaluation domain and committed verifiers;
   contender-supplied "evidence" is inadmissible by construction.
7. **Candidate swaps commit after evaluation** (review SHA X, push SHA Y, promote
   X's verdict for Y) → the exact-state permit binds `winning_tree_sha256`;
   mismatch at promotion → ABORT.

**Against platform integrity:**

8. **Candidate reuses an old evaluation for a new commit** → evaluation bundles are
   bound to the candidate SHA; a stale bundle fails the permit check → ABORT.
9. **Promotion event replayed** → single-consume permit; replay returns
   `ALREADY_CONSUMED` (no-op ACK), canonical head unchanged.
10. **Duplicate Cloudflare event delivery** → idempotent ingestion via
    content-derived `event_key` + Durable Object dedupe (`ACK_DUP`).
11. **Out-of-order push events** → ordering-insensitive ingestion; stale events
    cannot overwrite newer state.
12. **Destination HEAD moves after verdict** → permit EXPIRED; the task must be
    re-evaluated, never force-promoted.
13. **Candidate attempts canonical write** → structurally impossible: no contender
    token has canonical scope; the promotion service is the only writer and is
    unreachable from contender sandboxes.

The demo's showcase attack is #7: *"Candidate A is reviewed at SHA X, pushes SHA Y
afterwards, the system attempts promotion"* — expected: **REJECT**.

## Trust zones and credential matrix

Five zones (see `ARCHITECTURE.md` for the full table):

| Holder | Git scope | Token lifetime | Notes |
|---|---|---|---|
| Contender | WRITE **only its own fork** | Short-lived (≤1h), minted at fork time | MUST NOT hold any token for the baseline or canonical repo |
| Evaluator | READ candidate SHA only | Per-evaluation | No write token of any kind |
| Conflict analyzer | READ contenders + baseline | Per-analysis | No write token |
| Judge / verifiers | **NO Git access** | — | They read evidence, not repos |
| Promotion service | WRITE canonical repo | Per-promotion, single use | Held only inside the control plane; never leaves it |

- All tokens are minted by the control plane via the Artifacts binding
  (`repo.createToken(scope, ttl)`); plaintext is delivered once, never logged, never
  persisted.
- The control plane retains model/API credentials itself (Worker secrets / bindings)
  rather than injecting them into contender sandboxes.
- Sandbox outbound destinations are restricted to an allowlist (package registries,
  the Artifacts remote). The exact allowlist mechanism in the Sandbox API is still an
  OPEN question in the spec.

## The honest sandbox constraint

One sandbox is not an adversarial boundary: processes inside it share the filesystem
and effective root. The architecture **never** places hidden evaluation material in a
contender's sandbox and calls it isolated. Real boundaries come from *separate*
Firecracker microVMs (one per contender), the Worker retaining credentials, and
egress allowlisting. In white-box evaluation mode, test *contents* are not claimed
secret from malicious code in the same sandbox — what is protected is evaluation
authority and persistence (the candidate cannot alter the recorded result, the
policy, or anything outside its destroyed sandbox).

## Quarantine and the operator-of-record

- **Quarantine is a sanction track, not a verdict state.** It is entered *only* from a
  mechanically verified violation — agent accusation is explicitly **not** a trigger.
- On entering quarantine: the contender's write token is revoked, pending Workflow
  steps are canceled, the candidate is removed from selection, the evidence bundle is
  frozen (content-addressed, immutable), the fork stays read-only for forensics, and
  downstream artifacts are marked tainted.
- Review is conducted by the **operator-of-record**. `RELEASED` requires a
  determination of mechanical false positive plus passing re-verification; otherwise
  `REVOKED`. Salvage is a new SHA with full re-evaluation — quarantined state can
  never be promoted, even with an otherwise valid permit.
- **ESCALATE** routes to the operator-of-record for genuine preference, ambiguity,
  or trade-off decisions. Humans may resolve those — but they can **never** override
  an integrity gate (provenance, tampering, signature, commit/HEAD mismatch,
  credential violations). Those require a new policy/task state plus re-evaluation.

## Security invariants (MUST / MUST NOT)

**MUST:**
- Assume the contender is adversarial up to arbitrary code execution in its sandbox.
- Keep hidden evaluation material out of contender sandboxes (black-box) or out of
  contender *authority* (white-box, caveat documented above).
- Separate decision-making from execution for high-impact operations: the component
  that decides promotion MUST NOT be the component that ran the candidate.
- Never authorize on model output alone.
- Destroy white-box evaluator sandboxes after each run.

**MUST NOT:**
- Place candidate, tests, hidden tests, and judge config in one sandbox and call it
  an evaluation boundary.
- Give contenders, reviewers, test harnesses, or judges any canonical write
  capability.
- Rely on model output for authorization decisions.
- Claim test secrecy in white-box mode.

## Non-claims

What Verdict Seam does **not** promise:

- **Not a sandbox escape defense.** The contender is assumed contained by its
  microVM; a hypervisor/Sandbox-API escape is outside this threat model.
- **Not a guarantee the winning code is bug-free.** The protocol guarantees the
  winner was fairly selected, honestly evaluated, and shipped exactly as reviewed —
  not that the hidden tests cover everything.
- **Not collusion-proof at the human layer.** Blind commit→reveal blocks
  verifier–contender collusion mechanically; operator-of-record abuse is a
  governance problem, and the signed audit trail exists precisely so it is
  detectable.
- **Not a production deployment.** The current repo runs the real protocol state
  machines against an in-memory Artifacts stand-in; the live Cloudflare end-to-end
  run is still pending.
