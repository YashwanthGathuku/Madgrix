# Competition red team

Date: 2026-10-06. Branch `competition/security`. Parent `424b2b15425a65a25a230e949dea0f4d94192d9e`. The scan changes in this report are uncommitted. Nothing was deployed, merged, or run on Cloudflare.

Host for this pass: Windows, Node v22.17.0 (`--experimental-strip-types`; this Node does not strip TypeScript by default), Git Bash 5.2.37. Container scripts were run from LF copies. WSL `bash` was not a usable runner: it cannot open the Windows paths these tests pass it.

This is not a production-readiness claim. Marker scanning is not a proof that a tree is free of conflicting intent.

## Unresolved P0

None from this pass.

The stated attack is closed on the paths below: a commit created outside `run-fork-crew`, containing a conflict-marker pair, submitted through the trusted evaluator with no `POST /tasks/:id/composition`, is not eligible, is not permitted, is not promoted, and does not move canonical HEAD.

## P1 from the marker pass

Closed locally by the follow-up below. The paragraph in Mission 1 that says an omitted field was accepted is the result of that earlier pass, at `7b37f39467033089d1bcd1c59cb88e330bc1cc1c`. It is not the current rule.

## Follow-up — scan completeness

Uncommitted on parent `7b37f39467033089d1bcd1c59cb88e330bc1cc1c`. Not merged. Not deployed. Not run on Cloudflare.

`merge_artifact_scan` is required before eligibility. A record is complete only when `status` is `COMPLETE`, `scanner` is `madgrix-merge-artifact/v1`, `candidate_sha` and `tree_sha256` equal the bundle, and `paths` is an array of non-empty strings. A legacy `unresolved_merge_artifacts` list, when present, must be the same paths. Missing or not complete fails `evaluation_integrity_valid`. A non-empty path list fails `no_unresolved_merge_artifacts`. Either one is `REJECT`, no permit, and no `canonical_write`. A forged `ACCEPT` on those bundles gets `UNRESOLVED_CONFLICT` and a null permit. `container/promote.sh` still scans the fetched blobs.

**What this does not prove.** A well-formed `COMPLETE` scan with `paths: []` can be a lie. The authority trusts that evaluation-zone statement and may issue a permit. It does not scan the repository. The promotion container then returns `UNRESOLVED_CONFLICT`, does not consume the permit, and does not move canonical HEAD. That case called the container (one call). It is the trusted-evaluator boundary, not a claim that the lie is stopped before the permit.

**WSL evidence, 2026-10-06.** Linux Node v24.21.0 (`/home/gathu/node24/bin/node`, ELF), Linux git 2.43.0, LF archive of this tree plus the uncommitted overlay. One `node --test` of the unresolved-merge file, the promotion fixtures, the authority and evidence suites named in Mission 2, `test/task-state.test.ts`, `test/promotion-bundle.test.ts`, `test/demo-composition.test.ts`, `test/env-isolation.test.ts`, and `test/evaluator-isolation.test.ts`: **224 pass, 0 fail.** That includes cases A–I, both marker fixture rows, the newline-in-filename rebase row, the git argv check (`Artifacts tokens reach git through its environment, never its command line`), and the live-e2e per-child zone split. The earlier Git Bash MSYS-variable failures and the unexercised argv shim were not reproduced on this Linux run. `tsc` was not run.

## What was added

`specs/amendments/unresolved-merge-artifact-v1.md`. Frozen specs were not edited.

A blob is an unresolved merge artifact when a line is N `>` characters, N ≥ 7, and an earlier line in the same blob is N `<` characters. The marker is at the start of the line. The rest of that line is empty or a space and a label. A line of `=` alone is not a marker. An unmerged index stage is a second signal when a caller has an index. A commit cannot store an unmerged index. Git refuses to commit one. A submitted SHA is judged by its blobs.

