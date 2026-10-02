# Promotion Protocol (v1.0 — FROZEN-v1)

> Frozen 2026-10-01. Content hash recorded in `FROZEN.json`.
> Implementers MUST NOT silently change this contract. If implementation
> exposes a contradiction, stop the component and open a spec amendment
> citing the failing invariant and the proposed change.

**Status:** CONTRACT. This document is the engineering contract for the selector.
Implementation MUST satisfy every MUST/MUST NOT herein. Items the research did
not settle are marked **[OPEN]** — they are decisions, not gaps to paper over.

## 1. Purpose

Define the **selector as a formal protocol**, not "an LLM judge". The protocol
takes N immutable candidate states for one frozen task and produces exactly one
of: `ACCEPT` (with an exact-state, single-use promotion permit), `REJECT`,
`ABSTAIN`, or `ESCALATE` (plus `QUARANTINE` for adversarial findings).

The LLM is a **sensor, never the authority**. No model output, however
confident, can authorize a promotion by itself.

## 2. Normative references

- Zhou, C. "More Convincing, Not More Correct" (July 2026): a reference-free
  judge that sees the candidate first has false-positive rate **0.719**;
  forcing the judge to commit its own answer *before* seeing the candidate
  drops it to **0.012**. This is the empirical mandate for blind verifiers (§7).
- Multi-Agent Verification literature: multiple *aspect-specific, independent*
  verifiers improve test-time verification; free-form multi-model debate does
  not (cf. "Debate or Vote": majority voting accounts for most of MAD's gains;
  debate itself does not inherently improve expected correctness).
- Uncertainty-guarded judging (2026): calibrated thresholds bound the error
  rate among accepted decisions; uncertain cases route elsewhere. This is the
  mandate for first-class `ABSTAIN` (§8).
- Publication Authority preprint: authorization applies to one exact state and
  is single-use, not a generic "candidate approved" flag (§9).

## 3. Definitions

| Term | Meaning |
|---|---|
| `task_hash` | SHA-256 over the canonical frozen task record: intent text, baseline repo, baseline commit, policy version (§5). |
| `candidate` | An immutable state: `(repo, git_commit, tree_sha256)` produced by one contender from the frozen baseline. |
| `evaluation bundle` | The complete, content-addressed record of everything measured about a candidate: gate results, test outputs, hidden-oracle results, static analysis, verifier reports, policy version. Its hash is `evaluation_bundle_hash`. |
| `eligibility` | A boolean AND over mandatory gates (§8). Non-compensatory: no weighting, no trade-offs. |
| `permit` | The exact-state, single-use promotion authority (§9). |
| `selector_policy_hash` | SHA-256 of the frozen selector policy (gate definitions, thresholds, verifier set, policy version string). |

## 4. Protocol pipeline

```
TASK
  │
  ▼
┌─────────────────────┐
│ 1. FREEZE TASK STATE │  task + baseline + policy → task_hash
└──────────┬──────────┘
           │  N contenders work in isolation (see specs 2, 3)
           ▼
┌─────────────────────┐
│ 2. ADMISSION GATES   │  §6 — fail fast, fail closed
│    (per candidate)   │
└──────────┬──────────┘
           ▼
┌─────────────────────┐
│ 3. INDEPENDENT       │  §7 — hidden oracle, regressions,
│    EVALUATION        │  static analysis, semantic checks, security policy
└──────────┬──────────┘
           ▼
┌─────────────────────┐
│ 4. BLIND VERIFIERS   │  commit own assessment BEFORE seeing candidate
└──────────┬──────────┘
           ▼
┌─────────────────────┐
│ 5. VERDICT SEAM      │  §8 — eligibility AND → secondary selection
│                      │  → ACCEPT / REJECT / ABSTAIN / ESCALATE / QUARANTINE
└──────────┬──────────┘
           │ ACCEPT only
           ▼
┌─────────────────────┐
│ 6. EXACT-STATE       │  §9 — permit_id, single-use, destination-bound
│    AUTHORITY         │
└──────────┬──────────┘
           ▼
┌─────────────────────┐
│ 7. PROMOTION         │  the ONLY canonical write (§10; spec 3)
└─────────────────────┘
```

