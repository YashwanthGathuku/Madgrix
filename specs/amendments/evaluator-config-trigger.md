# Spec amendment: distinct quarantine trigger for evaluator-config modification

**Status:** proposed · **Date:** 2026-10-01 · **Workstream:** seam completion, workstream 1
**Affects (FROZEN-v1):** `PROMOTION_PROTOCOL.md` §9.5 (trigger enumeration), via this
amendment file only — frozen spec files are NOT edited.

## (1) The failing invariant (quoted from the frozen specs)

`PROMOTION_PROTOCOL.md` §9.5, quarantine lifecycle (FROZEN-v1):

> "Quarantine is triggered ONLY by mechanically evidenced violations:
> evaluation-file modification attempt, unauthorized canonical write,
> candidate SHA substitution, forged/mismatched evidence, mechanically proven
> tool-status fabrication, promotion permit replay, credential scope
> violation, hidden-evaluation boundary violation."

The trigger enumeration is a CLOSED list. "Evaluator config modification" is
not a member, yet the frozen threat model requires it to quarantine:

`EVALUATION_THREAT_MODEL.md` §6 (attack tree, FROZEN):

> "3. Candidate modifies evaluator config → evaluator locking (§4.3);
> config hash verified before each run → QUARANTINE."

And §4.3 (evaluator locking, FROZEN):

> "Concretely: evaluation configuration, oracle material, and result-signing
> are locked to the evaluation domain before any contender output exists,
> and any contender attempt to reference them is a tampering signal (→
> QUARANTINE, spec 1 §6)."

## (2) Why implementation exposes a contradiction

The slice's benchmark battery tests attack 3 (`benchmark.ts`, attack-03a/03b):
the evaluator config is hashed when locked, re-hashed before each run, and a
mismatch is a mechanical finding. But the `QuarantineTrigger` union
(`src/lib/types.ts`) has no member for this finding — the closest member is
`hidden_eval_boundary_violation`, and the benchmark documents the mismatch
with a "MAPPING (documented)" comment mapping attack 3 onto it.

That mapping is wrong in two directions:

1. **Loss of forensic specificity.** An operator reviewing a quarantine record
   cannot distinguish "contender touched the locked evaluator config" (attack 3,
   evaluation integrity) from "contender exfiltrated hidden oracle material"
   (attack 4, boundary violation). The two have different remediation: attack 3
   suspects the *evaluation config pipeline* (re-lock, rotate hidden seed),
   attack 4 suspects the *sandbox isolation boundary*.
2. **The §4.3 finding is config-scoped, not boundary-scoped.** Evaluator locking
   is a pre-run hash check *inside* the evaluation domain — the contender never
   crosses a boundary. `hidden_eval_boundary_violation` describes a boundary
   crossing (spec 3's "honest Sandbox constraint": hidden material in the
   contender's sandbox is NOT a boundary). Folding attack 3 into it redefines
   the trigger's meaning and makes the trigger list's closed-union semantics
   drift with every new attack: the union claims exhaustiveness but silently
   absorbs new attacks into "closest match" buckets.

The frozen invariant says the trigger list is closed and exhaustive; the
frozen threat model requires a quarantine the closed list cannot name. The
implementation cannot satisfy both without either miscategorizing (violating
the mechanical-triggers-only discipline) or failing to quarantine (violating
the attack tree). That is the contradiction this amendment resolves.

## (3) The proposed change

Add ONE new closed-union member:

```ts
export type QuarantineTrigger =
	| "eval_file_modification"
	| "evaluator_config_modification"   // ← NEW (this amendment)
	| "unauthorized_canonical_write"
	| "candidate_sha_substitution"
	| "forged_evidence"
	| "tool_status_fabrication"
	| "permit_replay"
	| "credential_scope_violation"
	| "hidden_eval_boundary_violation";
```

Semantics (mechanical, spec 1 §9.5-conforming — agent accusation remains NOT a trigger):

- **Trigger:** `evaluator_config_modification` fires **iff** the pre-run
  re-computation of the locked evaluator-config digest
  (`SHA256(canonical_json(locked_config))`, spec 3 §4.3) differs from the
  locked digest. It is a pure hash comparison performed by the control plane —
  a mechanical finding, not an agent claim.
- **Sanctions:** identical to the frozen lifecycle (spec 1 §9.5, spec 3 §7):
  revoke the contender's fork token, cancel pending side effects, remove from
  selection, freeze evidence, taint downstream evaluations, REVIEW →
  RELEASED/REVOKED; quarantined state is never promoted (salvage = new SHA +
  full reevaluation).
- **Non-overlap:** `hidden_eval_boundary_violation` keeps its §4 meaning
  (contender reached hidden evaluation material across a trust boundary, e.g.
  attack 4); `eval_file_modification` keeps its meaning (contender modified
  visible test files, attack 1). The three evaluation-integrity findings are
  now distinguishable in the quarantine record.

Implementation notes (recorded for the auditor): the benchmark's attack-03a/03b
paths were migrated from `hidden_eval_boundary_violation` to
`evaluator_config_modification`; a regression test
(`test/task-state.test.ts`, "quarantine" suite) asserts that a locked-config
hash mismatch quarantines with the new trigger, revokes the token, and taints
evaluations. `hidden_eval_boundary_violation` remains for attack 4 and stays
referenced nowhere else.
