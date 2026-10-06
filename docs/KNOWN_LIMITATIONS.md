# Known limitations

Status words: **IMPLEMENTED**, **TESTED LOCALLY**, **TESTED ON CLOUDFLARE**, **NOT YET VERIFIED**.

The 296-test record belongs to `git4agents/combined` `4a8c4cc7b521688f839f0f332605dcefa3984c38` (LF archive, WSL Node v24.21.0, slice OK, head-move OK, benchmark `zero_tolerance_ok: true`). The unrecorded-marker scan on `competition/security` is recorded in `docs/COMPETITION_RED_TEAM.md` and `docs/COMPETITION_FINALIZATION.md`. It was not a Cloudflare run. After the demo fleet manifest, an LF copy of `49e53c3205ceccebeb4ae84df84ecd591e966bc2` on the same Node was 300 passed and 0 failed. `npm run slice`, `npm run head-move`, and `npm run bench` were not re-run as standalone commands for that SHA. Neither count is this integration.

## Not a Cloudflare result

Nothing in this SHA was deployed. `live:e2e` was not run. The public worker root returns `not_found` and does not name a SHA. The container image was not built here. Docker was absent at the baseline build, and `npm run build` was not re-run after the composition commits.

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
- The live runner requires `fleet validate` to list the same agent ids as the crew config. `configs/git4agents-demo-composition.yaml` lists `parent`, `sub-api`, `sub-ui`, `sub-test`. The runner pairs it with `configs/demo-composition.json`. A `fleet` binary older than Agentfleet `paper-hardening` `49032db` omits `summary.agent_ids`, so set `MADGRIX_FLEET_BIN`. A live run of that JSON is **NOT YET VERIFIED** on Cloudflare.
- Queue idempotency is tested with in-memory delivery. A live redelivery was not observed.
- Canonical writes in tests are local git or FakeArtifacts. The live fork token's inability to push the canonical repo was not observed on Artifacts.
- Offline verify trusts the pinned key the operator passes. A bundle that carries a different key does not select that key. This was tested locally, including the slice harness.

## Developer environment

- CI is Node 24 on Ubuntu for `main`, `codex/**`, and pull requests. It does not run on `git4agents/combined`.
- This Windows checkout has `core.autocrlf=true`. Git blobs are LF. WSL `bash` on the working tree fails `set -o pipefail` because of a trailing CR. Run container tests from an LF archive or a Linux checkout.
- Windows Node is v22.17.0. `tsc` works. `node --test` on TypeScript needs Node 24, or `NODE_OPTIONS=--experimental-strip-types` on every spawned child.
- WSL `npx tsc` fails closed: the installed `node_modules` has `@typescript/typescript-win32-x64` and not the linux package.
- `docs/DEMO_SCRIPT.md` narrates 300 tests and 93 suites from the LF run of `49e53c3`. That count is not this tree. The fork-crew overlap behavior in that file, in `docs/GIT_PROBLEMS.md`, and in `specs/amendments/composition-result-v1.md` is CONFLICTED with no candidate commit. Conflict-marker commits are not ordinary output. The scan behavior is this file, `docs/COMPETITION_FINALIZATION.md`, `docs/COMPETITION_RED_TEAM.md`, `docs/SECURITY_BOUNDARIES.md`, and `specs/amendments/unresolved-merge-artifact-v1.md`. That suite was not run on Cloudflare.

## Deliberately not done

No merge to `main`. No deploy. No new paid Cloudflare resource. No edit to `PROMOTION_PROTOCOL.md`, `EVALUATION_THREAT_MODEL.md`, or `CLOUDFLARE_RUNTIME_MODEL.md`. The unrecorded-marker scan is pushed on `competition/security` only.
