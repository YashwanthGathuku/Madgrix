# MADGRIX canonicality primitives

MADGRIX already had the enforcement machinery: exact-state permits, destination-head binding, independent evidence, blind verification, quarantine and a signed promotion bundle. This hardening layer makes that machinery legible as agent-era primitives without replacing the proven authority or promotion path.

## CanonCap

**Canonicality is a capability, not a branch permission.** A CanonCap binds one task, baseline, exact candidate SHA/tree, evidence, policy, destination repository and destination HEAD. It is single-use. If the head moves, the old authority cannot simply be rebound: the new SHA must be evaluated again and earn new authority.

Spec: [`../specs/CANONCAP_V1.md`](../specs/CANONCAP_V1.md)

## Conflict Capsule

A conflicted composition has no candidate. MADGRIX projects the stored conflict into a content-addressed Conflict Capsule that requires a new resolved SHA plus re-evaluation. Conflict marker text is not treated as promotable software state.

Spec: [`../specs/CONFLICT_CAPSULE_V1.md`](../specs/CONFLICT_CAPSULE_V1.md)

## Causal Proof Graph

Git answers “what came before?” MADGRIX answers “why was this exact SHA allowed to become canonical?” The graph connects task → claims → composition → evaluation → verdict → CanonCap → promotion proof → canonical state and gives that explanation a deterministic root digest.

Spec: [`../specs/CAUSAL_PROOF_GRAPH_V1.md`](../specs/CAUSAL_PROOF_GRAPH_V1.md)

## Attack Lab

```bash
npm run attack:lab
```

Attack Lab uses the existing real protocol modules in the adversarial benchmark harness; it is not presented as live Cloudflare fault injection. Its zero-tolerance cases cover permit replay, moved destination HEAD, duplicate push events, quarantine and mandatory integrity failures. Expected ending:

```text
26/26 adversarial trials passed
unauthorized canonical promotions: 0
ATTACK_LAB_VERIFIED
```

## Mission Control + MCP

The existing Cloudflare entrypoint remains the MCP surface. The same wrapper now also adds read-only canonicality projections for the configured Run 4 public demo and appends a CanonCap/Causal Proof section to the existing Mission Control HTML. Mutating calls still delegate to the same core router and authority checks.

## Competition story

> **Git decides ancestry. MADGRIX decides canonicality.**
>
> Agents can create many candidate states. A state becomes canonical only when it earns a single-use CanonCap bound to exact evidence and destination state. Conflicts become typed Conflict Capsules rather than accidental source state, and a Causal Proof Graph explains why the exact shipped SHA was allowed to land.

These are candidate abstractions, not unqualified novelty claims. The demonstrated value is the executable mechanism and its invariants.