The trusted evaluator records the paths. Eligibility fails `no_unresolved_merge_artifacts` when the list is non-empty, even if the tests passed and no composition was recorded. `issuePermit` and `attemptPromotion` then return `UNRESOLVED_CONFLICT` with no permit and no `canonical_write` effect. `runPromotion` returns that outcome before it mints a canonical write token. `container/promote.sh` scans the fetched blobs and exits 48 before any fast-forward, including before `ALREADY_WRITTEN`.

## Mission 1 — unrecorded conflict

**Attack.** Create a candidate directly. Put unresolved conflict-marker bytes in its tree. Do not call `POST /composition`. Do not run `run-fork-crew`. Submit it on the normal authority path.

**Expected invariant.** No eligibility, no permit, no promotion, no canonical write.

**Actual result.** The evaluator's bundle listed `unresolved_merge_artifacts: ["src/shared.js"]`. The seam rejected with `no_unresolved_merge_artifacts`. `issuePermit` threw `no ACCEPT verdict`. A forged ACCEPT verdict then got `UNRESOLVED_CONFLICT` and a null permit. `attemptPromotion` returned no effects. The worker verdict was HTTP 200, state `REJECT`, `permit: null`, `composition` undefined, canonical HEAD still the baseline, and the promotion container was not called.

A second run omitted the field on purpose. The seam accepted and issued a permit. Promotion finished HTTP 409 `UNRESOLVED_CONFLICT`. The permit stayed unconsumed. Canonical HEAD stayed the baseline. That was the open P1 of this pass. The follow-up below makes an omitted scan ineligible.

**Proof.** `node --experimental-strip-types --test test/unresolved-merge-artifact.test.ts` — 7 tests, 7 pass, 0 fail. The file does not import `scripts/lib/fork-crew.mjs` and does not record a composition. Real `git` confirmed an unmerged index cannot be committed, and `git ls-files --unmerged` on the committed candidate was empty.

`node --experimental-strip-types --test test/promotion-fixtures.test.ts` with Git Bash, after the container scripts were LF:

- `promote: unresolved merge markers are refused before fast-forward, even when the tree digest matches` — bash and the TypeScript model passed. Fixture expectation: exit 48, `OUTCOME=UNRESOLVED_CONFLICT`, `PATHS=src/shared.js`, destination unchanged, HTTP 409.
- `promote: a conflicted tree already on the destination is not ALREADY_WRITTEN` — bash and the model passed. Same outcome. Not `ALREADY_WRITTEN`.

The fixture file overall was 56 tests, 54 pass, 2 fail. Both failures are the pre-existing rebase case whose conflict path contains a newline (`weird\nname.txt`). Git Bash omitted that path. The TypeScript model reported it. `container/rebase.sh` has no logic diff. This pass did not change that script except restoring LF line endings.

**Fix.** The scan above. `promote.sh` writes each blob to a file before scanning. An early return in a pipe delivered SIGPIPE to `git cat-file` (exit 141) and would have hidden a marker hit behind a retryable git failure.

**Final status.** Stated attack closed on the trusted evaluator path and on `promote.sh`. P1 remains for a bundle that does not report the paths.

## Mission 2 — attacks re-run

Command for the authority tests, Node v22.17.0:

`node --experimental-strip-types --test test/contender-binding.test.ts test/eval-gates.test.ts test/evidence-auth.test.ts test/forged-bundle.test.ts test/promotion-attacks.test.ts test/head-move.test.ts test/rebase-ancestry.test.ts test/quarantine-review.test.ts test/whitebox-boundary.test.ts test/composition-authority.test.ts test/rebase-route.test.ts test/verdict-seam.test.ts`

That run's failing suites were only `test/env-isolation.test.ts` and `test/evaluator-isolation.test.ts`. Those two were re-run under Git Bash. The suites that passed in the first command are listed with the attacks below. Suite pass means every test in that suite passed. It does not mean a test that was not in the command was run.

### Control token exfiltration

