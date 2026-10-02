# Intent Registry & Conflict Graph (v0.1 — hardening in parallel)

**Status:** CONTRACT (may harden in parallel with implementation of specs 1/3/5,
but the WorkClaim schema §2 is frozen — the verdict seam's scope gate depends
on it). Items the research did not settle are marked **[OPEN]**.

## 1. Purpose

Answer Cloudflare's question — *"How do agents know what other agents are
working on?"* — with something stronger than branches:

> **Agents publish machine-readable behavioral intent before they act,
> continuously reconciled against a live semantic work graph.**

Git's conflict detector looks too late (at merge time) and too shallow (text
overlap). Empirical grounding: cross-agent PR pairs show **41.7% textual
conflict** vs 19.8% intra-agent — and the study authors warn textual conflict
is a conservative lower bound that misses semantic interference. Prior art
(SafeMerge's dependency + relational reasoning, DeltaImpactFinder's
change-impact deltas, WizardMerge's dependency-graph conflict regions,
generated tests exposing semantic conflicts) shows the signal exists below the
text layer. This spec turns that signal into a protocol.

## 2. WorkClaim schema (frozen)

A contender MUST register a `WorkClaim` with the task's Durable Object
**before** forking or writing code. The claim is the contender's declared
intent; the verdict seam's scope gate (spec 1 §6) judges the candidate's diff
against it.

```jsonc
{
  "work_id": "W-482",                    // unique per claim, assigned by control plane
  "agent": "contender-2",                // contender identity
  "task": "<task_hash>",                 // frozen task this claim attaches to
  "baseline": "a6f4…",                   // baseline commit the claim is built against

  "intent": {
    "behavior": [                        // falsifiable behavior statements
      "expired JWT returns HTTP 401"
    ]
  },

  "scope": {
    "paths":   ["src/auth/**"],          // repo-relative globs
    "symbols": ["verifyToken", "AuthMiddleware"]
  },

  "contracts": {
    "reads":    ["JWTClaims"],
    "modifies": ["TokenValidationResult"]
  },

  "interfaces": ["POST /login", "middleware.auth"],

  "schema_changes": [],                  // migrations, config keys, API shapes

  "expected_tests": ["auth_expiration"],

  "lease": {
    "claimed_at": "2026-10-01T18:00:00Z",
    "expires_at": "2026-10-01T20:00:00Z" // [OPEN] durations per task class
  },

  "status": "claimed"                    // claimed → active → submitted | released | expired
}
```

- `behavior` statements SHOULD be falsifiable (they feed semantic checks in
  spec 1 §7).
- `contracts.reads/modifies` are sets of named state: data structures, DB
  tables, caches, files treated as state — anything two agents could race on.
- A claim with an empty `scope.paths` is INVALID (unbounded claims are not
  admissible).
- Claims are versioned: a contender MAY amend its claim (new version, old
  versions retained in the ledger); the scope gate always evaluates the
  candidate diff against the **latest submitted version** at evidence time.

## 3. Conflict layers

For two live claims A and B on the same task, compute:

| Layer | Name | Formula | What it catches |
|---|---|---|---|
| L0 | Text / path | `TextConflict = Path(A) ∩ Path(B)` (glob-aware) | Same files — what Git would flag, earlier |
| L1 | Syntax / symbol | `SymbolConflict = Symbol(A) ∩ Symbol(B)` | Same functions/types across different files |
| L2 | Dependency | `ImpactConflict = Impact(A) ∩ Impact(B)` | Shared dependency neighborhoods (imports, call graph) |
| L3 | Behavior / contract | `ContractConflict = Writes(A) ∩ (Reads(B) ∪ Writes(B))` | One agent mutates state another reads/writes |
| L3 | State | `StateConflict` = collision on `schema_changes`, config keys, migration versions, or `interfaces` behavior | Incompatible preconditions |

Worked example (from research):

```
Agent A claims:  symbols: [verifyToken]      contracts.modifies: [TokenValidationResult]
                 contracts.reads: [JWTClaims]
Agent B claims:  symbols: [LoginController]  contracts.modifies: [JWTClaims]

Git says: NO CONFLICT (disjoint files).

Our graph:
    verifyToken
        ↓ reads
    JWTClaims  ◄── modified by B
        ↓
    LoginController

ContractConflict = Writes(B) ∩ Reads(A) = {JWTClaims} ≠ ∅ → RED
```

