# MADGRIX final hostile audit

Audited ref: `origin/competition/final`

Audited SHA: `44fd44ecc43a4daf452678b5378ae98f25ed9449`

`git fetch origin competition/final` on 2026-10-06 resolved that branch to this SHA. `HEAD` was the same commit. The working tree was clean before this file was added. No code was changed. Nothing was deployed, merged, or created in Cloudflare.

This audit found local P0 and P1 failures. The green suite below does not remove them. Those failures were reproduced by a separate in-process probe, and the existing tests do not cover them.

This document does not say the tree is secure, production ready, or fully verified.

## How the tree was executed

Windows `git archive` with `core.autocrlf=true` rewrote LF blobs to CRLF. That copy is not the commit. `git cat-file -s` on this SHA says `container/promote.sh` is 7330 bytes. The autocrlf archive was 7525 bytes and `bash -n` failed with `pipefail\r`. A second archive, `git -c core.autocrlf=false -c core.eol=lf archive`, matched the blob sizes. Its seven frozen spec hashes matched `specs/FROZEN.json`. Every count below is from that archive.

Linux run: WSL2, Node v24.21.0 at `/home/gathu/node24/bin/node`, `MADGRIX_FLEET_BIN` unset, `npm ci` in the extract, then:

- `npm run typecheck` (`tsc --noEmit` and `tsc --noEmit -p tsconfig.node.json`)
- `npm test` (`node --test "test/**/*.test.ts"`)
- `npm run slice`
- `npm run headmove`
- `npm run bench`

The protocol probe was a temporary Node script run with that same Node against the extract. It called `buildWorkGraph`, `renderWorkGraphPage`, `recordComposition`, `submitEvaluation`, `runVerdictSeam`, `issuePermit`, `attemptPromotion`, `ingestQueueEvent`, `quarantineContender`, `reviewQuarantine`, `enrollAgents`, and `registerClaim`. It is not part of this commit. `attemptPromotion` returns an in-memory `canonical_write` effect. It does not run `container/promote.sh` and it does not push to a git remote.

`npm run build` was run from a second LF extract on Windows, Node v24.21.0, Docker Desktop 29.8.2. It produced a local image. It was not pushed and not deployed.

## Commands and counts

