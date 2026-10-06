# Video demo script (~7 minutes)

Spoken walkthrough for Cloudflare judges. The picture is one task page, `GET /tasks/:id/graph`, plus the local slice harness for the half of the loop this fixture does not run.

Say the lines in quotes. Do not improvise hashes, gate results, or a verdict. If a command fails, play the backup recording. Do not deploy during the recording.

The competition runtime is Linux or WSL2, Node >= 24, and LF files. Node 22 is not that suite.

## Before you record

Run these and keep the output. They are the local proof, not a Cloudflare run. Use Node >= 24. On Windows, if `python3` is the Store stub, set `MADGRIX_PYTHON=python` first. `scripts/render-demo-graph.mjs` picks a working interpreter itself.

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
- The page colored an overlap. It prints recorded relations: baseline, overlap, and claim-conflict. A stored claim-report risk word is text from that report. The page does not choose green, amber, or red.
- That the line collision is a claim-report color. The combine step stores `textual-line-overlap`. While the record is CONFLICTED, the plate says **PROMOTABLE CANDIDATE: NONE**. A member SHA stays with that member.
- The resolver SHA is one of the three member commits. The page says **New candidate** only for RESOLVED, and only when that SHA is not a member contribution.
- A section that says "not recorded" or "No evaluation bundle is stored" is a pass that has not happened. Do not fill it.
- The graph verified a bundle. Offline verification says **Not run**. The check is `npm run verify` with an out-of-band trust key. A key named inside the bundle is not that check.
- That Agentfleet executed the sub-agents. It validates a roster only when `MADGRIX_FLEET_BIN` is set. MADGRIX itself checks `configs/git4agents-demo-composition.yaml` (`parent`, `sub-api`, `sub-ui`, `sub-test`). `configs/git4agents-fork-crew.yaml` is the three-id roster and is not the demo manifest. The HTML is local git.

## Why Artifacts is the point

Human git gives a fleet one working tree and one credential. Artifacts gives the control plane a repository per contender, a fork or a baseline copy, and a push onto Queue. The TaskAuthority Durable Object records claims, composition, evidence, the verdict, and the permit. It does not fast-forward the canonical repository. That write is the promotion container, one Workflow instance per permit, and the shipped commit is the reviewed SHA. The graph is that record. The offline verifier checks the signed bundle without calling the Worker.

The fixture below uses local git so the recording does not depend on a deploy. The worker route renders the same function against the Durable Object.

---

## 0:00 — Problem

Screen: the resolved graph, banner visible, not scrolled.

> "Agents already write code in parallel. What they cannot do is share one git checkout and one push credential and still tell you which commit was reviewed. MADGRIX is the product that records which exact state may become canonical. Git4Agents is the collaboration protocol underneath it: one CrewContender, the parent and its members, working at the same time. One task. The intent is frozen. Everything under it is state the authority stored, or it is absent. The page does not invent it."

Point at the banner, then the intent.

> "This file says fixture, demo input, local git. It is not a Cloudflare call. The same page is what `GET /tasks/:id/graph` returns for a live task."

## 0:45 — Why human Git breaks for agent fleets

Stay on the task header. Do not open a diagram with fake boxes.

> "Git records a completed state. A person resolves a merge by editing the conflict markers and committing, and that commit has one author. Git4Agents has to coordinate the work while it is still happening. The API agent and the UI agent both write `src/contract.js`, on purpose, at the same time. The integration agent writes a different path. If those three share a working tree, the last writer wins and the overlap becomes an ordinary commit. If they share a credential that can push main, the test agent can ship."

> "Artifacts is the split. The parent holds one fork. Sub-agents do not get a canonical credential. Their commits are real git SHAs. Pushes arrive on Queue, at least once, and the Durable Object dedupes them. The canonical repository is a different Artifact. Nothing on this page is allowed to move it."

## 1:15 — Live work graph

Scroll to **Live work graph**. Point at a dependency, then an overlap. Do not invent a color for either.

> "These are recorded relations. A member commit points at the baseline. An overlap names two agents and a path. A claim-conflict line, when one is stored, is a claim report and its explanation. The page does not turn any of that into green, amber, or red."

Point at the API and UI overlap on `src/contract.js`.

> "The line collision is not a color on this graph. Composition stores the classification textual-line-overlap. That is the overlap. A stored risk word, if you see one under a claim-conflict line, is the claim report's own word. It is not a label this page chose, and it is not the line overlap."

