# Canonicality primitives — preliminary prior-art boundary

Date: 2026-10-14

This is an engineering novelty check, **not a patent search or legal opinion**. Its purpose is to prevent the competition story from claiming old mechanisms as new.

## What MADGRIX must not claim as new

### Capability security

Object capabilities, linear/single-use capabilities, scoped delegation and revocation are established security ideas. MADGRIX should not claim to have invented capability security.

### Proof-carrying software change

Proof-carrying code and software-supply-chain attestations are established. A 2026 Sugar research note explicitly describes a **proof-carrying commit** / proof-carrying change whose commit is bound to a proof root. Therefore MADGRIX should **not** claim that attaching machine-checkable evidence to a commit is novel.

Reference: https://github.com/TSavo/sugar/blob/main/docs/papers/11-after-commits-proof-carrying-change.md

Also relevant: in-toto, TUF and Sigstore.

- https://in-toto.io/
- https://theupdateframework.io/
- https://docs.sigstore.dev/

### Causal/provenance graphs

Typed provenance DAGs are established, and at least one current project, FrankenLean, uses the phrase **“causal proof graph”** for proof provenance. MADGRIX therefore does not claim the phrase or the general idea of a causal proof DAG as unique.

Reference: https://github.com/Dicklesworthstone/franken_lean

### Structured conflicts

Git already has non-working-tree merge plumbing such as `git merge-tree --write-tree`, and Jujutsu treats conflicts as first-class state. MADGRIX does not claim to have invented structured conflicts.

- https://git-scm.com/docs/git-merge-tree
- https://jj-vcs.github.io/jj/latest/conflicts/

### Compare-and-swap Git writes

`git update-ref`, `--force-with-lease` and host-side transactional ref updates are prior art. MADGRIX does not claim compare-and-swap itself as new.

## The narrower candidate contribution

The defensible MADGRIX research question is whether the following **combination at the canonical Git boundary** is materially new and useful for autonomous software actors:

1. **State-centric canonicalization authority.** Authority is not “agent X may merge”; it is “this exact candidate state may canonicalize once.”
2. **Exact destination-state binding.** The authority binds the expected destination HEAD as well as candidate SHA/tree.
3. **Evidence/policy binding.** Candidate tree, evaluation bundle and selection policy are part of the same canonicalization authority.
4. **Single-use consumption.** Successful canonicalization consumes the authority; replay cannot produce another canonical write.
5. **No rebinding after state movement.** Destination movement or rebase creates a new software state that must be evaluated again and receive new authority.
6. **Independent authority causality.** A deterministic proof projection connects intent/claims → candidate → independent evidence → verdict → exact-state authority → promotion proof → canonical SHA.
7. **Conflict invalidation rule.** A conflicted composition has no candidate; resolution produces a new SHA and does not inherit prior authorization.

MADGRIX names the public exact-state descriptor **CanonCap**. The existing `TaskAuthority` permit remains the enforcement object.

## Why this boundary matters for the competition

Competitors already cover many adjacent areas:

- concurrent workspaces and merge queues;
- collision prediction / function-level clearance;
- reviewer agents and hidden tests;
- commit memory and dependency DAGs;
- human decision cards and undo;
- agent hook/MCP protocols.

MADGRIX should therefore lead with the part those features assume but do not by themselves establish:

> **Who — or more precisely which exact state — has the right to become canonical, and can that right survive substitution, replay, stale destination state or changed evidence?**

## Current claim discipline

Safe competition wording:

> “MADGRIX introduces CanonCap as its abstraction for evidence-bound exact-state canonicalization authority.”

> “We did not find the complete MADGRIX combination in our competition/prior-art scan.”

Avoid until a broader research review is complete:

> “MADGRIX invented capabilities.”

> “MADGRIX invented proof-carrying commits.”

> “Causal Proof Graph is an unprecedented graph concept.”

> “Conflict Capsules are the first structured conflicts.”

The novelty claim should be earned by the **specific invariant bundle and enforcement boundary**, not by renaming known components.
