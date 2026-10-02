# Engineering Specifications (internal codename: seam)

**Build status: UNPAUSED — implementation green-lit against FROZEN-v1
contracts.** These six documents are the engineering contracts the
implementation MUST satisfy. Derived from the deeper-research pass (see
`../research/RESEARCH.md`); specs #1, #3, #5 frozen 2026-10-01 as
FROZEN-v1 (hashes in `FROZEN.json`).

**Naming note (frozen decision):** "SEAM" is an internal codename and
mechanism name only — the developer-platform namespace is already crowded
(existing Seam platform, a SEAM semantic-governance product, zer07 Labs'
Seam, and a US trademark application). The public product name will be
chosen before the clean competition repository is created. Keep
**"Verdict Seam"** (and "Promotion Seam") as in-architecture terminology;
the `seam/` folder stays as a temporary internal name so no code is
renamed mid-build. Do NOT publish or brand the project as SEAM.

**Amendment rule (frozen):** Do NOT silently change a frozen contract while
implementing. If implementation exposes a contradiction, stop that
component and open a spec amendment citing the failing invariant and the
proposed change.

## The six specs

1. **[PROMOTION_PROTOCOL.md](PROMOTION_PROTOCOL.md)** — **FROZEN-v1.**
   The selector as a formal protocol: freeze task state → admission gates →
   independent evaluation → blind verifiers → verdict seam → exact-state
   authority → promotion. Blind verification is commit → evaluate → reveal:
   `commitment = SHA256(canonical_json(ReferenceReport) || nonce ||
   task_hash || verifier_id || policy_version)`, stored in the Durable
   Object; the verifier then sees an ANONYMIZED candidate
   (`candidate-7f31`); invalid reveal → `VERIFIER_REPORT_INADMISSIBLE`, no
   retry with a rewritten opinion. Non-compensatory eligibility (`AND` of
   mandatory gates — no single trust score, ever); ranking is objective
   dominance (correctness → regressions → security → blast radius →
   minimality), then blind 2-of-3 verifier vote; no majority or
   indistinguishable candidates → ABSTAIN/ESCALATE. `ESCALATE` routes to the
   operator-of-record and BLOCKS promotion; humans may resolve preference/
   ambiguity/trade-offs but may NEVER override integrity gates (provenance,
   tampering, signature, commit/HEAD mismatch, credential violations) —
   those require a new policy/task state and reevaluation. Quarantine
   lifecycle frozen: mechanically-verified-violation triggers only (agent
   accusation explicitly NOT a trigger); revoke token, cancel side effects,
   remove from selection, freeze evidence, taint downstream; REVIEW →
   RELEASED/REVOKED; a quarantined state can NEVER be promoted — salvage
   becomes a new SHA with full reevaluation. First-class
   `ACCEPT / REJECT / ABSTAIN / ESCALATE` (+ `QUARANTINE`); the permit is
   `SHA256(task_hash || baseline || winning_tree || eval_bundle || policy
   || expected_destination_head)`, single-use, and expires if the
   destination HEAD moves (TOCTOU closure).

2. **[INTENT_AND_CONFLICT_GRAPH.md](INTENT_AND_CONFLICT_GRAPH.md)** —
   Hardening in parallel (WorkClaim schema frozen). Agents register
   machine-readable behavioral intent *before* acting
   (paths/symbols/contracts/interfaces/schema changes); the control plane
   reconciles claims against a live semantic work graph on four layers
   (L0 text/path, L1 symbol, L2 dependency, L3 behavior/contract) with set
   formulas (`ContractConflict = Writes(A) ∩ (Reads(B) ∪ Writes(B))`) and
   deterministic GREEN/AMBER/RED/BLOCKED classification. LLMs may explain a
   conflict, never determine one when deterministic evidence exists.

3. **[EVALUATION_THREAT_MODEL.md](EVALUATION_THREAT_MODEL.md)** — **FROZEN.**
   The most implementation-critical spec. Five trust zones (control plane /
   contender microVMs / evaluation domain / verdict plane / promotion — the
   ONLY canonical writer); the honest Sandbox constraint (one sandbox shares
   a filesystem with effective root — hidden material in the contender's
   sandbox is NOT a boundary); black-box vs. white-box evaluation with
   documented caveats; the credential matrix; a 13-item attack tree the
   benchmark must test.

4. **[ATTESTATION_PROTOCOL.md](ATTESTATION_PROTOCOL.md)** — Hardening in
   parallel. No proprietary ledger: in-toto attestations (test-result and
   verification-result predicates), SLSA trust boundaries, DSSE + Sigstore
   signing. Chain: work intent → in-toto Link → test result → verification
   result → promotion authority → ship record. Exactly one custom object,
   `AgentPromotionAuthority/v1`, binding BOTH the git commit ID and the
   SHA-256 tree digest. Ends with the `$ verify promotion.bundle → VERIFIED`
   demo transcript.

