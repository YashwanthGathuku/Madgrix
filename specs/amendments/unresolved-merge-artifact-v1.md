# Spec amendment: unresolved-merge-artifact-v1 — a tree with merge markers is not a candidate

**Status:** proposed · **Date:** 2026-10-06
**Affects:** `PROMOTION_PROTOCOL.md` (FROZEN-v1) §9.5 and §12, and `specs/amendments/composition-result-v1.md`, by this amendment file only.
The frozen spec files are not edited.

## (1) The invariant

composition-result-v1 refuses a fork crew after the control plane records `CONFLICTED`. That gate does not see a commit somebody else built. A git commit that contains unresolved merge markers, submitted without `POST /tasks/:id/composition`, is still an ordinary candidate under that amendment alone.

A candidate whose tree contains a known unresolved merge artifact is not an admissible exact state. Skipping the composition route must not make it eligible, permittable, or promotable.

This amendment does not claim to find every semantic conflict. Disjoint text can still be wrong. The signals below are the artifacts of an unfinished textual merge, nothing else.

## (2) The signals

`src/lib/merge-artifacts.ts`:

- **Blob markers.** A blob contains a conflict-marker pair when some line is N `>` characters, N ≥ 7, and an earlier line in the same blob is N `<` characters. The marker is at the start of the line. The rest of the line is empty or a space and a label. The `=======` line git usually writes between them is not required, and a line of `=` alone is not a marker.
- **Unmerged index.** When a caller has an index, `git ls-files --unmerged` stages 1, 2, and 3 are unresolved paths. A commit does not store an unmerged index. Git refuses to commit one. A submitted SHA is judged by its blobs.

The evaluator (`scripts/evaluate-candidate.ts`) scans the candidate blobs and the clone's index, if any, and records the paths on the bundle as `unresolved_merge_artifacts`. An empty array means that scan found none. A bundle that omits the field was not scanned by this evaluator.

## (3) The authority

The composition record is unchanged. This check does not read it.

- Eligibility fails `no_unresolved_merge_artifacts` when the stored bundle's list is non-empty. Passing tests do not compensate.
- `issuePermit` and `attemptPromotion` return `UNRESOLVED_CONFLICT`, store or consume no permit, and return no `canonical_write` effect, when the bundle names an artifact.
- `runPromotion` returns that outcome before it mints a canonical write token when the bundle names an artifact.

A bundle that omits the field, or sends an empty list, is not by itself proof of a scan. The evaluation zone is the component that fills the field. A caller that holds the evaluation token can lie about it, as it can lie about any other measurement.

## (4) The promotion container

`container/promote.sh` and its model in `src/lib/git-promotion.ts` scan the fetched candidate's blobs after the tree is readable and before any fast-forward, including before `ALREADY_WRITTEN`. A marker pair exits 48, `OUTCOME=UNRESOLVED_CONFLICT`. The destination ref is not updated. The permit is not finalized.

A fetched commit has no unmerged index. The container's check is the blob scan. It does not trust `unresolved_merge_artifacts`.

## (5) What this amendment does not say

Marker text that a project intentionally contains, including a document that quotes a conflict, is refused. That is fail-closed on this pattern, not a judgment that the document is a bad merge.

No claim is made that the absence of these artifacts means the candidate is free of conflicting intent.