A candidate that fails at any stage STOPS. There is no "partial credit" path
around a failed mandatory gate.

## 5. Stage 1 — Freeze task state

Before any contender acts, the control plane MUST freeze and hash:

```
task_record = {
  intent:            <task brief text>,
  baseline_repo:     <canonical repo name>,
  baseline_commit:   <git SHA>,
  behavior_contract: <falsifiable contract text, may be empty>,
  policy_version:    <e.g. "seam-policy/0.1.0">,
  frozen_at:         <RFC3339 timestamp>
}
task_hash = SHA256(canonical_json(task_record))
```

- The `task_hash` MUST be recorded in the task's Durable Object before any
  fork is created (spec 5).
- Any contender submission whose work claim references a different
  `baseline_commit` or `task_hash` MUST be rejected at admission (stale work).
- **[OPEN]** Lease/expiry semantics for frozen tasks: how long may contenders
  work before the freeze is considered stale and the task re-frozen?

## 6. Stage 2 — Admission gates (per candidate)

Each gate is boolean. The gate definitions:

| Gate | Pass condition |
|---|---|
| `exact_baseline` | Candidate's history contains `baseline_commit` as an ancestor; candidate was forked from the frozen baseline (fork lineage recorded at fork time). |
| `scope_compliance` | The candidate diff touches only paths/symbols/APIs within the contender's registered work claim (spec 2). Unclaimed changes → fail. |
| `valid_tool_states` | Every claimed tool action carries a machine-readable receipt with a named status (`OK`/`FAILED`/…); narration without receipts → fail. |
| `no_eval_tampering` | No write, or attempted write, by the contender to: evaluation config, hidden tests, judge/verifier prompts, trust/policy records, ledger history. Any detection → fail AND quarantine (§8). |
| `provenance_complete` | Agent identity, model, harness version, and fork lineage are present and well-formed. |

- Gates MUST be evaluated by the **control plane**, never by the contender or by
  model judgment. Where a gate needs interpretation (e.g. scope), deterministic
  rules decide; an LLM may only *explain* a deterministic finding.
- A candidate failing any admission gate MUST NOT proceed to evaluation.
  Failing `no_eval_tampering` MUST additionally move the contender to
  `QUARANTINE`.

## 7. Stage 3 — Independent evaluation

Runs in the **evaluation domain** (spec 3), never in a contender sandbox:

| Check | Requirement |
|---|---|
| Hidden oracle | Held-out functional tests the candidate never saw. The candidate MUST NOT receive the hidden test implementation (black-box) or must run in a fresh, credential-free sandbox (white-box) — see spec 3 for the honesty caveats. |
| Regressions | The baseline's existing test suite at the frozen commit. |
| Static analysis | Language-appropriate deterministic analyzers. |
| Semantic checks | Contract/behavior checks derived from the task's behavior contract. |
| Security policy | Deterministic policy checks (dependency, secret, permission surface). |

- All evaluation inputs (candidate SHA, policy digest, environment descriptor)
  and all outputs MUST be hashed into the evaluation bundle.
- `evaluation_bundle_hash = SHA256(canonical_json(evaluation_bundle))`.
- **[OPEN]** The exact oracle format per task type (unit-test bundle? service
  contract vectors?) and who authors hidden oracles for competition-demo tasks.

## 8. Stage 4 — Blind verifiers (FROZEN)

Frozen construction — **commit → evaluate → reveal**:

1. The verifier receives ONLY: `task_hash`, `baseline_commit`,
   `policy_version`, `requirements`, `behavioral contract`.
   It receives NO candidate and NO contender identity.
