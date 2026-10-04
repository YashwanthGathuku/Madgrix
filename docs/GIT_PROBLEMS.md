# Git4agents git problems

Research-and-fix plan. Only problems that showed up in this project. Contest deadline is 14 October 2026. Public name is Git4agents. The worker stays https://madgrix.ygathuku96.workers.dev. Its root path returns not_found. Leave that alone.

Branch of record: Madgrix `git4agents/combined`, tip `0d6cd1307a15120fe35dd2acf046128187a78577` (4 October 2026, 12:14 PM ET) when this plan was written. Do not deploy. Do not change billing. Do not print tokens. Do not force-push. Do not add a second worker.

## 1. A new Artifacts subscription drops the first push

What happened. A subscription the API has just accepted does not emit the first `pushed` event. An earlier live run subscribed and pushed within a few seconds, and the queue never saw those pushes. An already-live subscription does deliver. The queue consumer also batches for up to 30 seconds.

What is already fixed. Commit `f2346ed4` waits 30 seconds after creating a subscription, then pushes. If the authority still has not applied that push, the script makes another commit and pushes again. `run-fork-crew.mjs` uses the same wait.

What is still open. The first push can still be lost. The recovery is a blind sleep plus a second push, not a signal that the subscription is live. The second push is an empty republish, so the SHA the authority records can be that extra commit. Its tree is still the combined work. The demo also has to sit through the 30 second wait and up to 30 seconds of queue batching. Do not treat that pause as a hung run.

Smallest next change. Keep the wait. In the demo script, say that the pause is the new-subscription gap and the queue batch. If a republish happens, show that the empty commit's tree is the combined work, and do not present the republish as another agent. Do not remove `f2346ed4`.

## 2. Artifacts RPC has no getHead

What happened. Calls to getHead threw TypeError. The binding does not offer that method.

What is already fixed. On this branch, `a88c4e8` reads promotion tips with `ArtifactsRepo.log()`. `66610ce` confirms a contender fork with `readCommit` on the frozen baseline SHA, not getHead and not log(). A missing baseline object is treated as an empty fork so copy-baseline can finish. Do not regress either path. SHA `11c06e2` is not an object in this repository; do not go looking for it.

What is still open. Nothing, as long as new code does not call getHead.

Smallest next change. None. Any new fork or tip check uses `readCommit` for "is this baseline commit in the repo?" and `log()` for "what is the tip?".

## 3. fork() versus copy-baseline

What happened. In the beta, `fork()` returned 400 `10101` "Invalid repo name" for every name. The worker still creates an empty repo and copies the baseline with `copy-baseline.sh` only when it sees that error.

What is already fixed. On this account, fork works. The existing `mgx-task_*` repos, including the three for the promoted task `task_5e53af37e04a7ee39ae60df1`, are `source=artifacts:default/starter-repo` with description `madgrix contender fork`. That is the real `fork()` path, not the import-fallback description. A dry-run of the fork API only printed the POST. It was not executed.

What is still open. The `10101` fallback must stay. Do not delete copy-baseline.

Smallest next change. None, unless a new live fork throws `10101` again. Then the existing fallback is the fix. Do not add a second worker.

## 4. Sibling races versus one parent fork

What happened. Contenders were siblings. Each one forked its own repo and ran the same whole-task command. N agents did not split the work. Promotion kept one SHA and threw the rest away.

What is already fixed. Commit `0d6cd130` adds the fork crew. Config is `configs/git4agents-fork-crew.json`: `parent`, `sub-api` (`src/api/**`), and `sub-ui` (`src/ui/**`), each with its own command and intent. Only the parent calls `POST /contenders`. Sub-agents claim their own paths and commit on branches of that clone. Disjoint edits become one commit whose parents are both sub-agent commits. The live script takes this path only when `MADGRIX_AGENT_IDS` is unset. An explicit id list still runs the sibling race, which is what the isolation tests use. `test/fork-crew.test.ts` passed locally: two sub-agent commits on one fork, and a combined SHA that contains both files.

