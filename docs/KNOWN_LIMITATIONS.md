# Known limitations

Status words: **IMPLEMENTED**, **TESTED LOCALLY**, **TESTED ON CLOUDFLARE**, **NOT YET VERIFIED**.

Recorded against `git4agents/combined` `4a8c4cc7b521688f839f0f332605dcefa3984c38` on 2026-10-06. Local suite: LF `git archive` of that SHA, WSL Node v24.21.0, 296 passed, slice OK, head-move OK, benchmark `zero_tolerance_ok: true`.

## Not a Cloudflare result

Nothing in this SHA was deployed. `live:e2e` was not run. The public worker root returns `not_found` and does not name a SHA. The container image was not built here. Docker was absent at the baseline build, and `npm run build` was not re-run after the composition commits.

## Composition

- The authority learns about CONFLICTED only from `POST /tasks/:id/composition` (control token). A marker commit that is never recorded is still an ordinary candidate. The fork-crew runner no longer creates that commit.
- The resolver does not evaluate, permit, or promote. `live-e2e` is the control-plane caller, and it was not executed.
- An empty republish, used when the first push is not observed, is a new SHA. The composition record's candidate SHA is updated to that republish in the runner result. If a record was stored for the pre-republish SHA, the republish is a different candidate and needs its own evaluation.
- Sub-agents share one machine and one fork. Worktrees stop them editing one directory at the same time. They are not separate microVMs. A sub-agent command can still read the parent repo's objects.
- TheUstad checks that HEAD is the frozen baseline and the worktree is clean before combine. It does not score the composed or resolved tree.
- Conflict classification stored by the authority is only `textual-line-overlap`. Other overlap kinds are not a recorded class.
- WorkClaim fields were not extended. The graph reads claims, contenders, conflict reports, and the composition record. It is one HTML page, not a second database.

## Evidence and promotion

- `submitEvaluation` does not recompute `bundle_hash`. The verdict seam does. A stored bundle with a bad hash is ineligible. The evaluation domain is the trust point for admission flags.
- The demo fixture's authority check refuses a contributing SHA. It does not execute `test/integration/check.js`.
- The live runner requires `fleet validate` to list the same agent ids as the crew config. The demo JSON has `sub-test`. The shipped fleet manifest does not. The local demo test does not call `fleet`. A live run of that JSON is **NOT YET VERIFIED** and will fail the roster check until a matching manifest exists.
- Queue idempotency is tested with in-memory delivery. A live redelivery was not observed.
- Canonical writes in tests are local git or FakeArtifacts. The live fork token's inability to push the canonical repo was not observed on Artifacts.
- Offline verify trusts the pinned key the operator passes. A bundle that carries a different key does not select that key. This was tested locally, including the slice harness.

## Developer environment

- CI is Node 24 on Ubuntu for `main`, `codex/**`, and pull requests. It does not run on `git4agents/combined`.
- This Windows checkout has `core.autocrlf=true`. Git blobs are LF. WSL `bash` on the working tree fails `set -o pipefail` because of a trailing CR. Run container tests from an LF archive or a Linux checkout.
- Windows Node is v22.17.0. `tsc` works. `node --test` on TypeScript needs Node 24, or `NODE_OPTIONS=--experimental-strip-types` on every spawned child.
- WSL `npx tsc` fails closed: the installed `node_modules` has `@typescript/typescript-win32-x64` and not the linux package.
- `docs/DEMO_SCRIPT.md` and `docs/GIT_PROBLEMS.md` still describe older test counts and the old "keep conflict markers" behavior. The current behavior is this file, `docs/COMPETITION_FINALIZATION.md`, and `specs/amendments/composition-result-v1.md`.

## Deliberately not done

No merge to `main`. No push. No new paid Cloudflare resource. No edit to `PROMOTION_PROTOCOL.md`, `EVALUATION_THREAT_MODEL.md`, or `CLOUDFLARE_RUNTIME_MODEL.md`.