2. The verifier first produces a `ReferenceReport`:

   ```
   ReferenceReport {
       expected_behavior,
       invariants,
       likely_failure_modes,
       evaluation_plan,
       security_expectations
   }
   ```

3. The verifier generates a 256-bit random nonce and computes:

   ```
   commitment = SHA256(
       canonical_json(ReferenceReport)
       || nonce
       || task_hash
       || verifier_id
       || policy_version
   )
   ```

   The task's Durable Object stores the commitment (with timestamp) before
   any candidate is shown.
4. Only then does the verifier receive an **anonymized candidate**
   (`candidate-7f31`, never "Claude candidate" / "Agent 2"). It evaluates the
   candidate and emits a signed `VerdictReport`.
5. The verifier reveals `ReferenceReport + nonce`. The control plane
   recomputes the commitment and compares it to the stored value.

- Invalid commitment or reveal → `VERIFIER_REPORT_INADMISSIBLE`.
- A verifier gets **no retry with a rewritten opinion**: one commitment, one
  reveal, one report. A failed reveal ends that verifier's participation for
  the candidate.
- Rationale: Zhou (2026) — candidate-conditioned judging has false-positive
  rate 0.719; commit-first drops it to 0.012. This is not optional polish; it
  is the mechanism that makes verifier verdicts admissible.
- A verifier report without a prior valid commitment MUST be treated as
  inadmissible (as if the verifier abstained).
- Verifiers are aspect-specific and independent (correctness, security,
  minimality…); they MUST NOT deliberate with each other or with contenders.

## 9. Stage 5 — Verdict seam

### 9.1 Eligibility: non-compensatory gates

```
Eligibility(C) =
    baseline_valid
AND scope_valid
AND evaluation_integrity_valid
AND provenance_valid
AND required_tests_pass
AND policy_valid
```

- **There is NO single compensating trust score.** The following construction
  is explicitly FORBIDDEN:

  ```
  score = 0.40*tests + 0.25*reviewer + 0.15*provenance + 0.10*security + 0.10*style
  ```

  because it permits `security failure = -10, beautiful code = +20, TOTAL = PASS`.
  A security or provenance violation MUST NEVER be outweighed by code quality.
- Each conjunct maps to measured evidence: `baseline_valid` ← admission gate
  `exact_baseline`; `evaluation_integrity_valid` ← admission gate
  `no_eval_tampering` AND evaluation-domain provenance; `required_tests_pass`
  ← regressions + required hidden checks; `policy_valid` ← security policy +
  selector policy conformance.
- If `Eligibility(C)` is false, the candidate is REJECTED. No secondary
  evidence is consulted.

### 9.2 Selection among eligible candidates (FROZEN)

Only candidates with `Eligibility(C) = true` enter selection. **No weighted
score is used.** Ranking follows objective dominance, in this order:

1. correctness (hidden-oracle margin),
2. regression failures (fewer is better),
3. security findings (fewer is better),
4. semantic blast radius (spec 2 risk profile),
5. unnecessary change surface (minimality).

A candidate *dominates* another if it is no worse on every dimension and
strictly better on at least one.

```
ELIGIBLE CANDIDATES
        │
        ▼
Objective dominance
        │
  ┌─────┴─────┐
  │           │
unique      several
dominant    remain
candidate       │
  │             ▼
  │      Blind verifier vote
  │          2-of-3
  │             │
  │      ┌──────┴──────┐
  │      │             │
  ▼    winner      no majority
 ACCEPT    │             │
           ▼             ▼
        ACCEPT     ABSTAIN / ESCALATE
```

- If exactly one candidate dominates all others → ACCEPT.
- If several remain → blind verifiers vote 2-of-3; majority winner → ACCEPT.
- No majority, or candidates genuinely indistinguishable → **ABSTAIN**.
  Not inventing confidence is a selling point: the correct system behavior
  for indistinguishable valid implementations is ABSTAIN, never a coin flip
  dressed as judgment.
