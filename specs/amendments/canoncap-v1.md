# CanonCap v1 — Canonicalization Capability

Status: competition hardening draft. This document names and formalizes the exact-state permit mechanism already implemented by MADGRIX. It does not weaken or replace the existing promotion protocol.

> Git decides ancestry. MADGRIX decides canonicality.
>
> Canonicality is a capability, not a branch permission.

## 1. Primitive

A **CanonCap** is a single-use authority capability granting one exact, already-evaluated candidate state the right to become canonical under one exact authority and destination state.

In the current implementation, `PermitRecord` is the serialized CanonCap and `PromotionReservation` is its promotion linearization record.

A CanonCap binds at minimum:

- frozen task identity (`task_hash`)
- baseline (`baseline_commit`)
- exact winner (`winner_candidate_sha`)
- exact tree (`winning_tree_sha256`)
- evaluation evidence (`evaluation_bundle_hash`)
- selector policy (`selector_policy_hash`)
- contender identity (`contender_id`)
- destination repository (`destination_repo`)
- expected destination state (`expected_destination_head`)
- unique nonce (`nonce`)
- issue time (`issued_at`)
- single-use consumption state (`consumed`, `consumed_at`)

The capability identifier MUST be deterministically derived from its bound fields according to the existing permit-id construction. A verifier MUST recompute it rather than trusting the stored identifier.

## 2. Validity

Conceptually:

```text
Valid(cap, authority, destination, candidate) =
    known_to_authority(cap)
  AND NOT consumed(cap)
  AND authority_allows(cap.contender_id, cap.winner_candidate_sha)
  AND destination.repo == cap.destination_repo
  AND destination.head == cap.expected_destination_head
  AND candidate.sha == cap.winner_candidate_sha
  AND candidate.tree_digest == cap.winning_tree_sha256
  AND evaluation(candidate).bundle_hash == cap.evaluation_bundle_hash
  AND selector_policy_hash == cap.selector_policy_hash
```

Existing quarantine epochs, voided permits, revoked contenders, unresolved conflicts, baseline checks, tree checks and evidence checks remain mandatory. CanonCap is a name for the complete capability boundary, not permission to bypass any gate.

## 3. Reservation and linearization

Before canonical Git credentials are minted, the task authority MUST atomically reserve the CanonCap. The reservation freezes refusal-relevant authority state into `authority_epoch` and binds:

```text
permit_id
candidate_sha
tree_sha256
expected_destination_head
evaluation_bundle_hash
authority_epoch
promotion_nonce
destination_repo
source_repo
```

Only the promotion service may exercise a reserved CanonCap against the canonical repository.

The canonical writer MUST independently re-check destination head, candidate identity, candidate tree, baseline/ancestry and unresolved merge artifacts immediately before the ref update.

A successful canonical write finalizes the reservation and consumes the CanonCap. Proven pre-write terminal failures may abort the reservation according to `promotion-terminal-abort-v1.md`. Ambiguous network/push outcomes MUST NOT be treated as proven aborts.

## 4. Security invariants

1. **Exact-state:** authority for candidate A never authorizes candidate B.
2. **Exact-tree:** changing the tree after evaluation invalidates canonicalization.
3. **Exact-destination:** moving canonical HEAD invalidates a stale capability unless a new authorized path is established.
4. **Evidence binding:** evaluation evidence cannot be swapped independently of the candidate.
5. **Policy binding:** the selector policy used to choose the winner is part of the capability.
6. **Single use:** replay of a consumed CanonCap cannot produce a second authorized write.
7. **Quarantine monotonicity:** release from quarantine does not resurrect a capability voided by the quarantine epoch.
8. **Credential separation:** possessing a CanonCap is not equivalent to possessing canonical Git credentials; only the trusted promotion service receives canonical write capability.
9. **Fail closed:** missing or ambiguous authority state cannot broaden CanonCap authority.

## 5. Why this differs from branch permission

Traditional branch permission answers: **who may write this ref?**

CanonCap answers: **which exact state, backed by which exact evidence and policy, may cross the canonicalization boundary once?**

An agent can therefore have broad permission to work in an isolated contender repository while having zero standing permission to write canonical state.

## 6. Judge-facing explanation

Use this concise description without overstating the implementation:

> A MADGRIX CanonCap is a single-use exact-state promotion capability. It binds the selected commit and tree to its evaluation evidence, policy and expected destination head. Agents never receive standing canonical-write permission; the promotion service exercises the capability and independently re-checks the state immediately before the canonical ref update.

## 7. Compatibility

This amendment is intentionally naming-compatible with the existing protocol:

- `PermitRecord` remains the wire/storage type.
- `permit_id` remains the identifier used by APIs and Workflows.
- existing signed promotion bundles remain valid.
- existing offline verification remains valid.
- no successful historical promotion is reinterpreted or mutated.

Future APIs MAY expose `canonicalization_capability` or `canoncap` as presentation aliases, but MUST preserve the exact existing permit semantics and evidence bindings.