# Causal Proof Graph v1 — Why is this SHA canonical?

Status: competition hardening draft, 2026-10-14.

## Thesis

A Git commit graph answers **what state preceded this state?** For autonomous software, operators also need **why did this state have the right to become canonical?**

The Causal Proof Graph is a read-only, content-addressed projection over MADGRIX authority state.

```text
task intent
   ↓
work claims
   ↓
composition
   ↓
independent evaluation
   ↓
verdict
   ↓
CanonCap
   ↓
signed promotion proof
   ↓
canonical SHA
```

Not every task has every node. Each node is content-addressed as `SHA256(canonical_json({ type, data }))`; the deterministic `causal_root` hashes the target SHA plus sorted nodes and edges.

## Security boundary

The graph explains authority; it does not create authority. It may never make a candidate eligible, issue a permit, change quarantine state or promote Git. The projection omits agent secrets, service tokens, permit nonces, hidden test names, private signing keys and raw DSSE signatures.

## Implementation

- `src/lib/causal-proof.ts`
- `src/worker/entrypoint.ts` exposes `GET /tasks/:id/why/:sha` only for `MADGRIX_PUBLIC_DEMO_TASK_ID`.
- other task metadata is intentionally not exposed by this new projection layer.
- Mission Control renders the causal root and node chain for the public competition task.

> **Git proves ancestry. MADGRIX proves canonicality causality.**

## Non-claim

This is a candidate new abstraction assembled from known cryptographic, provenance and capability ideas. The project should not claim prior-art novelty until a dedicated search is complete.