- The selection rule MUST be deterministic given the evidence and the frozen
  `selector_policy_hash`. It MUST NOT be able to promote an ineligible
  candidate — ranking operates strictly within the eligible set.

### 9.3 First-class states

| State | Meaning | Required handling |
|---|---|---|
| `ACCEPT` | Exactly one eligible candidate selected; permit issued (§9). | Proceed to §9. |
| `REJECT` | No eligible candidate, or a mandatory gate failed. | Task returns to intake; reasons recorded in ledger. |
| `ABSTAIN` | Evidence insufficient or uncertainty above the calibrated threshold (uncertainty-guarded judging). The seam declines to decide. | MUST NOT be coerced into ACCEPT/REJECT. Recorded; routes to re-evaluation or human per policy. |
| `ESCALATE` | Conflicting admissible evidence (e.g. no verifier majority) or uncertainty above threshold with no hard failure. | Routes to the **operator-of-record**; promotion is BLOCKED (`NO MERGE`). See §9.4. |
| `QUARANTINE` | Adversarial finding: mechanically verified violation (spec 3 §7). | Contender isolated per the quarantine lifecycle (§9.5); separate review track. MUST NOT be merged into the normal REJECT path silently. |

- The seam MUST emit a machine-readable verdict record
  `{state, candidate_shas, evidence_hashes, reasons[], policy_hash, timestamp}`
  for every decision, including ABSTAIN.
- **[OPEN]** Calibrated abstention thresholds: the numeric uncertainty
  thresholds per task stratum, and who sets them.

### 9.4 ESCALATE: operator-of-record (FROZEN)

`ESCALATE` blocks promotion. The decision goes to the **operator-of-record**
(for v1: the repository owner/operator). The human has *limited* authority:

A human MAY resolve:
- architecture preference,
- ambiguous requirement,
- equivalent candidates,
- business trade-off.

A human MAY NOT override:
- provenance failure,
- evaluation tampering,
- invalid signature,
- commit mismatch,
- destination HEAD mismatch,
- credential boundary violation.

To change one of those, the operator must create a **new policy/task state**
and cause **reevaluation** — never a direct override. This closes the
embarrassing loophole of `SYSTEM: unsafe / HUMAN: ship anyway / SYSTEM: okay`.

For the competition demo, the normal scenario requires **0 humans**;
`ESCALATE` exists to demonstrate responsible handling of uncertainty.

### 9.5 Quarantine lifecycle (FROZEN)

```
ACTIVE
  │
  │ mechanically verified violation
  ▼
QUARANTINED
  │  ├── revoke repo write token
  │  ├── cancel pending side effects
  │  ├── remove candidate from selection
  │  ├── freeze evidence
  │  ├── preserve repo read-only
  │  └── mark downstream artifacts tainted
  ▼
REVIEW (operator-of-record)
  │
  ├───────────────┐
  ▼               ▼
RELEASED        REVOKED
```

- Quarantine is triggered ONLY by mechanically evidenced violations:
  evaluation-file modification attempt, unauthorized canonical write,
  candidate SHA substitution, forged/mismatched evidence, mechanically proven
  tool-status fabrication, promotion permit replay, credential scope
  violation, hidden-evaluation boundary violation.
- **Agent accusation is explicitly NOT a trigger.** Sanctions fire on
  mechanical findings only — never on one agent's claim about another.
- A quarantined candidate state can NEVER be promoted. If the work is
  salvageable: new candidate state → new SHA → new evidence → full
  reevaluation. This prevents evidence laundering through quarantine.
- `RELEASED` requires the operator-of-record to determine the trigger was a
  mechanical false positive AND re-verification to pass; otherwise `REVOKED`
  terminates the contender.

## 10. Stage 6 — Exact-state authority

On `ACCEPT`, the control plane issues exactly one promotion permit:

