# Spec amendment: evaluation-config-digest-v1 — the evaluation bundle commits to its configuration

**Status:** proposed · **Date:** 2026-10-03
**Affects:** It implements `PROMOTION_PROTOCOL.md` (FROZEN-v1) §7 ("all evaluation
inputs ... MUST be hashed into the evaluation bundle") without changing it. It
decides what the authority puts in the `ATTESTATION_PROTOCOL.md` (stable core)
test-result predicate's configuration digest. It supersedes one sentence of
`authority-signing-v1.md` item 2. These are changed via this amendment file only;
spec files are NOT edited.

## (1) The invariants (quoted from the specs)

`PROMOTION_PROTOCOL.md` §7 (FROZEN-v1):

> "All evaluation inputs (candidate SHA, policy digest, environment descriptor)
> and all outputs MUST be hashed into the evaluation bundle."

`ATTESTATION_PROTOCOL.md`:

> "Test results | **in-toto test-result predicate** (existing) | Subject =
> candidate SHA-256; predicate carries test configuration digest +
> PASS/WARN/FAIL."

`EVALUATION_THREAT_MODEL.md` §4.3 (FROZEN):

> "evaluation configuration, oracle material, and result-signing are locked to
> the evaluation domain before any contender output exists"

## (2) What the implementation violated

- The evaluation bundle carried results but nothing about what produced them: not
  the commands, the test globs, the hidden tests, or the evaluator's version and
  runtime. Two evaluations under different hidden tests differed only in their
  results.
- Since `authority-signing-v1`, the signed test-result statement used the
  evaluation bundle's own hash as its "configuration" digest, because the
  authority had no configuration digest to use.

## (3) The change

1. Before it fetches any candidate, `scripts/evaluate-candidate.ts` fixes its
   configuration:

   ```
   { format: "madgrix-evaluation-config/v1",
     commands: { hidden, regression, semantic, static, security },   // null when not set
     test_globs: [...],             // the defaults plus MADGRIX_TEST_GLOBS
     hidden_tests_sha256: ...,      // see below; null without MADGRIX_HIDDEN_TESTS_DIR
     evaluator: MADGRIX_HARNESS_VERSION,
     runtime: { node, platform, arch } }
   ```

   `hidden_tests_sha256` is the SHA-256 of the canonical JSON of the sorted
   `[relative path, SHA-256 of content]` pairs of the hidden-test files, with
   symlinks followed as the copy into the run directory follows them.
   `evaluation_config_sha256 = SHA-256(canonical_json(configuration))` goes into
   the bundle. `bundle_hash` therefore commits to it, and so do the permit and
   the authority statement, which bind `bundle_hash`. The evaluator's result
   JSON also carries the full configuration, for audit.
2. `submitEvaluation` rejects a bundle whose `evaluation_config_sha256` is
   present but is not 64 lowercase hex characters.
3. `recordPromotionBundle` puts the stored evaluation's `evaluation_config_sha256`
   into the test-result statement's `configuration.digest.sha256`. A bundle
   without one keeps its bundle hash there. That covers the in-process slice
   harness, which evaluates functions rather than commands, and records from
   before this change.

## Not claimed

- The digest identifies a configuration but does not disclose it. An auditor
  needs the configuration itself (from the evaluator's result JSON) to recompute
  and compare it. The promotion bundle does not carry the configuration, and
  `verify` does not check this digest.
- Commands are hashed as text. What they do also depends on the evaluator host:
  installed tools, network access, and anything beyond Node version, platform and
  architecture. That is not captured.
- The authority does not require the field. A bundle without it is still
  admissible; only a malformed value is rejected.

Implementation notes: `src/lib/types.ts` (`EvaluationBundle.evaluation_config_sha256`),
`src/lib/task-state.ts` (`submitEvaluation`, `recordPromotionBundle`),
`scripts/evaluate-candidate.ts`. Tests: `test/evaluator-isolation.test.ts`,
`test/promotion-bundle.test.ts`, `test/evidence-auth.test.ts`.
