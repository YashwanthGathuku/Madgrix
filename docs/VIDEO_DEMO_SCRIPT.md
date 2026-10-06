# Video demo script (~7 minutes)

Spoken walkthrough for Cloudflare judges. The picture is one task page, `GET /tasks/:id/graph`, plus the local slice harness for the half of the loop this fixture does not run.

Say the lines in quotes. Do not improvise hashes, gate results, or a verdict. If a command fails, play the backup recording. Do not deploy during the recording.

## Before you record

Run these and keep the output. They are the local proof, not a Cloudflare run. On Windows, if `python3` is the Store stub, set `MADGRIX_PYTHON=python` first. `scripts/render-demo-graph.mjs` picks a working interpreter itself. Node 22 needs `NODE_OPTIONS=--experimental-strip-types`.

```
node --test test/demo-composition.test.ts test/work-graph-page.test.ts test/composition-authority.test.ts
node scripts/render-demo-graph.mjs
npm run slice
```

`render-demo-graph.mjs` prints two HTML files. Open both in a browser. Leave them scrolled to the top. The banner on each page says **Fixture/demo input**. That banner is not added by the live route.

`npm run slice` is a different task (`isTokenExpired`). It is not the contract fixture. Do not paste its SHAs into the graph, and do not tell a judge they are the same run.

Terminal font large. Browser at a width where the page is one column. No network tab theater. No animation.

## What you must not claim

- This branch was exercised on Cloudflare. It was not.
- The page classified a pair. It prints `conflict_reports` stored by the authority. With no dependency map, `registerClaim` stores **AMBER**, including for the test agent. It does not store GREEN. GREEN is what the classifier stores when dependency analysis ran and the layers are empty. RED is a shared symbol or contract. BLOCKED is shared state.
- That the line collision is the claim-graph color RED. The combine step stores `textual-line-overlap`. While the record is CONFLICTED, there is no candidate SHA.
- The resolver SHA is one of the three contributing SHAs. The page says **New candidate** only when the stored candidate is not in `contributing_shas`.
- A section that says "not recorded" or "No evaluation bundle is stored" is a pass that has not happened. Do not fill it.
- The graph verified a bundle. It says **Offline verification: not executed in this view.** The check is `npm run verify` with an out-of-band trust key. A key named inside the bundle is not that check.
- The live runner accepts `configs/demo-composition.json`. `configs/git4agents-fork-crew.yaml` lists `parent`, `sub-api`, and `sub-ui` only. `fleet validate` rejects this demo until a manifest lists `sub-test` in that roster. The HTML is local git.

## Why Artifacts is the point

Human git gives a fleet one working tree and one credential. Artifacts gives the control plane a repository per contender, a fork or a baseline copy, and a push onto Queue. The TaskAuthority Durable Object records claims, composition, evidence, the verdict, and the permit. It does not fast-forward the canonical repository. That write is the promotion container, one Workflow instance per permit, and the shipped commit is the reviewed SHA. The graph is that record. The offline verifier checks the signed bundle without calling the Worker.

The fixture below uses local git so the recording does not depend on a deploy. The worker route renders the same function against the Durable Object.

---

## 0:00 — Problem

Screen: the resolved graph, banner visible, not scrolled.

> "Agents already write code in parallel. What they cannot do is share one git checkout and one push credential and still tell you which commit was reviewed. MADGRIX is the record between those agents and the canonical repository. One task. The intent is frozen. Everything under it is state the authority stored, or it is absent. The page does not invent it."

Point at the banner, then the intent.

> "This file says fixture, demo input, local git. It is not a Cloudflare call. The same page is what `GET /tasks/:id/graph` returns for a live task."

## 0:45 — Why human Git breaks for agent fleets

Stay on the task header. Do not open a diagram with fake boxes.

> "A person resolves a merge by editing the conflict markers and committing. That commit has one author. In a fleet, the API agent and the UI agent both wrote `src/contract.js`, on purpose, at the same time. The integration agent wrote a different path. If those three share a working tree, the last writer wins and the overlap becomes an ordinary commit. If they share a credential that can push main, the test agent can ship."

> "Artifacts is the split. The parent holds one fork. Sub-agents do not get a canonical credential. Their commits are real git SHAs. Pushes arrive on Queue, at least once, and the Durable Object dedupes them. The canonical repository is a different Artifact. Nothing on this page is allowed to move it."

## 1:15 — Live work graph

Scroll to **Live work graph**. Read the key, then one edge.

> "These colors are stored conflict reports. The page does not classify. GREEN means the authority's classifier found no conflict on the layers it had. AMBER means a shared dependency, or dependency analysis was not available, or a claim was amended. RED means a shared symbol or a shared contract. BLOCKED means shared state."

Point at an AMBER line. Read the explanation that says dependency analysis was unavailable, and, on the API/UI pair, the path overlap.

> "There is no dependency map on this fixture, so the authority will not store GREEN. Missing analysis is not a clean pair. The test agent is AMBER for that reason. It is not a green badge we painted because its files look separate."

