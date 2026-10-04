# Submission Checklist — MADGRIX

**Competition:** Cloudflare “Build the next Git platform”  
**Deadline:** October 14, 2026  
**Repository:** YashwanthGathuku/Madgrix  
**License:** MIT

This checklist separates implementation evidence from competition evidence.
A green local/CI test is not presented as a completed live Cloudflare run.

## Competition package

| Requirement | Status | Evidence |
|---|---|---|
| Agent-native Git concept | ✅ | `README.md`, frozen protocol specs |
| Cloudflare Worker | ✅ built/CI | `src/worker/index.ts`, `cloudflare.config.ts` |
| Durable Object authority | ✅ built/CI | `src/do/TaskAuthority.ts` |
| Cloudflare Queue consumer | ✅ built/CI | official Artifacts push-envelope routing + dedupe tests |
| Cloudflare Workflow | ✅ built/CI | `PromotionWorkflow` registered in config |
| Cloudflare Container | ✅ built/CI | `src/do/PromotionContainer.ts`, `container/` |
| Cloudflare Artifacts integration | ✅ primitives validated | real repo/token/push/clone/revocation validation |
| Real 3-agent contender runner | ✅ implemented | `scripts/run-contenders.mjs` |
| Independent evaluator | ✅ implemented | `scripts/evaluate-candidate.ts` |
| Complete live orchestrator | ✅ implemented | `scripts/live-e2e.ts` |
| Exact reviewed-state promotion | ✅ implemented/CI | candidate SHA + `tree-digest/v1` + destination HEAD |
| Offline verifiable evidence | ✅ local slice | in-toto-style statements + DSSE + verifier CLI |
| Security/threat model | ✅ | `docs/SECURITY.md`, `specs/EVALUATION_THREAT_MODEL.md` |
| Architecture documentation | ✅ | `docs/ARCHITECTURE.md` |
| Open-source license | ✅ MIT | `LICENSE` |
| Real deployed MADGRIX E2E transcript | ⬜ | run `npm run live:e2e` after deployment |
| Demo video | ⬜ | record after successful live E2E |
| Real benchmark dataset run | ⬜ | `docs/BENCHMARK_RUNBOOK.md` |
| Submission form | ⬜ | final competition submission |

## Current CI evidence

The Oct 2 `codex/competition-critical-paths` tip recorded:

```
npm run typecheck        PASS
npm run build            PASS
npm test                 110 tests / 27 suites / 0 failures
npm run slice            SLICE OK
npm run headmove         HEAD-MOVE OK
npm run bench            26/26 adversarial trials
                         zero_tolerance_ok=true
```

That count is not this branch. Local `npm test` on the merge is 281 tests / 87 suites / 0 failures. Typecheck, build, slice, headmove, and bench were not re-run for the merge. The Oct 2 CI also syntax-checked the three live-run scripts and both container Git helpers.

## Required before recording the final demo

1. Deploy `madgrix` with three distinct service secrets.
2. Create/configure `madgrix-events`.
3. Subscribe `cf.artifacts.repo.pushed` events from the competition namespace
   to that Queue.
4. Prepare the real baseline and canonical Artifact repositories.
5. Run `npm run live:e2e`.
6. Save the successful transcript and `promotion.bundle`.
7. Run the verifier separately against that saved bundle.
8. Re-run the stale-HEAD/commit-swap attack against the deployed path if time
   permits and preserve the rejection transcript.
9. Record the demo from the live path; keep the deterministic local slice only
   as a backup.
10. Submit before October 14.

## Claims that are safe today

MADGRIX can be described as implementing a governed promotion protocol with
WorkClaims, isolated candidate repositories, independent evidence,
non-compensatory eligibility gates, blind signed verifier reports, exact-state
single-use promotion permits, and offline-verifiable promotion evidence.

Real Cloudflare Artifacts repository/token behavior has been exercised. The
full Worker → Queue → Durable Object → evaluation → verdict → Container
promotion path is implemented and builds in CI.

## Claims to withhold until the live run exists

Do **not** yet claim that the complete MADGRIX production path has run
end-to-end on Cloudflare. Do not call the synthetic benchmark a real-world
accuracy improvement. Do not claim Sigstore-backed production signing; the
competition implementation uses Ed25519 DSSE envelopes. Do not claim the
Cloudflare beta fork endpoint works; the documented import fallback is used
when its known beta failure signature occurs.

## Submission assets still needed

- successful live-E2E transcript;
- live promotion bundle + independent verifier transcript;
- final demo video;
- screenshots/diagram chosen for the submission page;
- concise project description and technical write-up;
- optional real benchmark evidence if completed in time;
- final name/trademark clearance before broader commercial launch.

The engineering critical path is complete enough to attempt the real
deployment. The next blocker is evidence collection on the live Cloudflare
runtime, not another round of protocol redesign.
