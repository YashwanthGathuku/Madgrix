# Conflict Capsule v1

Status: competition hardening design. Implementation must remain fail-closed and must not make a conflicted composition promotable.

## Problem

Traditional Git represents many unresolved textual conflicts by writing marker syntax into a working tree. That representation is optimized for an interactive human merge session. An autonomous coordinator instead needs a stable, machine-readable object that can be routed, inspected, resolved and audited without treating conflict markers as candidate source state.

## Primitive

A **Conflict Capsule** is a content-addressable description of a failed composition attempt. It is evidence about a conflict, not a candidate commit and never promotion authority.

```ts
interface ConflictCapsuleV1 {
  type: "madgrix/conflict-capsule/v1";
  task_hash: string;
  contender_id: string;
  baseline: string;
  contributing_shas: string[];
  conflicts: Array<{
    path: string;
    classification: "textual-line-overlap";
    sides: Array<{
      agent_id: string;
      role: string;
      intent: string;
      sha: string;
      excerpt: string;
    }>;
  }>;
  created_at: string;
  capsule_sha256: string;
  resolution_requirements: {
    new_candidate_required: true;
    reevaluation_required: true;
    previous_evidence_not_reusable: true;
  };
}
```

`capsule_sha256` is SHA-256 over canonical JSON of the capsule excluding `capsule_sha256`.

## State transition

```text
COMPOSING
   |
   | composition cannot produce a clean candidate
   v
CONFLICTED ----> Conflict Capsule
   |
   | resolver begins
   v
RESOLVING
   |
   | a new exact commit is produced
   v
RESOLVED
   |
   | new candidate must be evaluated as a new state
   v
EVALUATION
```

A capsule MUST NOT contain or imply a promotable `candidate_sha`. Existing MADGRIX semantics remain authoritative: `CONFLICTED`, `PENDING`, `COMPOSING`, and `RESOLVING` have no promotable candidate.

## Invariants

1. Conflict data is evidence, not source code.
2. A capsule never grants canonical-write authority.
3. Resolving a capsule creates a new exact candidate SHA.
4. Evidence for a pre-resolution candidate cannot be reused for the resolved SHA.
5. A resolved candidate must pass normal admission, evaluation, verdict and CanonCap issuance.
6. Capsule generation must be deterministic for the same canonical inputs, apart from `created_at`; implementations that need stable identity SHOULD hash a timestamp-free payload.
7. Excerpts are diagnostic only; blob/tree identity remains the source of truth.
8. Unknown conflict classifications fail closed for automatic promotion.

## Implementation path

MADGRIX already records `CompositionRecord.files` for textual overlap and already makes `CONFLICTED` non-promotable. The smallest safe implementation is therefore:

1. project a `ConflictCapsuleV1` from the recorded `CompositionRecord` when status is `CONFLICTED`;
2. expose it read-only through Mission Control / task state;
3. persist its digest in the authority ledger before adding any resolver automation;
4. only later add plumbing such as `git merge-tree --write-tree` as an input producer.

This order avoids changing the already-proven promotion path merely to improve conflict representation.

## Judge-facing explanation

> MADGRIX does not treat merge markers as the coordination protocol. A failed composition becomes a Conflict Capsule: a machine-readable, auditable object describing the exact baseline, contributions and conflicting paths. Resolving it produces a new SHA that must earn fresh evidence and a new CanonCap before it can become canonical.