## 2:00 — Concurrent crew

Scroll to **Crew**.

> "Four rows, from the record. Parent is the fork holder. API agent, UI agent, test and integration agent. Each row is an intent, a scope, a status, and a commit. The three sub-agent intents are the ones the composition record stored. The parent row's intent says not recorded when the claim did not carry a separate sentence. We do not copy the crew file in to fill that gap."

> "The three commands ran in separate git worktrees of that one fork, overlapping in time. The test agent's scope is `test/integration/**`. It does not receive the control token or the evaluation token. Its commit is its own SHA."

Point at the three side commits. Do not read them aloud.

## 3:00 — Conflict

Switch to the conflicted HTML. Stamp **CONFLICTED**. Scroll to the overlap.

> "Both the API agent and the UI agent wrote `src/contract.js`. The combine step stored the classification textual-line-overlap. That is not the claim-graph color. It is the file the merger refused to hide inside a commit."

Point at the two sides: agent, intent, contributing SHA, excerpt.

> "Resolution state: unresolved. Candidate: none. HEAD stayed on the baseline. There is no candidate to evaluate, permit, or promote. A contributing SHA cannot stand in for one."

## 3:45 — Resolution

Switch to the resolved HTML. **Resolution**.

> "A resolver got the baseline, the conflict file, and each side. It did not get a service token. It wrote one new commit: the API file, the UI file, the integration check, and a contract both sides can live with. That SHA is not any of the three contributing SHAs. The page says new candidate because that is what the record shows. It is not a rename of an old side. It still needs its own evaluation, its own verdict, and its own permit."

Point at the arrow. Contributing SHAs on the left, the new candidate on the right.

## 4:20 — Independent evaluation

Stay on the resolved page. **Evaluation**.

> "No evaluation bundle is stored. The fixture did not run the tests, and the page does not invent a pass. The gates, when a bundle exists, are the admission record: baseline, scope, evaluation integrity, hidden oracle and regressions, security, provenance and tool state and static analysis. Failed test names are not printed here. The agent bearer can open this route, and the hidden suite is not part of the view."

Cut to the slice terminal. Start it before the recording if you need the clock.

```
npm run slice
```

> "This is a different task, the token-expiry slice, so you can see the rest of the loop on a run that actually evaluates. The evaluator is a separate domain. It does not hold the canonical write. A candidate that touches the tests or the runner config is quarantined. The composition candidate you just saw is not this slice, and it is not promoted in this video."

Let the harness reach the evaluation and verdict lines. Read the words ACCEPT, QUARANTINE, or REJECT that it prints. Do not read hashes.

## 5:10 — Exact-state authorization

Slice still running, or paused on the permit lines.

> "On ACCEPT, the authority issues one permit. It binds the candidate SHA, the baseline, the tree digest, the evaluation bundle hash, the policy, and the destination head. If the destination has moved, there is no permit until the candidate is rebased, and the rebase is a new SHA that must be evaluated again. Presenting a contributing SHA, or an old bundle hash, does not authorize the new candidate."

> "On the graph, that block is candidate SHA, destination head, and permit status: issued, or consumed. This fixture's page says no permit is recorded. That is the truth for this file."

## 5:50 — Canonical promotion

Slice promotion lines.

> "Promotion is a Workflow whose instance id is the permit id. The container is the only canonical writer. It fast-forwards the destination Artifact from the permit's head to the reviewed commit. It does not create a new commit. The authorized SHA and the promoted SHA are the same SHA, and the canonical destination is that repository. A second presentation is already consumed. A CONFLICTED composition never gets this write."

## 6:20 — Offline verification

When the slice prints VERIFIED, run the verifier on the bundle it wrote. Use the trust key the slice just wrote, not a key copied out of the bundle.

```
npm run verify -- --trust-key .slice-output/authority.pub .slice-output/promotion.bundle
```

> "The graph named a bundle if one was stored, counted signature fields, and showed a prefix of the key label. It did not say verified. This command does. The trust key is the one you pin out of band. The key inside the bundle has to match it, and every signature is checked with the key you passed. No network. Subject, candidate, chain, hidden evaluation, policy, destination base, authority key, signature, permit id, ledger. The last line is VERIFIED, or it is not."

If you have time, flip one signature character and show NOT VERIFIED. Skip it rather than rush.

## 6:50 — Closing

Back to the resolved graph, top of the page, banner still visible.

> "Agents produce commits. Artifacts holds the forks and the canonical repository. The Durable Object holds the intent, the crew, the conflict, the new candidate, the gates, the verdict, and the permit. The container is the only thing that moves the destination, and only to the SHA the permit names. Anyone with the bundle and the pinned key can check that offline."

> "What you saw in the browser is local fixture state. The live fleet manifest on this branch does not yet list the test agent, so the deployed runner would reject this crew config. The architecture does not depend on hiding that. Forks are commodity. The part Artifacts makes possible is a fleet of real repositories whose canonical branch moves only by a checked, single-use, exact-state promotion."

Stop. Do not add a metric, a timeline, or a second product name.