- `Impact(X)` (L2) is computed by deterministic dependency extraction over the
  frozen baseline (imports/call graph for the claimed symbols). **[OPEN]**
  The extractor set per language; v1 may support only the demo's languages
  with an explicit "L2 unavailable" marker otherwise (which MUST surface as
  AMBER, not GREEN — absence of analysis is not evidence of safety).
- L3 `contracts` sets are contender-declared (part of the claim) AND
  control-plane-augmented (static extraction where available). A contender
  that omits a contract it actually touches fails the scope gate at verdict
  time — under-declaration is penalized late if not caught early.

## 4. Risk classification (deterministic rules first)

```
BLOCKED  := StateConflict ≠ ∅
            (same migration version, same config key with different values,
             incompatible interface behavior claims)
RED      := SymbolConflict ≠ ∅
         OR ContractConflict ≠ ∅
AMBER    := ImpactConflict ≠ ∅
         OR L2 analysis unavailable for the claimed language
         OR claim amended after evaluation started
GREEN    := none of the above
```

- Classification MUST be computed by deterministic rules over the claim sets.
- An LLM MAY **explain** a classification ("B's write to JWTClaims can change
  the input A's verifyToken reads") but MUST NOT **determine** whether a
  conflict exists when deterministic evidence is available.
- Where deterministic evidence is unavailable (new language, dynamic dispatch),
  the classification MUST be at least AMBER and MUST say why.

## 5. Live reconciliation protocol

The conflict graph is **live**, not a one-time check:

1. **On claim registration:** classify against all live claims on the task;
   return the classification to the claimant immediately.
2. **On claim amendment:** reclassify; if risk escalated (GREEN→RED etc.),
   notify affected contenders via task feed.
3. **On new claim:** reclassify all live pairs involving the newcomer.
4. **On candidate submission:** the verdict seam re-derives the *actual*
   touched sets from the diff and reclassifies claim-vs-reality; a contender
   whose real footprint exceeds its claim fails scope compliance (spec 1 §6).
5. **RED or BLOCKED:** the control plane MUST surface the collision to both
   contenders and record it. Policy decides whether contenders proceed with
   awareness, renegotiate scope, or one claim is revoked. **[OPEN]** The
   default policy (proceed-with-awareness vs. mandatory renegotiation).
6. **Baseline move:** if the frozen baseline is superseded, all live claims
   are marked stale; contenders must rebase claims (new versions) before
   submitting evidence.

## 6. What the registry does NOT do

- It does not *prevent* two agents from writing conflicting code — it makes
  the collision visible before and during work, so the verdict seam and the
  agents can act on it.
- It does not replace the verdict seam's scope gate: the claim is the
  promise, the diff is the evidence, the gate is the judge.
- Dependency-based conflict analysis is prior art; the novel composition is
  *agents publishing machine-readable intent pre-execution, reconciled
  against a live graph*. The spec claims no novelty for the individual
  analyses.

## 7. Failure semantics

| Failure | Required behavior |
|---|---|
| Claim with empty/unbounded scope | Rejected at registration; no fork issued |
| Contender acts without a registered claim | Candidate inadmissible at scope gate |
| Claim lease expires mid-work | Claim → `expired`; contender must renew (new version) before submitting evidence |
| RED/BLOCKED collision ignored by contenders | Recorded; verdict seam sees the collision record as secondary evidence (spec 1 §9.2); BLOCKED pairs SHOULD NOT both reach ACCEPT for the same task |
| L2 extractor missing for language | Classification ≥ AMBER with reason; never silent GREEN |

## 8. [OPEN] questions

1. Lease durations per task class; renewal policy.
2. Language coverage for L2 dependency extraction in v1; the explicit
   unsupported-language list.
3. Default policy on RED/BLOCKED: proceed-with-awareness vs. mandatory
   renegotiation vs. claim revocation — who decides?
4. Claim amendment after evidence submission: allowed with re-evaluation, or
   frozen?
5. Whether `behavior` statements get machine-checked (generated tests) in v1
   or remain human/LLM-readable only.
