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

The evaluator (`scripts/evaluate-candidate.ts`) scans the candidate blobs and the clone's index, if any. It records that scan on the bundle. An empty path list means that scan found none.

## (3) Three independent layers

These layers do not stand in for each other.

1. **Composition state.** `specs/amendments/composition-result-v1.md`. The control plane's composition record. `CONFLICTED` has no candidate. A contributing SHA is not the composed or resolved candidate. This layer does not read blobs. This amendment does not change it.

2. **Evaluation scan completeness and result.** The evaluation zone writes `merge_artifact_scan`:

   ```json
   {
     "status": "COMPLETE",
     "scanner": "madgrix-merge-artifact/v1",
     "candidate_sha": "<the bundle candidate>",
     "tree_sha256": "<the bundle tree digest>",
     "paths": []
   }
   ```

   `paths` is an array of non-empty strings, in the order the scanner reports them. `unresolved_merge_artifacts`, when a producer still sends it, must be that same list. The authority does not fetch the repository to fill or check this record.

   - A record is complete only when `status` is `COMPLETE`, `scanner` is `madgrix-merge-artifact/v1`, `candidate_sha` equals the bundle's candidate, `tree_sha256` equals the bundle's tree digest, and `paths` is an array of non-empty strings. A legacy list that is present and differs is not complete.
   - Eligibility fails `evaluation_integrity_valid` when the record is missing or not complete. Passing tests do not compensate. `admission.no_eval_tampering` remains part of that same gate.
   - Eligibility fails `no_unresolved_merge_artifacts` when the record, or the legacy list, names a path. Passing tests do not compensate.
   - `issuePermit` and `attemptPromotion` return `UNRESOLVED_CONFLICT`, store or consume no permit, and return no `canonical_write` effect, when the stored bundle's scan is not complete or names a path.
   - `runPromotion` returns that outcome before it mints a canonical write token in the same cases.
   - A complete record with `paths: []` passes this layer. That is the evaluation zone's statement that its scan found none. It is not a statement that the authority saw the blobs.

3. **Promotion-time independent tree scan.** `container/promote.sh` and its model in `src/lib/git-promotion.ts` scan the fetched candidate's blobs after the tree is readable and before any fast-forward, including before `ALREADY_WRITTEN`. A marker pair exits 48, `OUTCOME=UNRESOLVED_CONFLICT`. The destination ref is not updated. The permit is not finalized. This scan stays even when layer 2 accepted the bundle. It is the check against an evaluator error, a compromised evaluator, a malformed legacy bundle, and an evidence or control-plane bug. A fetched commit has no unmerged index. The container's check is the blob scan. It does not trust `merge_artifact_scan`.

## (4) What a completed empty scan does not prove

The evaluation zone is a trusted evidence-producing zone under the frozen threat model. A caller that holds the evaluation token can submit a well-formed `merge_artifact_scan` with `paths: []` for a tree that contains markers. The authority may accept that statement and may issue a permit. This amendment does not claim that lie is stopped before permit issuance. The authority does not scan the repository. The promotion container's independent scan is what returns `UNRESOLVED_CONFLICT`, leaves the permit unconsumed, and does not move canonical HEAD.

No other measurement in the bundle is given a stronger guarantee by this record. Completeness checks the shape and the binding of the statement. It does not prove the statement is true.

## (5) What this amendment does not say

Marker text that a project intentionally contains, including a document that quotes a conflict, is refused. That is fail-closed on this pattern, not a judgment that the document is a bad merge.

No claim is made that the absence of these artifacts means the candidate is free of conflicting intent.