| Command | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm test` | 331 tests, 102 suites, 331 pass, 0 fail, 0 cancelled, 0 skipped, 0 todo, `duration_ms` 13192.454904 |
| `npm run slice` | `SLICE OK`. Its own offline verifier printed `VERIFIED` for the slice bundle and pinned key |
| `npm run headmove` | `HEAD-MOVE OK` |
| `npm run bench` | exit 0, `zero_tolerance_ok: true` |
| `npm run build` | exit 0. Vite wrote `.cloudflare/output/v0/workers/default/bundle/index.js` (229.27 kB). Docker tagged `docker.io/cloudflare-build/371de08cd2dc/madgrix-promotion:05e619fceeb9`. Dockerfile `COPY` steps were cache hits. `bash -n` on `/opt/madgrix/promote.sh` and `/opt/madgrix/rebase.sh` inside that image succeeded. The image shebang is LF (`0a`, not `0d 0a`) |

Suites inside the 331 that cover the areas in this audit, all passing on this run: composition authority, composition route, contender binding, demo composition fixture, process environment boundaries, evaluate-candidate, evidence binding, competition fleet manifest, fork crew, promotion attacks, promotion fixtures (`container scripts and the TS model agree on the shared fixture table`), PromotionContainer real scripts, quarantine review, rebase ancestry, unresolved merge-artifact scan, work graph page, white-box token scope, forged bundles, worker authority path.

Passing tests are not evidence that the probes below were considered. The composition-authority suite passed, and the candidate-binding probe still promoted a different SHA from the one `buildWorkGraph` named.

## P0

These are local authority results. They are not Cloudflare observations. They are wrong canonical state in the function that records promotion.

### P0-1. A crew task can promote a SHA that is not the recorded candidate

`compositionBlocks` in `src/lib/task-state.ts` returns true for a non-promotable composition, and otherwise only when the SHA is not `candidate_sha` and is listed in `contributing_shas`. A SHA that is neither the recorded candidate nor a contributing SHA is not blocked. `normalizeComposition` rejects a candidate that appears in `contributing_shas`. It does not reject a candidate that equals an agent `sha` when that SHA is left out of `contributing_shas`.

`buildWorkGraph` hides that member SHA. `candidateSha` returns null when the recorded SHA is a member SHA. `handleWorkGraph` builds one graph and either returns it as JSON or passes that object to `renderWorkGraphPage`.

Executed on this SHA:

- Record `COMPOSED` with `candidate_sha` equal to member `side-a-sha`, and with `contributing_shas` of `other-1` and `other-2`. The record is accepted. JSON candidate is null. HTML plate is `NONE`. Stamp is `COMPOSED`. Verdict is `ACCEPT` for `side-a-sha`. `issuePermit` returns `ISSUED`. `attemptPromotion` returns `PROMOTED`, consumes the permit, and emits `canonical_write` of commit `side-a-sha` on repo `acme/api`.
- Accept `old-sha`, then record `COMPOSED` with candidate `composed-sha`. The graph candidate is `composed-sha`. `issuePermit` of `old-sha` returns `ISSUED`. `attemptPromotion` returns `PROMOTED` with canonical commit `old-sha`.
- Accept `old-sha`, move `latest_commit` to `empty-republish-sha`, and record that SHA as the `COMPOSED` candidate. Submitting the old bundle again is rejected because it is not the latest observed commit. `issuePermit` of `old-sha` still returns `ISSUED` for `old-sha`. The same gate that promoted `old-sha` in the previous probe is the gate that issued this permit. This probe stopped at the permit.

`runPromotion` uses the same `compositionBlocks` check before it mints a destination write token. That route was not executed in the probe. The check it calls is the one that returned false in the probe.

Control-plane callers are the ones that record composition, issue permits, and promote. This is not an unauthenticated agent write. It is the authority accepting a canonical commit other than the SHA the work graph shows.

### P0-2. `REVOKED` does not stop promotion, and evidence submitted during quarantine can become that commit

`attemptPromotion` treats only `quarantine.status === "QUARANTINED"` as `QUARANTINED_CANDIDATE`. `REVOKED` falls through. `runVerdictSeam` drops only `QUARANTINED` contenders. `issuePermit` does not read the quarantine record. `submitEvaluation` stores a bundle while the contender is `QUARANTINED` and does not set `tainted` on that new bundle. `quarantineContender` sets `tainted: true` on bundles that already exist, without recomputing `bundle_hash`. Eligibility then fails the old bundle with `evaluation_bundle_hash mismatch`. `attemptPromotion` compares the stored `bundle_hash` field with the permit and does not recompute it.

Executed on this SHA:

- After an `ACCEPT` and an issued permit, quarantine makes a new seam `REJECT`. `issuePermit` on the still-`ACCEPT` pre-seam state returns `ISSUED` while status is `QUARANTINED`. `attemptPromotion` of the original permit returns `QUARANTINED_CANDIDATE` and does not consume it.
- The same original permit after `reviewQuarantine(..., "REVOKED", ...)` returns `PROMOTED` and `canonical_write`. The new seam on the tainted old bundle is `REJECT`. The permit still matches the stored hash field.
- A new bundle for `empty-republish-sha` submitted while status is `QUARANTINED` is `RECORDED` with `tainted: false`. After `REVOKED`, that flag is still false. `runVerdictSeam` returns `ACCEPT` for `empty-republish-sha`. `issuePermit` returns `ISSUED`. `attemptPromotion` returns `PROMOTED` with commit `empty-republish-sha`.

`runPromotion` checks `QUARANTINED` and does not check `REVOKED` before minting source and destination tokens (`src/worker/index.ts`). That HTTP path was not driven in the probe. The finalize function was.

`reviewQuarantine` says a quarantined candidate state can never be promoted and that salvage is a new SHA. The executed `REVOKED` path promotes.

## P1

### P1-1. A later-delivered older push rewinds `latest_commit`

The comment on `ingestQueueEvent` says out-of-order delivery for a known repo is absorbed because `latest_commit` becomes the newest observed tip. The function does not compare `before` with the current tip. For a known fork it sets `latest_commit` to `event.after`.

Executed in process, not on Cloudflare Queue:

- Apply `before=old-sha`, `after=empty-republish-sha`. `latest_commit` is `empty-republish-sha`, outcome `APPLIED_NEW`.
- Apply a different event `before=base123`, `after=old-sha`. Outcome is `APPLIED_NEW`. `latest_commit` becomes `old-sha`.
- Applying that second event again returns `ACK_DUP`, and the state object is unchanged.
- An unknown repo returns `REJECTED_OUT_OF_ORDER` and does not change `latest_commit`. The name does not mean a reorder was detected.

`submitEvaluation` refuses a candidate that is not `latest_commit`. A rewind changes which SHA that check accepts. This was not run against Cloudflare Queue.

### P1-2. `RELEASED` reuses the pre-quarantine permit

The same original permit, after an operator `RELEASED` determination with a passing recheck, returns `PROMOTED` and `canonical_write`. `tainted` on the old bundle is cleared. This needs a registered operator signature. It is not an agent bypass. It contradicts the salvage sentence in `reviewQuarantine`: the candidate that was quarantined is promoted without a new SHA.

## P2

- `scripts/lib/fork-crew.mjs` `threeWayMerge` calls `git merge-file` with no `env`. The probe's source slice of that function has no `env:` binding. A runner that holds `AGENT_SERVICE_TOKEN` or `MADGRIX_AGENT_SECRETS` in its own environment gives that environment to `git merge-file`. Agent, resolver, and evaluator children built with `minimalEnv` do not. This was not a `/proc` read of a live `git` process.
- `blobHasConflictMarkers` returns false for `<<<<<<<\0\n>>>>>>>\n` and for `\0<<<<<<< HEAD\n>>>>>>>\n`. On the LF `container/promote.sh`, both blobs exit 48 `UNRESOLVED_CONFLICT` and leave destination `HEAD` unchanged. The container is stricter than the TypeScript model. The shared fixture table does not include these bytes. The model is what `npm run slice` and `npm run headmove` promote through. The real script is what the container runs. No probe in this audit found the script accepting a marker blob the TypeScript scanner rejected.
- A blob path `src/a\nb.js` that contains ordinary markers also exits 48 with destination `HEAD` unchanged. The script's `PATHS` line is `b.js,src/a` because the path's newline is joined as a line break. The refusal still happens.
- For `PENDING`, `COMPOSING`, and a hidden member SHA, the plate and the stamp follow `buildWorkGraph`. `resolutionSection` prints `Resolution state: unresolved.` when `promotableSha` is null and the stored SHA is not a hidden member SHA (`src/worker/work-graph-page.ts`). That sentence was read from the renderer. The probe captured the plate and the stamp, not that sentence. It can sit under a stamp of `PENDING`.
- `authorizationSection` can print a stored permit winner next to a plate of `NONE`, with a sentence that the permit names a different SHA. That display was not rendered for the P0 states. It does not stop the write.
- `docs/DEMO_SCRIPT.md` says to narrate 300 tests, 93 suites, and that `npm test` needs `fleet`. This run is 331 tests, 102 suites, with `MADGRIX_FLEET_BIN` unset.
- `scripts/run-fork-crew.mjs` says the parent calls `fleet validate`. `assertFleetRoster` calls `fleet` only when `MADGRIX_FLEET_BIN` is a non-empty string.
- `docs/GIT_PROBLEMS.md` still says TheUstad is not wired. `verifyFrozenBaseline` is wired, and it is narrower than a candidate verifier. See the claim section.
- `docs/PRODUCTION_DEPLOYMENT.md` pass criteria say "exactly-once effect" for a duplicate delivery. `docs/DEVELOPMENT_LOG.md` says at-least-once, unordered, with `event_key` dedupe. The executed duplicate is `ACK_DUP`. That is dedupe of one identical event, not a delivery guarantee, and it was not observed on Cloudflare Queue.
- `README.md` says "The production path now includes" real Artifacts, the container, and `npm run live:e2e`. The next section says only what the runs printed has been validated. `live:e2e` was not run in this audit.
- `docs/SECURITY_BOUNDARIES.md` says no unresolved P0 was observed in an earlier local suite. That sentence is not this audit.
- `docs/ENTRY_BLUEPRINT.md` still describes an `ExternalVerifier` slot where TheUstad might plug in. The code that runs is the baseline check below.
- `ingestQueueEvent` names an unknown repo `REJECTED_OUT_OF_ORDER`.
- A freshly hashed bundle that copies an older bundle's gate booleans onto `resolved-sha` is `ACCEPT`. An unmodified old bundle, hash not recomputed, is `REJECT` with `evaluation_bundle_hash mismatch`. The authority does not remeasure the tree. The evaluation zone is trusted for those booleans.

## Claims falsified

- Only `COMPOSED` and `RESOLVED` expose a promotable SHA, and a member SHA cannot be that candidate. The graph and the HTML plate do that. `recordComposition`, `issuePermit`, and `attemptPromotion` do not, when the member SHA is omitted from `contributing_shas`.
- A contributing SHA, a `CONFLICTED` composition, and an old bundle reused byte for byte on a new SHA fail closed. Those three did. A different previously accepted SHA that is not listed as contributing does not.
- `REVOKED` ends the candidate. An existing permit is consumed and a `canonical_write` effect is returned. Evidence submitted during `QUARANTINED` can be accepted, permitted, and promoted after `REVOKED`.
- `latest_commit` is the newest observed push. A second event with a different `event_key` can replace it with an older `after`.
- `docs/DEMO_SCRIPT.md` fleet requirement and 300/93 count, for this SHA, with `MADGRIX_FLEET_BIN` unset.
- `docs/SECURITY_BOUNDARIES.md` "no unresolved P0" as a description of this tree.
- Any reading of TheUstad as semantic verification of the composed or resolved tree. `scripts/theustad-baseline-check.py` exits 0 only when `HEAD` equals the expected baseline and `git status --porcelain` is empty. `verifyFrozenBaseline` runs that before combine and accepts only exit 0 and `FINAL VERIFIED`.

## Claims upheld on this SHA

Upheld means the probe or the Linux suite showed it. It does not mean a Cloudflare deployment showed it.

- JSON and HTML plates agree for `PENDING`, `COMPOSING`, `COMPOSED`, `CONFLICTED`, `RESOLVING`, and `RESOLVED` when both are built from `buildWorkGraph`. A second render that rebuilds the graph produced the same plate. `handleWorkGraph` builds one graph, returns it for `format=json` or `Accept: application/json`, and passes that object to the HTML renderer. The plate does not pick a different candidate, composition state, or crew. Later sections print stored verdicts, permits, and bundles.
- `PENDING`, `COMPOSING`, `CONFLICTED`, and `RESOLVING` record no candidate. Putting a candidate on those states throws. A contributing SHA as the `RESOLVED` candidate throws `the candidate SHA must be new, not a contributing SHA`.
- `CONFLICTED` rejects a new evaluation of the member SHA, `issuePermit` returns `UNRESOLVED_CONFLICT`, and `attemptPromotion` of a permit issued before the conflict returns `UNRESOLVED_CONFLICT` with the permit unconsumed and no effects. The graph candidate is null.
- A contributing SHA cannot be submitted or permitted as the `RESOLVED` candidate. The errors are the contributing-SHA evaluation rejection and `UNRESOLVED_CONFLICT`.
- Submitting SHA `old-sha` while `latest_commit` is a different SHA is rejected.
- Malformed `merge_artifact_scan` values are stored when the bundle hash matches, then they are ineligible and `issuePermit` returns `UNRESOLVED_CONFLICT`: missing, null, wrong type, status not `COMPLETE`, unknown scanner, candidate mismatch, tree mismatch, `paths` string, `paths` null, `paths` containing `""`, legacy list disagreement, and a non-empty path list. None of these received a permit.
- `COMPLETE` with `paths: []` is eligible. `issuePermit` returns `ISSUED`. `attemptPromotion` returns `PROMOTED` and `canonical_write` without reading blobs. That is not "blocked before permit." The container is the other half. On LF `promote.sh`, an ordinary marker blob exits 48 `UNRESOLVED_CONFLICT` and does not move destination `HEAD`. The fixture suite, which passed, includes unresolved markers refused before fast-forward, a conflicted tree already on the destination not treated as `ALREADY_WRITTEN`, tree mismatch, head movement, and baseline mismatch. The permit is not consumed by the script. Consumption is the authority finalize, which the worker skips on container 409.
- Tree mismatch, destination head movement, permit replay, and a bundle replaced after the permit: `TREE_MISMATCH` unconsumed, `EXPIRED_HEAD_MOVED` unconsumed, first success `PROMOTED`, replay `ALREADY_CONSUMED`, replacement `EVAL_BUNDLE_MISMATCH` unconsumed. These are authority results. The fixture suite passed the matching container cases.
- While status is `QUARANTINED`, the seam does not select the contender and `attemptPromotion` does not consume the permit.
- Enrolled agent A cannot claim as B. Missing secret, B's secret on A's claim, and an unenrolled agent are rejected. No secret is minted. `issueContenderCredentials` on FakeArtifacts mints `write` on the fork it is given. That token writes `fork-a` and is `TOKEN_NOT_FOUND` on `fork-b` and on `canonical`. `issueEvaluatorCredentials` mints `read`. That token reads `fork-a`, cannot write `fork-a` (`SCOPE_DENIED`), and cannot read or write `canonical`. `verifierCredentials()` is null. The same pattern passed in `white-box test-secrecy boundary` and `contender binding`.
- Child environments. With control, evaluation, and agent tokens set on the parent, `minimalEnv` for an agent, a resolver, and an evaluator contained none of those names. A spawned `node -e` under the agent env printed `HOME,LANG,MADGRIX_AGENT_ID,MADGRIX_AGENT_ROLE,MADGRIX_SCOPE_PATHS,MADGRIX_SUBAGENT_INTENT,PATH,TERM`. `parseAgentEnvAllowlist("CONTROL_SERVICE_TOKEN,HOME")` throws. `gitAuthEnv("fork-read-token")` puts the fork token in `GIT_CONFIG_VALUE_0` and does not put the service tokens in the environment. `scripts/demo-resolve.mjs` exits 1 with `resolver refuses to run with a service credential in its environment`. `scripts/evaluate-candidate.ts` spawns git and evaluation commands with `minimalEnv()` only. The evaluator's own service token stays on the parent.
- Default demo roster. `assertFleetRoster` on `configs/demo-composition.json` and `configs/git4agents-demo-composition.yaml`, with an empty env object, returns `parent`, `sub-api`, `sub-ui`, `sub-test` and does not start fleet. `npm test` passed with `MADGRIX_FLEET_BIN` unset. `docs/VIDEO_DEMO_SCRIPT.md` says Agentfleet does not run the sub-agents and that this picture was not a Cloudflare run. Those sentences match the code that was executed. `scripts/lib/agentfleet-slots.mjs` still defaults the sibling contender swarm to `fleet` on `PATH` unless `MADGRIX_AGENT_IDS` is set. That path was not required by this suite.
- Duplicate identical queue events are `ACK_DUP`. PromotionWorkflow retries are declared as limit 5, exponential from 10 seconds, timeout 2 minutes, and the step throws only for status >= 500. 409 is returned as the step result. That retry policy was read from `src/worker/index.ts` and covered by the passing workflow tests with fakes. It was not observed on Cloudflare Workflows.
- Security and collaboration are in the same authority: composition states and the merge-artifact admission check both run inside `issuePermit` and `attemptPromotion`. A successful history of cherry-picks was not used as evidence. The scan attacks and the composition attacks were both executed on this SHA. The scan gate holds. The composition candidate gate does not.

## Cloudflare-unverified

Not run, and not claimed from any earlier report:

- Cloudflare Workers, Queue, Workflows, Durable Objects, Artifacts, and Containers for this SHA
- `npm run live:e2e`
- Live repo scope of Artifacts tokens. The scope results above are `FakeArtifacts`
- Live queue order. The rewind is the in-process function
- A real git push under `runPromotion` for the P0 SHAs. The container suite and the extra `promote.sh` probes used local bare repositories
- The local image was not deployed. Cache hits on `COPY` mean this build did not re-execute those layers

`docs/VIDEO_DEMO_SCRIPT.md` already says the recording is not a Cloudflare run. That part was not falsified.

## Fixes before any deployment

1. When a composition record exists, `issuePermit` and `attemptPromotion` must allow only `composition.candidate_sha`, and only when status is `COMPOSED` or `RESOLVED`. `normalizeComposition` must reject a candidate that equals any agent `sha`, including when that SHA is absent from `contributing_shas`.
2. `QUARANTINED` and `REVOKED` must both block `runVerdictSeam` selection, `issuePermit`, `attemptPromotion`, and `runPromotion`. `submitEvaluation` during either status must be rejected or stored so that it cannot become eligible. A permit that existed before quarantine must not be consumable after `REVOKED`.
3. Decide the `RELEASED` rule in code. Either invalidate outstanding permits and require a new SHA, or change the salvage comment if reuse is the intended false-positive path. Do not describe both.
4. `ingestQueueEvent` must not replace `latest_commit` with an older `after`. Re-test that on a real queue before describing delivery. The local `ACK_DUP` result is not that test.
5. Keep the container scan. Do not treat `COMPLETE` plus `paths: []` as a blob reading. The authority permits it. `promote.sh` is what refused the marker trees in this audit.
6. Do not deploy this SHA to close the competition on the current authority. Repeat the two P0 probes after the gate changes. Update `docs/DEMO_SCRIPT.md` and `docs/SECURITY_BOUNDARIES.md` so they do not narrate the old count, a required fleet binary, or the absence of a P0.

## Evidence boundary

| Item | What was executed |
|---|---|
| Work-graph plate vs JSON | In-process `buildWorkGraph` and `renderWorkGraphPage` for all six states |
| Candidate binding, quarantine, queue, scan gates, exact-state permit | In-process authority. `canonical_write` is the returned effect |
| Token scope | `FakeArtifacts` |
| Child env | `minimalEnv`, `gitAuthEnv`, one spawned `node -e`, `demo-resolve.mjs` |
| `promote.sh` vs `src/lib/git-promotion.ts` | Passing fixture suite on Linux, plus four extra local git cases |
| Fleet | `assertFleetRoster` with no binary, and `npm test` with `MADGRIX_FLEET_BIN` unset |
| Build | Local Vite bundle and local Docker image. Not deployed |