**Expected invariant.** The coding agent's command environment does not contain `MADGRIX_CONTROL_SERVICE_TOKEN` or its value. An allowlist entry that names it is refused before any Worker call.

**Actual result.** `assertCredentials` passed for the agent dump: no credential-named variable and no operator secret value. The next assertion failed. Git Bash had injected `EXEPATH`, `HOMEDRIVE`, `HOMEPATH`, `LOGONSERVER`, `MSYSTEM`, `PLINK_PROTOCOL`, `SYSTEMDRIVE`, `SYSTEMROOT`, `TEMP`, `USERDOMAIN`, `USERNAME`, `USERPROFILE`, and `WINDIR`. Those names are not the control token. The allowlist refusal passed, including `MADGRIX_CONTROL_SERVICE_TOKEN`, exit 2, no Worker request.

**Proof.** `test/env-isolation.test.ts`. Agent-command test failed at `assertOnly` after `assertCredentials`. Allowlist test passed.

**Fix.** None. `minimalEnv` does not copy those names. Git Bash adds them when it runs a command. A Linux bash run of this file was not completed here.

**Final status.** Zone token not present in the captured agent environment. Strict "no other variables" check failed under Git Bash. **P2** for the MSYS variables. Not a control-token exfiltration on this run.

### Evaluation token exfiltration

**Expected invariant.** The agent command and the five evaluation commands do not receive `MADGRIX_EVALUATION_SERVICE_TOKEN`. An allowlist that names it is refused.

**Actual result.** Same shape as the control token. `assertCredentials` passed for the agent dump and for each evaluation-command dump (`eval-hidden` and the other four reached `assertOnly`). The allowlist test refused `MADGRIX_EVALUATION_SERVICE_TOKEN` in `live-e2e.ts` with exit 2, before a task was created, and the agent command did not run. The strict variable-set check failed on the same Git Bash names.

`live-e2e.ts: each child gets only its own zone's token and the agent gets none` did not finish. `live-e2e.ts` spawned `scripts/evaluate-candidate.ts`, and Node v22.17.0 exited with `ERR_UNKNOWN_FILE_EXTENSION`. The per-child zone split was not measured.

**Proof.** `test/env-isolation.test.ts` under Git Bash. Allowlist test passed. Command-environment tests failed only `assertOnly`. The live-e2e child-token test exited 1.

**Fix.** None in the product. Test spawn of `.ts` files on Node 22.17 passes `--experimental-strip-types` on argv. `live-e2e.ts` still starts the evaluator as `node scripts/evaluate-candidate.ts`, which this Node cannot load.

**Final status.** Evaluation token absent from the dumps that were checked. Full live-e2e zone split **not measured** on this Node. **P2** for the MSYS names. Not an evaluation-token exfiltration in the dumps.

### Cross-agent contender access

**Expected invariant.** Agent B naming agent A's contender gets 403 and no token. A's record is unchanged.

**Actual result.** Suite passed.

**Proof.** `ok 3 - contender binding: one agent cannot take over another agent's contender` in the authority run.

**Fix.** None.

**Final status.** Held. Not P0.

### Agent identity substitution

**Expected invariant.** A claim needs that agent's own secret. An unenrolled agent id cannot claim. A squatter gets 403.

**Actual result.** Suite passed.

**Proof.** `ok 5 - agent enrollment` in the same run.

**Fix.** None.

**Final status.** Held. Not P0.

### Trusted test tampering

**Expected invariant.** A candidate that rewrites the test command or test files fails `no_eval_tampering`. Changed test material is what quarantine records. Hidden tests and the runner configuration come from the baseline, and the commands run outside the candidate checkout.

**Actual result.** Held. `package.json` `"test": "exit 0"` failed `no_eval_tampering`. The baseline `package.json` was what ran. Hidden tests were copied in. The run directory was not the candidate checkout, and it was removed afterwards.

