# Development Log — Madgrix

The full build history of this entry, 2026-10-01. Times are EDT.

## The idea

Cloudflare's competition ("build the next Git platform for agents", deadline
2026-10-14) asks four questions: how agents know what others are working on,
how review works when agents move fast, how agents avoid breaking each other,
and how to know the reviewed code is what shipped.

The entry's answer: **a governed promotion protocol for autonomous software
agents** — INTENT → competing implementations → independent evidence →
VERDICT → exact-state authorization → promotion → verifiable history.

## 2026-10-01 — the day, in order

**Morning — commitment + research.** Committed to pushing hard for top 3.
Deep-research report written (`research/RESEARCH.md`, ~39 KB): paper catalog,
25-item Git pain-point ranking, competitive landscape, demo arc. Key findings:
fork-per-agent is commoditizing (Cloudflare's own examples); the white space
is adjudication, enforcement, intent/provenance, verifiable promotion. Naive
LLM judging is unreliable; multi-agent scaling isn't automatically better
(DeepMind/MIT). Added the Zhou "More Convincing, Not More Correct" citation
(blind-commit judging: false positives 0.719 → 0.012).

**Midday — two-track strategy.** Track A: build the Cloudflare integration.
Track B: harden six mechanism areas (selector protocol, intent registry,
evaluation isolation, provenance, Cloudflare runtime, benchmark methodology).

**Afternoon — Cloudflare Artifacts setup.** Verified toolchain
(`cf 1.0.0-beta.10`, Wrangler 4.146.0), created the `default` namespace and a
`starter-repo`, pushed and re-cloned. Found the sandbox blocker: `workerd`
can't reach the remote Artifacts binding through the egress proxy (TLS
`WRONG_VERSION_NUMBER`) — the `cf` CLI works, local Workers don't. This
constraint shaped everything after: the implementation defines an
`ArtifactsPort` interface and proves the protocol against an in-memory
stand-in, with production wiring kept separate.

**Afternoon — first scaffold.** Built the initial Worker (`src/`) with
intent registration, collision checks, fork-per-agent, evidence submission,
a verdict function, idempotent promotion IDs, and HMAC attestation. 20/20
logic smoke tests. Immediately flagged as a scaffold, not a system.

**Evening — the deeper pass (Track B).** Produced four architecture-level
freezes that reshaped the design:
1. No LLM as judge-authority (Zhou's result makes candidate-conditioned
   judging unsafe).
2. No compensating trust scores (a security failure must never be outweighed
   by code quality).
3. No shared-sandbox "isolation" theater (one Cloudflare Sandbox = shared
   filesystem + effective root; strongest tests run externally).
4. No exactly-once assumptions (Queues are at-least-once and unordered →
   Durable Object authority + idempotent workflows).

**Evening — six specifications.** The research became six engineering
contracts (`specs/`): Promotion Protocol, Intent/Conflict Graph, Evaluation
Threat Model, Attestation Protocol, Cloudflare Runtime Model, Benchmark
Protocol. Then the five-decision freeze patch: blind-verifier
commit→evaluate→reveal construction, no weighted ranking (objective dominance
→ blind 2-of-3 vote → ABSTAIN), ESCALATE = operator-of-record with no
integrity overrides, mechanical-triggers-only quarantine lifecycle, and the
frozen benchmark precommit (20×3 tasks, 13×2 attacks, 30 conflict pairs;
Selection Regret primary; zero-tolerance list). Specs #1/#3/#5 marked
FROZEN-v1 with content hashes in `specs/FROZEN.json`. Amendment rule: never
silently change a frozen contract.

**Evening — naming.** "SEAM" rejected as the product name: the namespace is
crowded (existing Seam platform, a SEAM semantic-governance product, zer07
Labs' Seam, a US trademark application). Kept as internal codename and as the
in-architecture term "Verdict Seam". Public name chosen: **Madgrix**.

**Night — implementation against the contracts.** Built the vertical slice in
implementer order (5 → 3 → 1 → 2 → 4 → 6), replacing the scaffold's
non-conforming parts (compensating trust score deleted, HMAC attestation
replaced with in-toto/DSSE shapes, in-memory Maps re-architected to
Durable-Object authority).

**Night — hostile self-audit.** Attacked the implementation; found and fixed
real bugs, all with regression tests:
- Critical: verifier-report signatures never verified → authority now holds
  registered verifier keys, rejects forged reports.
- Critical: permit re-issue reset the consumed flag → double promotion was
  possible → re-issue is now idempotent.
- Critical: promotion skipped the evaluation-bundle-hash check → added
  `EVAL_BUNDLE_MISMATCH`, permit not consumed on abort.
- High: `/evidence` accepted with no caller check → evaluation-domain-only,
  fail-closed.
- High: quarantine RELEASED was a placeholder → requires re-running the
  firing trigger plus an operator-signed determination.
- Plus: the HEAD-move loop demonstrated end-to-end (permit expiry →
  re-evaluation → re-promotion), commit-swap attack as a standing test,
  anti-compensation adversarial test.

**Night — completion.** 105/105 tests, 26 suites, `tsc` strict clean. Full
slice (`npm run slice` → SLICE OK), head-move loop (HEAD-MOVE OK), benchmark
harness (26/26 adversarial trials, zero-tolerance intact). One spec amendment
opened properly (`specs/amendments/evaluator-config-trigger.md`); frozen specs
untouched (hashes verified). Submission assets written: fresh-machine README,
deterministic 7-minute demo script, architecture docs + SVG, security notes,
benchmark runbook, production deployment guide with honest validated/blocked
status. Secret sweep clean. Pushed to
`github.com/YashwanthGathuku/Madgrix` as the public competition repository.

## What remains (post-push)

- Public name: chosen (Madgrix). Repo: public.
- Demo video recording (script is deterministic and ready).
- Live Cloudflare E2E (needs a direct-egress machine or deploy permission —
  the one hard blocker, documented in `docs/PRODUCTION_DEPLOYMENT.md`).
- The real benchmark run on SWE-bench/SpecBench (pre-registered procedure in
  `docs/BENCHMARK_RUNBOOK.md`; harness validated on synthetic inputs).
- Independent adversarial review of the implementation + the one open spec
  amendment.