5. **[CLOUDFLARE_RUNTIME_MODEL.md](CLOUDFLARE_RUNTIME_MODEL.md)** — **FROZEN.**
   Hard execution semantics: Queues are at-least-once and unordered, so
   ingestion is always event → `event_key` → Durable Object (per-task
   authority, strongly consistent) → dedupe → Workflow; Workflow steps retry,
   so every side effect (fork / evaluate / promote) gets an idempotent
   operation id; Artifacts limits table (1 GB/repo, 32 MB blob, 2k/10s —
   design from the current docs page, not preview docs); no merge API means
   Artifacts = substrate, Sandbox + git = merge machinery, our platform =
   decision authority.

6. **[BENCHMARK_PROTOCOL.md](BENCHMARK_PROTOCOL.md)** — Competition scope
   **FROZEN** (paper-scale benchmark is future work). Isolates the
   *selector*: generate candidate sets once, run four arms on the IDENTICAL
   sets (A single agent, B first-passing contender, C naive LLM judge,
   D our protocol); A vs D under fixed per-agent AND matched total compute.
   Frozen sizes: **20 ordinary tasks × 3 contenders**; **13 attack classes
   × 2 = 26 adversarial trials**; **30 conflict pairs (10/10/10)**.
   Primary metric: **Selection Regret** =
   P(wrong pick | ≥1 correct existed); Oracle Availability reported
   separately. Frozen precommits: D vs C ≥ **25% relative Selection Regret
   reduction**; **0** false promotions on critical deterministic attacks;
   **0** duplicate promotions on permit replay; **0** stale promotions on
   HEAD race; **0** duplicate effects on duplicate events; **0** promotions
   of quarantined candidates; **100%** fail-closed on mandatory integrity
   violations. Conflict prediction reported as precision/recall/FPR/95% CI
   as-measured; paired bootstrap CIs for B/C/D; failures published.

## Freeze order

**FROZEN-v1 before ANY implementation:** #1, #3, #5 (hashes in
`FROZEN.json`). Changing any of these later forces rebuilding the central
control path (selector logic, trust boundaries, or the event/state
architecture) — open an amendment, never a silent change.

**May harden in parallel with implementation:** #2, #4, #6.
Their frozen cores (WorkClaim schema; standards-reuse + the one custom
object; fixed-candidate-set method + Selection Regret + competition
precommits) are already stable; the [OPEN] items refine rather than redirect.

## Gap analysis: the existing scaffold

The scaffold at `./` was built before these specs and **does not
satisfy them**. It is a starting point, not a conforming implementation.
What must change, per spec:

| # | Scaffold state | Spec requirement | Verdict |
|---|---|---|---|
| 1 | `src/lib/verdict.ts` uses a single compensating `trust_score` (0.6 threshold) to accept | Non-compensatory `Eligibility(C)` AND-gates; NO compensating score; `ABSTAIN`/`ESCALATE`/`QUARANTINE` first-class | **REJECTED — rewrite.** The trust_score mechanism is explicitly forbidden. |
| 1 | `src/index.ts` `/promote` has no destination-HEAD check | Permit expires if `expected_destination_head` moved; promotion aborts | **Missing — must add.** |
| 1 | Blind verifiers absent | Commit-reveal verifiers; non-committed reports inadmissible | **Missing — must add.** |
| 2 | `src/lib/intent.ts` has paths/symbols only | Full WorkClaim schema (contracts.reads/modifies, interfaces, schema_changes, behavior, lease) + L2/L3 reasoning | **Extend.** Current collision detection is L0/L1 only. |
| 3 | No zones; contender token minted on fork, but no zone model | Five trust zones, credential matrix, evaluator locking | **Missing — must add.** |
| 4 | `src/lib/attestation.ts` uses HMAC with a shared secret | in-toto + DSSE + Sigstore; exactly one custom object (`AgentPromotionAuthority/v1`); dual git-commit + tree-sha256 identity | **Superseded — rewrite.** HMAC attestation does not satisfy the spec. |
| 5 | All state in module-level `Map`s | Durable Object per task as the authoritative state machine; Queue ingestion via `event_key` dedupe; idempotent Workflow operation ids | **REJECTED — re-architect.** In-memory state cannot satisfy at-least-once/unordered delivery. |
| 6 | No benchmark harness | Fixed-candidate-set four-arm benchmark; Selection Regret; attack battery | **Missing — must add.** |

**What the scaffold got right and KEEPS:** the route shape
(task → claim → contender fork → evidence → verdict → promote → ledger),
per-fork short-lived write tokens (never on the baseline repo), the
fail-closed posture on missing evidence, and the single-consume promotion
id (which becomes `permit_id` under spec 1 §10).

## Reading order

For implementers: 5 → 3 → 1 → 2 → 4 → 6 (platform reality, then trust,
then the protocol, then the graph, then provenance, then proof).
For reviewers: 1 → 3 → 5 → 4 → 2 → 6 (the invention first).
