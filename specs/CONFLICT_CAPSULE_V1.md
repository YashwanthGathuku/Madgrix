# Conflict Capsule v1 — Conflicts as protocol objects

Status: competition hardening draft, 2026-10-14.

## Problem

Traditional Git represents unresolved content conflicts by writing marker text into working files. That representation is optimized for a human editor and can be mistaken by an autonomous agent for source state.

MADGRIX already refuses to create a candidate from a `CONFLICTED` composition. Conflict Capsule makes that refusal explicit and content-addressed.

## Object

A `madgrix-conflict-capsule/v1` contains the frozen task hash, contender id, baseline SHA, contributing SHAs, conflicting paths, agent/role/intent/SHA sides, digest of each stored excerpt, and mandatory resolution rules.

The same stored conflict state deterministically produces the same capsule without adding another authority mutation.

## Invariant

```text
CONFLICTED
    => candidate_sha = null
    => new_candidate_required = true
    => re_evaluation_required = true
    => old_authority_invalid = true
```

A resolver creates a new software state. That new SHA must re-enter evaluation; it cannot inherit the authority of either conflicting input.

## Implementation

- `src/lib/conflict-capsule.ts` derives the capsule from the authority's already-stored `CONFLICTED` composition.
- `src/worker/entrypoint.ts` exposes the read-only capsule only for the configured public competition task.
- `src/worker/canonicality-panel.ts` renders it separately from software state.
- the hardening layer does not mutate `TaskAuthority` merely to cache this deterministic projection.

## Non-claim

Git, Jujutsu and merge tools have prior structured conflict representations. The candidate contribution here is content-addressed conflict evidence combined with MADGRIX's rule that resolution creates a fresh candidate whose prior canonicalization authority is invalid. Novelty is not asserted without broader prior-art review.
