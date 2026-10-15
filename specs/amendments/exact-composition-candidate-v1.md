# Spec amendment: exact-composition-candidate-v1 — one promotable SHA

**Status:** proposed · **Date:** 2026-10-12
**Affects:** `PROMOTION_PROTOCOL.md` (FROZEN-v1) §9.5 and §12, and the last
sentence of `specs/amendments/composition-result-v1.md` §3, by this amendment
file only. The frozen spec files are not edited. `composition-result-v1.md`
is not edited.

## (1) The sentence this tightens

`composition-result-v1.md` §3:

> "After COMPOSED or RESOLVED, a contributing SHA is not evidence for the new candidate and cannot be permitted or promoted in its place. A later SHA that is not a contributing SHA (an empty republish of the composed commit, for example) is a different candidate and needs its own evaluation. It is not treated as the already-recorded SHA."

That last sentence can be read as allowing evaluation, a verdict, a permit, and promotion of any SHA that merely happens not to be listed in `contributing_shas`. A previously accepted SHA, an old candidate, an arbitrary SHA, and a member SHA omitted from `contributing_shas` all fit that reading. The work graph already hid a member SHA. The permit path did not.

`composition-result-v1.md` §2 already says COMPOSED and RESOLVED do not change their candidate SHA, and that a contributing SHA cannot be recorded as that candidate.

## (2) The authority

For a contender that has a composition record, there is at most one promotable SHA.

- **PENDING, COMPOSING, CONFLICTED, RESOLVING.** No SHA is promotable.
- **COMPOSED, RESOLVED.** Only `composition.candidate_sha` is promotable, and only when that SHA is not a crew contribution.

A crew contribution is any `contributing_shas` entry, any agent `sha`, and any conflict-side `sha`. Leaving a SHA out of `contributing_shas` does not make it a new candidate.

`recordComposition` rejects a COMPOSED or RESOLVED candidate that equals any of those SHAs. A record that already names one is not promotable: the shared predicate returns no candidate, and the work graph uses that same predicate.

The requested, evaluated, verdict, permit, and promotion SHA must equal that one candidate. Every other SHA is refused, including:

- a previously accepted SHA
- an older candidate
- an arbitrary SHA
- a member or side SHA omitted from `contributing_shas`
- an empty republish that is not the bound candidate

COMPOSED and RESOLVED still cannot rebind `candidate_sha`. An empty republish can be the candidate only when the control plane records it as that candidate before the binding is fixed. After the binding is fixed, it is not a second promotable SHA.

`submitEvaluation` throws. `runVerdictSeam` excludes the SHA and does not ACCEPT it. `issuePermit` returns `UNRESOLVED_CONFLICT` and stores no permit. `attemptPromotion` and `runPromotion` return `UNRESOLVED_CONFLICT`, do not consume a permit, and emit no `canonical_write`.

The predicate is `promotableCompositionSha` / `compositionBlocks` in `src/lib/composition-authority.ts`. `authorityRefusal` in `src/lib/authority-refusal.ts` is what the permit and promotion paths call. They do not each keep a shorter check.

## (3) What this amendment does not say

It does not make a composition record optional. A task with no composition record is unchanged. It does not authorize a coding agent to record the composition. It does not treat a passing local suite as a Cloudflare run.
