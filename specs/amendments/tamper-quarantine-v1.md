# Spec amendment: tamper-quarantine-v1 — quarantine on a changed evaluation file

**Status:** proposed · **Date:** 2026-10-03
**Affects:** It implements `PROMOTION_PROTOCOL.md` (FROZEN-v1) §6 ("Failing
`no_eval_tampering` MUST additionally move the contender to `QUARANTINE`") and §12
for the production evidence path. It decides which tampering findings of
`evidence-integrity-v1.md` count as an "evaluation-file modification attempt" (§9.5),
and it replaces that amendment's "does not quarantine" caveat. These are changed via
this amendment file only; spec files are NOT edited.

## (1) The invariants (quoted from the specs)

`PROMOTION_PROTOCOL.md` §6 (FROZEN-v1):

> "A candidate failing any admission gate MUST NOT proceed to evaluation.
> Failing `no_eval_tampering` MUST additionally move the contender to
> `QUARANTINE`."

§9.5:

> "Quarantine is triggered ONLY by mechanically evidenced violations:
> evaluation-file modification attempt, unauthorized canonical write, ..."

`EVALUATION_THREAT_MODEL.md` §6 (FROZEN):

> "1. Candidate deletes or modifies visible tests → ... → REJECT + QUARANTINE."
>
> "5. Candidate submits unrelated changes → scope gate fails → REJECT."

## (2) The conflict, and how it is resolved

`evidence-integrity-v1.md` counts three kinds of change as tampering: runner
configuration, test material, and paths outside the claim scope. Spec 1 §6 would
quarantine all three, but spec 3 §6 attack 5 says unrelated (out-of-scope) changes are
only rejected. Before this amendment nothing quarantined in the production path:
the evaluator reported a failed gate and the authority recorded it.

Resolution (the operator-of-record's decision, 2026-10-03): only a changed
**evaluation file** quarantines, meaning runner configuration or test material.
That is the §9.5 trigger and spec 3 attack 1. A path outside the claim scope, an
unsafe path, or a missing baseline still fails `no_eval_tampering` (and the bundle is
never selectable), but it does not quarantine.

## (3) The change

1. The evaluator adds `eval_file_changes` to the bundle: the changed paths that are
   runner configuration or test material (`evalFileChanges`,
   `src/lib/eval-gates.ts`). It is an empty list when there are none. Because
   `bundle_hash` covers it, the list is part of the content-addressed evidence.
2. `submitEvaluation` checks that the list contains only non-empty strings. A
   non-empty list must come with `admission.no_eval_tampering: false`, or the
   bundle is rejected as inconsistent.
3. When a bundle with a non-empty list is `RECORDED`, the same transition
   quarantines the contender: trigger `eval_file_modification`, evidence = the
   bundle hash. The usual sanctions apply (spec 3 §7): every token id revoked,
   workflow cancelled, operator notified, the contender's evaluations tainted.
   A contender already `QUARANTINED` or `REVOKED` is not quarantined again; the
   first evidence stands. Review is unchanged (`reviewQuarantine`: a passing
   re-check plus an operator-signed determination).
4. The Durable Object returns `quarantined` and the effects. The Worker's
   `/evidence` route executes the effects, which revokes the fork's tokens in
   Artifacts, and does not echo them to the evaluator.

## Not claimed

- The trigger is only as good as the evaluator's classification. A file a runner
  reads but that matches no runner-configuration name or test glob (see
  `evidence-integrity-v1.md`) is not an evaluation file, so changing it does not
  quarantine.
- `cancel_workflow` and `notify` are still the Worker's logged stubs. Only token
  revocation acts.
- The in-process slice harness builds its bundles without `eval_file_changes` and
  still quarantines its tampering contender with an explicit call.

Implementation notes: `src/lib/types.ts` (`EvaluationBundle.eval_file_changes`),
`src/lib/eval-gates.ts` (`evalFileChanges`, `evaluatorGates`),
`src/lib/task-state.ts` (`submitEvaluation`), `src/do/TaskAuthority.ts` (`/evidence`),
`src/worker/index.ts` (`handleEvidence`), `scripts/evaluate-candidate.ts`. Tests:
`test/evidence-auth.test.ts`, `test/contender-binding.test.ts`,
`test/eval-gates.test.ts`, `test/evaluator-isolation.test.ts`.
