# CanonCap v1 — Canonicalization Capability

Status: competition hardening draft, 2026-10-14.

## Problem

Git permissions answer questions such as “may this actor push to this ref?” That is too broad for autonomous software actors. MADGRIX needs a narrower authority:

> may **this exact reviewed state**, under **this exact evidence and policy**, become canonical at **this exact destination state**, **once**?

MADGRIX already enforces that rule with exact-state promotion permits. CanonCap names the rule as a first-class, secret-free, content-addressed descriptor for tooling and proof.

## Object

`madgrix-canoncap/v1` binds task hash, frozen baseline, exact candidate SHA/tree, evaluation bundle hash, selector policy hash, destination repository, expected destination HEAD and single-use semantics. The permit nonce is intentionally excluded from the public descriptor; the existing permit remains the enforcement object inside `TaskAuthority`.

## Validity

```text
candidate_sha == cap.candidate_sha
candidate_tree == cap.candidate_tree
current_head == cap.expected_destination_head
evaluation == cap.evaluation_bundle
policy == cap.policy
destination_repo == cap.destination_repo
cap is not consumed
```

Any mismatch invalidates canonicalization authority. A moved destination head therefore does not rebind the old authority: the candidate must become a new SHA, be evaluated again and receive new authority.

## Agent-era distinction

Human Git authorization is actor-centric (“Alice may merge”). CanonCap is state-centric (“this exact state may canonicalize once”).

> **Canonicality is a capability, not a branch permission.**

## Implementation

- `src/lib/canoncap.ts`
- `src/worker/entrypoint.ts` exposes `GET /tasks/:id/canoncap/:permit_id` only for the configured public competition task.
- `src/worker/canonicality-panel.ts` renders the descriptor without permit nonces or credentials.

## Non-claim

The name and abstraction are new to this project. This document does not claim that no prior capability-security or software-supply-chain system has an analogous construction; novelty requires a separate prior-art review.