**Proof.** `test/evaluator-isolation.test.ts` under Git Bash: tamper-gate suite passed, including the hidden-test case. `test/eval-gates.test.ts` suites passed (`ok 7` through `ok 11`).

**Fix.** None.

**Final status.** Held. Not P0.

### Evaluator-config tampering

**Expected invariant.** `evaluation_config_sha256` is the digest of the commands, test globs, hidden tests, and evaluator. Changing the hidden tests changes the digest. Runner-configuration edits are tampering, distinct from ordinary source edits.

**Actual result.** Held.

**Proof.** `ok 5 - evaluate-candidate.ts: the bundle commits to the evaluation configuration` and the eval-gates tamper suite, same runs as above.

**Fix.** None.

**Final status.** Held. Not P0.

### Candidate SHA swap

**Expected invariant.** Evidence for a SHA that is not the contender's latest observed commit is rejected. Replacing evidence after labels is rejected. Promoting a tree that is not the reviewed tree is `TREE_MISMATCH`, and the permit is not consumed.

**Actual result.** Held in the suites that ran.

**Proof.** `ok 19 - evidence binding: latest observed commit, no replacement after labels`. `ok 22 - promotion attacks` (includes the commit-swap case). `ok 9` of the promotion fixtures: tree digest mismatch, bash and the model, exit 43.

**Fix.** None.

**Final status.** Held. Not P0.

### Evidence replacement

**Expected invariant.** A second bundle for a SHA after candidate labels exist is rejected and the stored bundle stays. The seam recomputes `bundle_hash`.

**Actual result.** Held.

**Proof.** `ok 18 - tamper quarantine` and `ok 19 - evidence binding` in `test/evidence-auth.test.ts`. `ok 29 - eligibility` includes the hash mismatch case.

**Fix.** None.

**Final status.** Held. Not P0.

### Attacker-generated signing key

**Expected invariant.** A bundle signed by a key the attacker just generated does not verify. The pinned public key is what decides. An embedded key that differs from the pinned key fails even when the signatures match that embedded key.

**Actual result.** Suite passed.

**Proof.** `ok 20 - forged promotion bundles` (`test/forged-bundle.test.ts`, real `src/cli/verify.ts`).

**Fix.** None.

**Final status.** Held. Not P0. See Mission 3.

### Permit replay

**Expected invariant.** Issuing the same permit twice converges on one record. Presenting a consumed permit again is `ALREADY_CONSUMED` and emits no effects.

**Actual result.** Suite passed.

**Proof.** `ok 22 - promotion attacks`.

**Fix.** None.

**Final status.** Held. Not P0.

### Stale HEAD

**Expected invariant.** A permit bound to an old destination head is `EXPIRED_HEAD_MOVED` or `REBASE_REQUIRED`. The same SHA is not promoted on the moved head. A rebased SHA is a new candidate and needs a new evaluation.

**Actual result.** Held. The container fixture also refused a missing ancestor with `BASELINE_MISMATCH` (exit 47) for bash and the model.

**Proof.** `ok 21 - head-move: rebase-vs-reverify end to end`. `ok 24 - issuePermit: a permit only at a head the candidate is known to descend from`. `ok 27 - the destination moved after the candidate was reviewed`. Promotion fixture cases for `EXPIRED_HEAD_MOVED` and `BASELINE_MISMATCH` passed on bash.

**Fix.** None.

**Final status.** Held. Not P0.

### Quarantine bypass

**Expected invariant.** Evidence that names changed evaluation files quarantines the contender and revokes its fork tokens. A quarantined contender is excluded from selection. Promotion returns `QUARANTINED_CANDIDATE`. An operator review needs a registered key and is single-shot.

**Actual result.** Held in the local fakes.

**Proof.** `ok 4 - tamper quarantine at the evidence route`. `ok 18 - tamper quarantine`. `ok 23 - quarantine review — signature enforcement`.

**Fix.** None.

**Final status.** Held locally. Not tested against a live Artifacts credential. Not P0.

