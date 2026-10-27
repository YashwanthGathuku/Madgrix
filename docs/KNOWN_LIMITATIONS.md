# Known limitations — current competition tree

This file describes the current `grok/final-live` competition state. Historical audit,
readiness, and integration reports keep the status of the SHAs/sessions they name and
should not be read as the current deployment status.

## What is proven live

Four recorded E2E runs completed against real Cloudflare infrastructure. They exercised
real Artifacts repositories and push events, `madgrix-events`, `TaskAuthority`,
independent evaluation, blind signed reports, Verdict Seam, exact-state permits,
`PromotionWorkflow`, the promotion Container, signed bundles, and pinned-key offline
verification. In each successful run the reviewed/authorized SHA was the SHA shipped to
canonical `starter-repo` `main`.

## Limits and non-claims

1. **Four runs are not a reliability statistic.** They prove the path can complete;
   they do not establish production availability, throughput, or fleet-scale behavior.
2. **Demo agents are scripted.** The fork-crew evidence demonstrates coordination,
   authority separation, evaluation, and promotion. It is not evidence of LLM coding
   quality or autonomous reasoning.
3. **Queue redelivery.** Real push-event delivery is observed. A deliberate real
   at-least-once redelivery was not induced; duplicate/out-of-order handling is tested
   in the state machine.
4. **Workflow/Container failure branches.** The success path is live-verified. Some
   retry/restart/terminate and injected-failure branches remain primarily local-test
   evidence.
5. **In-flight quarantine.** Quarantine can stop future promotion/finalization, but a
   Git push already executing in the Container is not magically rolled back. Finalize
   refuses to create valid signed promotion evidence for an invalid state.
6. **Escalation bookkeeping.** A later ACCEPT can move task status back to
   `verdict_reached` while an earlier escalation record remains unresolved. This is
   documented hardening work.
7. **Evaluation identity.** The competition implementation uses a distinct shared
   bearer token for the evaluation domain, not mTLS/workload identity.
8. **Signing/key management.** Bundles use Ed25519 DSSE with a public key pinned in
   `keys/authority.pub`. Production KMS/HSM/Sigstore lifecycle management is future
   hardening.
9. **Synthetic benchmark.** The ordinary benchmark is harness validation, not
   evidence of real-world accuracy improvement.
10. **Module memory.** The `ModuleAgent` Durable Object class is deployed, and the
    local memory/routing implementation is tested, but no live module-memory load/wake
    run is claimed and ModuleAgent does not itself edit code.
11. **Agent sandboxing.** The recorded demo uses local Git worktrees and scoped
    credentials. Those worktrees are not claimed as adversarial sandbox/microVM
    isolation.
12. **Artifacts beta behavior.** Native `fork()` has historically returned `10101` on
    this account; the explicit baseline-copy/import fallback must remain.
13. **Platform/runtime reproducibility.** Node 24 on Linux/WSL with LF shell scripts is
    the recommended competition environment. Older Node 22 builds can require
    experimental TypeScript support in child processes; CRLF shell exports can break
    `bash`.

## Composition / conflict precision

- A fork-crew `CONFLICTED` result has **no candidate SHA**. Conflict-marker trees are
  not normal promotable output. A resolver produces a new SHA, which must still be
  evaluated before permit/promotion.
- The promotion Container independently scans for unresolved merge-marker artifacts;
  it does not rely only on the evaluator's statement.
- A resolver works under a resolution lease (`specs/amendments/resolution-lease-v1.md`,
  hunk-level since `governed-resolution-v1.md`): the authority writes all clean work,
  and a resolution that changes anything outside the conflicted hunks is refused. The
  lease compares bytes, so a correct merge that reformats a clean line is refused too
  (the benchmark's one false refusal: Mergiraf rewrote `return string` with two spaces).
  The resolver is not sandboxed.
- Whether a resolution keeps each side's intent is decided by that side's frozen
  witnesses (`governed-resolution-v1.md` §3). The gate is exactly as strong as the
  witnesses: an unwitnessed behaviour can be lost without a refusal. A side with no
  discriminating witness sends the resolution to REVIEW. The authority records the
  control plane's witness report digest; it does not re-run the witnesses, and the
  evaluation domain does not yet re-run them independently.
- The replay rung and the LLM replayer adapter (Anthropic Messages API, Workers AI)
  are tested with deterministic replayers and a local mock server. No LLM resolution
  has been evaluated; no claim about model resolution quality is made.
- The resolution benchmark (`bench/resolution/`) is 12 author-written scenarios on three
  small MIT packages. It measures the gates' mechanics, not real-world precision.
- No fork crew has been resolved on Cloudflare yet; the live steps are in
  `docs/DEMO_RUNBOOK.md`.
- An empty republish used to recover a missed first subscription event is a new SHA and
  must be treated as a new candidate state.
- TheUstad's competition gate verifies the parent fork is still at the frozen baseline
  with a clean worktree before composition. It does **not** verify the combined
  candidate and is not described as a general-purpose semantic code judge.

## Public endpoints / trust boundaries

- `GET /tasks/:id/ledger` and the permit-attestation verification route are public by
  design.
- Agent, control, and evaluation mutation routes require their respective credentials.
- Only the promotion path receives canonical write authority.
- Secret values are not committed to the repository.

For the exact recorded live evidence see `docs/LIVE_RUN_RESULTS.md` and
`docs/LIVE_RUN_RESULTS.md`.