```
permit_id = SHA256(
    task_hash
  || baseline_commit
  || winning_tree_sha256
  || evaluation_bundle_hash
  || selector_policy_hash
  || expected_destination_head
)
```

Semantics:

- The permit authorizes **this exact tree**, evaluated under **this exact
  evidence and policy**, to be promoted onto **this exact destination state**.
- **Single-use.** The permit MUST be recorded as consumed in the task's Durable
  Object before the canonical write (spec 5). A second presentation of the
  same `permit_id` is a no-op, never a second promotion.
- **Destination-bound (TOCTOU closure).** If `expected_destination_head !=
  current destination HEAD` at promotion time, the permit has EXPIRED. The
  promotion MUST NOT proceed; the candidate MUST be re-evaluated (or rebased
  and re-verified) against the new head. This closes the
  review-A → modify-A → ship-modified-A hole.
- The canonical permit statement (see spec 4 for the attestation encoding):

  > *This exact tree, evaluated under this exact evidence and policy, may be
  > promoted onto this exact destination state — once.*

## 11. Stage 7 — Promotion

- Promotion is performed **only** by the Promotion Service, the single
  component authorized to write canonical state (spec 3).
- The promotion MUST verify, in order: (1) permit not previously consumed;
  (2) `expected_destination_head` equals current destination HEAD;
  (3) `winning_tree_sha256` equals the tree about to be written;
  (4) `evaluation_bundle_hash` matches the stored bundle.
- On success: write the tree to the canonical repo, record the ship record
  (spec 4), mark the permit consumed, append to the ledger. All four MUST be
  atomic from the task authority's perspective (Durable Object transaction,
  spec 5).
- Any verification failure → promotion ABORTED, permit NOT consumed (so a
  legitimate retry after re-evaluation remains possible), failure recorded.

## 12. Failure semantics (summary)

| Failure | Stage | Required behavior |
|---|---|---|
| Baseline mismatch / stale work | 2 | REJECT candidate; contender may rebase and resubmit as a new candidate state |
| Scope violation | 2 | REJECT candidate |
| Missing/invalid tool receipts | 2 | REJECT candidate |
| Eval tampering detected | 2 | REJECT + QUARANTINE contender; preserve evidence |
| Incomplete provenance | 2 | REJECT candidate |
| Hidden oracle failure | 3 | Candidate ineligible (`required_tests_pass = false`) |
| Verifier without prior commitment | 4 | Report inadmissible → treated as abstain |
| No eligible candidate | 5 | REJECT (task-level) |
| Uncertainty above threshold | 5 | ABSTAIN (never forced) |
| Verifier split / low trust, no hard fail | 5 | ESCALATE |
| Permit already consumed | 6/7 | No-op ACK (idempotent; spec 5) |
| Destination HEAD moved | 6/7 | Permit EXPIRED; re-evaluate |
| Tree mismatch at write time | 7 | ABORT; permit not consumed |

## 13. Invariants

**MUST:**
- The LLM is a sensor, never the authority: no promotion without a permit,
  no permit without eligibility, no eligibility without measured evidence.
- Gates are non-compensatory. Any "overall score" used for ranking MUST be
  computed over eligible candidates only and MUST be incapable of promoting
  an ineligible one.
- `ABSTAIN` is a terminal, first-class state — never a euphemism for REJECT,
  never coerced.
- Every state transition is recorded in the task ledger with evidence hashes.

**MUST NOT:**
- Reduce trust to one compensating score.
- Let a candidate-conditioned judge (or any non-committed verifier) cast an
  admissible verdict.
- Treat a generic "candidate approved" flag as authorization — only the
  exact-state, single-use, destination-bound permit authorizes promotion.
- Allow the verdict plane to mutate candidate state, evaluation outputs, or
  canonical state (spec 3).

## 14. [OPEN] questions

1. Abstention calibration: numeric thresholds per task stratum and who sets them.
2. Task freeze lease/expiry semantics.
3. Hidden-oracle authorship for demo/competition tasks.
