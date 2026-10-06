# Known limitations

Status words: **IMPLEMENTED**, **TESTED ON FINAL SHA LOCALLY**, **TESTED ON CLOUDFLARE**, **NOT VERIFIED**.

The current tree is `competition/final`. Commands, counts, and the image build for that tree are in `docs/FINAL_INTEGRATION_REPORT.md`. Nothing in that report was run on Cloudflare.

Older counts stay with their SHAs. The 296-test record belongs to `git4agents/combined` `4a8c4cc7b521688f839f0f332605dcefa3984c38` (LF archive, WSL Node v24.21.0). The unrecorded-marker scan on `competition/security` is recorded in `docs/COMPETITION_RED_TEAM.md` and `docs/COMPETITION_FINALIZATION.md`. It was not a Cloudflare run. An LF copy of collaboration `49e53c3205ceccebeb4ae84df84ecd591e966bc2` on the same Node was 300 passed and 0 failed. `npm run slice`, `npm run headmove`, and `npm run bench` were not re-run as standalone commands for that collaboration SHA. Neither count is the final integration.

## Not a Cloudflare result

Nothing in this SHA was deployed. `live:e2e` was not run. On 2026-10-06 a readiness session saw `GET https://madgrix.ygathuku96.workers.dev/` return 404 `not_found`. That response does not name a SHA. It is **NOT VERIFIED** for this tree. `npm run build` did not produce a container image. The Worker bundle step finished and the image step lost the Docker engine. That failure is in `docs/FINAL_INTEGRATION_REPORT.md`. It is not a Cloudflare run.

## Composition

- A fork-crew `CONFLICTED` record still comes only from `POST /tasks/:id/composition` (control token). The runner does not create a marker commit. A commit someone else builds is not eligible when the evaluation bundle's `merge_artifact_scan` is missing, malformed, mis-bound, or names a path. `container/promote.sh` still exits 48 before fast-forward. See `specs/amendments/unresolved-merge-artifact-v1.md`.
- A completed scan with `paths: []` is the evaluation zone's statement, not a blob the authority read. The authority may permit that statement even when the tree contains markers. The promotion container is the check that refuses the write. Absence of markers is not proof that the edits agree.
- The resolver does not evaluate, permit, or promote. `live-e2e` is the control-plane caller, and it was not executed.
- An empty republish, used when the first push is not observed, is a new SHA. The composition record's candidate SHA is updated to that republish in the runner result. If a record was stored for the pre-republish SHA, the republish is a different candidate and needs its own evaluation.
- Sub-agents share one machine and one fork. Worktrees stop them editing one directory at the same time. They are not separate microVMs. A sub-agent command can still read the parent repo's objects.
- TheUstad checks that HEAD is the frozen baseline and the worktree is clean before combine. It does not score the composed or resolved tree.
- Conflict classification stored by the authority is only `textual-line-overlap`. Other overlap kinds are not a recorded class.
- WorkClaim fields were not extended. The graph reads claims, contenders, conflict reports, and the composition record. It is one HTML page, not a second database.

## Evidence and promotion

- `submitEvaluation` does not recompute `bundle_hash`. The verdict seam does. A stored bundle with a bad hash is ineligible. The evaluation domain is the trust point for admission flags.
- The demo fixture's authority check refuses a contributing SHA. It does not execute `test/integration/check.js`.
- The default demo roster check does not run Agentfleet. `assertFleetRoster` reads `configs/git4agents-demo-composition.yaml` for `parent`, `sub-api`, `sub-ui`, and `sub-test`, in that order, with bounded paths, and pairs it with `configs/demo-composition.json`. `fleet validate` runs only when `MADGRIX_FLEET_BIN` is a non-empty string, and then only as a roster cross-check. It does not execute the sub-agents. An older fleet that omits `summary.agent_ids` fails only that explicit cross-check. The sibling contender swarm (`configs/git4agents-contenders.yaml` and the non-fork path in `scripts/live-e2e.ts`) still needs Agentfleet `summary.agent_ids` or `MADGRIX_AGENT_IDS`. A live run is **NOT VERIFIED**.
- Queue idempotency is tested with in-memory delivery. A live redelivery was not observed.
- Canonical writes in tests are local git or FakeArtifacts. The live fork token's inability to push the canonical repo was not observed on Artifacts.
- Offline verify trusts the pinned key the operator passes. A bundle that carries a different key does not select that key. This was tested locally, including the slice harness.

## Developer environment

- The supported competition suite is Linux or WSL2, Node >= 24, and LF files. CI is Node 24 on Ubuntu for `main`, `codex/**`, and pull requests. It does not run on `competition/final`.
- This Windows checkout has `core.autocrlf=true`. Git blobs are LF. `git archive` on this Git rewrites the export to CRLF unless it is run with `core.autocrlf=false` and `core.eol=lf`. WSL `bash` on the CRLF working tree fails `set -o pipefail`. Run container tests from an LF archive or a Linux checkout.
- Windows Node v22.17.0 does not strip TypeScript by default. It is not the competition suite.
- `docs/DEMO_SCRIPT.md` narrates 300 tests and 93 suites from the LF run of `49e53c3`. That count is not this tree. The fork-crew overlap behavior in that file, in `docs/GIT_PROBLEMS.md`, and in `specs/amendments/composition-result-v1.md` is CONFLICTED with no candidate commit. Conflict-marker commits are not ordinary output. The scan behavior is this file, `docs/COMPETITION_FINALIZATION.md`, `docs/COMPETITION_RED_TEAM.md`, `docs/SECURITY_BOUNDARIES.md`, and `specs/amendments/unresolved-merge-artifact-v1.md`. That older suite was not run on Cloudflare.

## Deliberately not done

No merge to `main`. No deploy. No push of `competition/final` in this integration. No new paid Cloudflare resource. No edit to `PROMOTION_PROTOCOL.md`, `EVALUATION_THREAT_MODEL.md`, or `CLOUDFLARE_RUNTIME_MODEL.md`. The scan from `competition/security` `9670893f36a986a59d153de4fbbf3ef10f1d9687` is in this branch. Collaboration `49e53c3205ceccebeb4ae84df84ecd591e966bc2` is on `origin/competition/collaboration`. It was not merged to `main` and was not run on Cloudflare. The later collaboration commit `16dbd7565966aa4160c0762a2a2eeb4e4a4e1378` was not cherry-picked.