### Direct canonical write

**Expected invariant.** A contender's fork write token cannot push the canonical repo. `executeEffects` does not perform `canonical_write`.

**Actual result.** The contender token push to canonical was rejected `TOKEN_NOT_FOUND`. The evaluator read token's write was `SCOPE_DENIED`. `listTokens` did not leak plaintext. Revoked tokens were dead.

**Proof.** `ok 33 - white-box test-secrecy boundary` (`test/whitebox-boundary.test.ts`). This pass did not add a separate call that prints the `executeEffects` warning. That branch is still a log-and-skip in `src/worker/index.ts`. The push attempt that ran is the white-box test.

**Fix.** None.

**Final status.** Held on the fake token port. Live Artifacts token scope was not observed. Not P0.

### Unrecorded conflict submission

Covered by Mission 1. Stated attack closed. P1 remains for an omitted or empty scan field.

### Old evidence after rebase

**Expected invariant.** A rebased SHA is not authorized by the pre-rebase bundle. The seam hash does not match. A contributing SHA after `RESOLVED` is refused. The evaluator compares the candidate with the recorded rebase head, not blindly with the original baseline.

**Actual result.** Held.

**Proof.** `test/composition-authority.test.ts` suite passed (`ok 1`), including the resolved-SHA case whose reasons match `evaluation_bundle_hash mismatch`. `ok 3 - evaluate-candidate.ts: a rebased candidate is compared with the head it was rebased onto`. `ok 26 - evaluation base` in `test/rebase-ancestry.test.ts`.

**Fix.** None.

**Final status.** Held. Not P0. A different SHA still needs a new evaluation. See Mission 4.

## Mission 3 — trusted key

**Expected invariant.** The authority signs. Offline verify accepts the pinned public key. A key carried inside the bundle cannot establish trust.

**Actual result.** The forged-bundle suite passed. It runs `src/cli/verify.ts` against a fresh attacker key and against a bundle whose embedded key differs from the pinned key.

**Proof.** `ok 20 - forged promotion bundles`.

**Fix.** None this pass.

**Final status.** Held locally. `keys/authority.pub` on a live account was not checked. Not P0.

## Mission 4 — exact state

**Expected invariant.** The permit binds `task_hash`, baseline, `winning_tree_sha256`, `evaluation_bundle_hash`, selector policy hash, and `expected_destination_head`. A different SHA or a different tree requires a new evaluation. Re-evaluation supersedes the old permit (`EVAL_BUNDLE_MISMATCH`).

**Actual result.** Held in the promotion-attack, head-move, evidence-binding, and composition suites above. The container refuses a digest that is not the permit's (`TREE_MISMATCH`, exit 43) even when the commit SHA is the one named. Marker bytes are refused before that comparison, so a matching digest does not fast-forward a conflicted tree.

**Proof.** The suite names in Mission 2, plus the two new promotion fixture cases.

**Fix.** The marker scan is an additional refusal on the same SHA. It does not loosen the SHA binding.

**Final status.** Held for the cases that ran. Not P0.

## Limits of this pass

- Not run on Cloudflare. Not run against a live Queue or a live Artifacts token service.
- Node v22.17.0. `live-e2e.ts`'s own spawn of `evaluate-candidate.ts` did not load.
- Git Bash injects the MSYS variables listed above. Linux bash was not the runner for `test/env-isolation.test.ts`.
- The git argv shim in `test/env-isolation.test.ts` recorded 0 invocations (`0 !== 5`). Git for Windows finds `git.exe` before an extensionless `git` script. Whether the bearer token sits only in the environment was not measured on this host.
- The rebase fixture path `weird\nname.txt` is missing from Git Bash's conflict list. The model still reports it.
- `tsc` was not run. `node_modules` is not installed in this tree.
- Marker text that a project intentionally contains is refused. That is fail-closed on the pattern, not a judgment that the document is a bad merge.