What is still open. This path has not been run through `live:e2e`. The worker was not redeployed for it, and it did not need a redeploy: fork and copy-baseline were already in the worker. Judges have not seen it.

Smallest next change. Do not redeploy. Do not run a full production `live:e2e` until the overlap fix below is in and a local dry run can show the three judge moments. Keep `MADGRIX_AGENT_IDS` as the sibling override.

## 5. Agentfleet is only a roster check

What happened. Git4agents needed a way to name agents without hardcoding three ids. Agentfleet (`agent-orchestration-os`, branch `paper-hardening`, `49032db`) is proprietary. Its source must not be copied into this MIT repo.

What is already fixed. The crew runner shells out to `fleet validate` on `configs/git4agents-fork-crew.yaml` and requires the ids `parent`, `sub-api`, `sub-ui`. Roles and path globs live in the JSON config, which this repo owns. `fleet run` is not called, because it would invoke a model.

What is still open. Agentfleet is not executing the sub-agents. The file split is the JSON commands. That is intentional.

Smallest next change. None before the demo. Keep `fleet validate`. Do not call `fleet run`. Do not vendor Agentfleet.

## 6. Same-file overlap keeps markers, not both edits

What happened. If two sub-agents touch the same file, the combine must not silent-merge and must not drop a loser. The current combine writes git conflict markers containing both bodies, and writes both claims to `.madgrix/subagent-intents.json`. The unit test checks that `api-body` and `ui-body` are both inside `src/shared.js`, and that neither body is chosen by itself.

What is still open. Both intents are recorded. They are not applied as a clean file when the two edits do not textually overlap inside that file. Markers are correct only when the same lines actually collide. A judge who opens the file today sees a conflict, not the surviving work of both edits.

Smallest next change. Before writing markers, diff the two versions against the parent-fork baseline. If the changed lines do not overlap, write one file that contains both edits, and still record both claims in `.madgrix/subagent-intents.json`. If the changed lines do overlap, keep today's markers and the same record. Add a unit test with two edits in different parts of one file (clean result, both claims) and the existing same-line case (markers, both claims). Do not pick a winner.

## 7. TheUstad is not wired

What happened. TheUstad is not connected to Git4agents. The September branch `claude/project-analysis-bugs-xdq0xz` is at `f4602b2a`. The user can relicense it to MIT. An earlier plan was to vendor it and call it as a subprocess from the contender runner.

What is already fixed. Nothing. It is not in this tree.

What is still open. All of it. Do not vendor it, and do not subprocess it, as part of the work this plan schedules first.

Smallest next change. After the three judge moments below work, and only if the MIT relicense is actually done, call it as a subprocess from the contender runner. Do not copy it in before that, and do not block the October 14 demo on it.

## What to build before 14 October 2026

Build in this order. Stop if a step is not proven by a local test. Do not deploy, and do not redeploy the worker, unless a step changes worker code. None of the steps below should.

1. Same-file combine. Apply both intents when their lines do not overlap. Keep conflict markers and both claims when they do. Test both cases in `test/fork-crew.test.ts`.

2. Judge-visible dry run of the fork crew, after step 1, with the workspace deleted at the end. Show three things and nothing else:
   - Context after the agent is gone: task context from the worker if you already have a local or recorded run, and `.madgrix/subagent-intents.json` read from the combined SHA, not from the deleted workspace.
   - Side-by-side review: the two sub-agent diffs, then the combined SHA.
   - Same-file overlap: one file where both intents are in the surviving SHA (clean apply if the lines differ, markers if they collide), with both claims still in the intents record.

3. Narrate the subscription pause if the demo is live. Keep the `f2346ed4` wait. Budget 30 seconds for a new subscription and up to 30 seconds for the queue batch. If an empty republish is created, say so, and show that its tree is the combined work.

4. Leave these alone while doing 1–3: no `getHead`; `readCommit` for the baseline object; `log()` for tips; copy-baseline only on `10101`; `fleet validate` only; no `fleet run`; no TheUstad; worker root `not_found` stays; `MADGRIX_AGENT_IDS` still means the sibling race.