## 2:00 — Concurrent crew

Scroll to **CrewContender**.

> "This is one CrewContender. Git4Agents treats the parent and the members as one collaborative promotion unit. Parent is the fork holder. Its commit on this card is none: the parent row is not a member contribution, and it is not the promotable candidate. API agent, UI agent, test and integration agent. Each member shows the intent, the scope, the status, the claim, and the member commit the record stored. The parent intent says not recorded. We do not copy the crew file in to fill that gap."

> "The three commands ran in separate git worktrees of that one fork, overlapping in time. The test agent's scope is `test/integration/**`. It does not receive the control token or the evaluation token. Its commit is its own SHA. Those three SHAs are contribution SHAs."

Point at the three member commits. Do not read them aloud. Do not call any of them the candidate.

## 3:00 — Conflict

Switch to the conflicted HTML. Stamp **CONFLICTED**. Scroll to the overlap.

> "Both the API agent and the UI agent wrote `src/contract.js`. The combine step stored the classification textual-line-overlap. That is the overlap record. It is the file the merger refused to hide inside a commit."

Point at the plate, then the two sides: agent, intent, contributing SHA, excerpt.

> "Composition: CONFLICTED. Promotable candidate: none. The member SHAs stay on the crew and on the sides of the file. They are not in that plate. HEAD stayed on the baseline. There is no candidate to evaluate, permit, or promote."

## 3:45 — Resolution

Switch to the resolved HTML. **Resolution**.

> "A resolver got the baseline, the conflict file, and each side. It did not get a service token. It wrote one new commit: the API file, the UI file, the integration check, and a contract both sides can live with. The state is RESOLVED. The member contribution SHAs stay on the left. The promotable candidate on the right is a new SHA. It is not any of the three member commits. Resolution created a new software state. It still has to pass evaluation, the verdict seam, and a permit. The page does not skip that."

Point at the arrow. Member contribution SHAs on the left, the new candidate on the right. Read the plate: promotable candidate, then that SHA.

## 4:20 — Independent evaluation

Stay on the resolved page. **Evaluation**.

> "No evaluation bundle is stored. The fixture did not run the tests, and the page does not invent a pass. The gates, when a bundle exists, are the admission record: baseline, scope, evaluation integrity, hidden oracle and regressions, security, provenance and tool state and static analysis. Failed test names are not printed here. The agent bearer can open this route, and the hidden suite is not part of the view."

Cut to the slice terminal. Start it before the recording if you need the clock.

```
npm run slice
```

> "This is a different task, the token-expiry slice, so you can see the rest of the loop on a run that actually evaluates. The evaluator is a separate domain. It does not hold the canonical write. The verdict seam is the decision boundary: accept, reject, abstain, escalate, or quarantine. A candidate that touches the tests or the runner config is quarantined. The composition candidate you just saw is not this slice, and it is not promoted in this video."

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

> "On the task page, offline verification says not run. The page can show that a signature field is present, and a prefix of the key label. It does not check them. This command does. The trust key is the one you pin out of band. The key inside the bundle has to match it, and every signature is checked with the key you passed. No network. Subject, candidate, chain, hidden evaluation, policy, destination base, authority key, signature, permit id, ledger. The last line is VERIFIED, or it is not."

If you have time, flip one signature character and show NOT VERIFIED. Skip it rather than rush.

## 6:50 — Closing

Back to the resolved graph, top of the page, banner still visible.

> "Artifacts holds each fork and the canonical repository as separate repositories. The Durable Object holds the task, the CrewContender, the overlap, and, only when the state is COMPOSED or RESOLVED, the one candidate SHA. The verdict seam is the decision boundary. The container is the only writer that moves the destination, and only to the SHA the permit names."

> "What you saw in the browser is local fixture state. This tree's demo manifest lists parent, sub-api, sub-ui, and sub-test. MADGRIX checks that roster. Agentfleet, only if its binary is configured, cross-checks the roster. It does not run the sub-agents. The page renders the canonical work graph. It does not invent the candidate. This was not run on Cloudflare."

> "Git records completed states. Git4Agents coordinates autonomous work while it is happening. MADGRIX determines which exact resulting state earns authority to become canonical."

Stop. Do not add a metric, a timeline, or a second product name.
