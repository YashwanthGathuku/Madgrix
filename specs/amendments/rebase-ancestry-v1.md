# Spec amendment: rebase-ancestry-v1 — permits only at heads the candidate descends from; a moved destination means a rebased, re-evaluated candidate

**Status:** proposed · **Date:** 2026-10-03
**Affects:** `PROMOTION_PROTOCOL.md` (FROZEN-v1) §10 (destination-bound permit) and
§12 (stale work); `ATTESTATION_PROTOCOL.md` (stable core) §4 (the
`destination.expected_parent` field) and §7 (the "destination parent" transcript
line); `CLOUDFLARE_RUNTIME_MODEL.md` (FROZEN-v1) §11 [OPEN] 4, which this resolves.
These are changed via this amendment file only; spec files are NOT edited.

## (1) The invariants (quoted from the specs)

`PROMOTION_PROTOCOL.md` §10 (FROZEN-v1):

> "**Destination-bound (TOCTOU closure).** If `expected_destination_head !=
> current destination HEAD` at promotion time, the permit has EXPIRED. The
> promotion MUST NOT proceed; the candidate MUST be re-evaluated (or rebased
> and re-verified) against the new head."

§9.5: "If the work is salvageable: new candidate state → new SHA → new evidence →
full reevaluation." §12: "Baseline mismatch / stale work | 2 | REJECT candidate;
contender may rebase and resubmit as a new candidate state".

`ATTESTATION_PROTOCOL.md` §4 and §7:

> `"destination": { "repo": "<canonical repo>", "expected_parent": "<destination HEAD at permit issue>" }`
>
> `destination parent .... OK      # expected_parent matches the recorded ship parent`

`CLOUDFLARE_RUNTIME_MODEL.md` §11:

> "4. Merge-sandbox mechanics: exact git operations for applying the winning tree
> onto a moved destination HEAD (rebase vs. re-verify)."

## (2) What the implementation violated

- `container/promote.sh` promotes by fast-forwarding the destination to the
  candidate SHA, and refuses (exit 47) unless the permit-bound head is an ancestor
  of the candidate. `src/lib/task-state.ts` had no notion of ancestry: `issuePermit`
  bound whatever head the caller named. `src/harness/head-move.ts` promoted a
  candidate X, let the head move to H2 (a descendant of X), re-evaluated the SAME X,
  and promoted it again with a permit bound to H2. The authority accepted that;
  the real container refuses it with exit 47. Re-evaluating a commit does not change
  what it descends from, so "re-verify" alone can never make it promotable at a head
  it does not descend from.
- `promote.sh` echoed `PARENT=$EXPECTED_HEAD` from its input, and the attestation
  called the permit-bound head `expected_parent`. That head is the promoted commit's
  parent only when the candidate is one commit above it.
- `ALREADY_WRITTEN` required the destination head to equal the candidate. A retry
  after the destination moved on past our own write (a commit on top) got
  `EXPIRED_HEAD_MOVED` instead.
- Exit 44 (push refused) and exit 46 (a gitlink in the tree) were mapped to
  `GIT_ERROR` 502, which the PromotionWorkflow retries, though neither can succeed
  on a retry.
- `src/do/PromotionContainer.ts` and the PromotionWorkflow docstring still described
  a design that rebuilt the promoted commit ("deterministically reconstructs the same
  commit"); the slice harness "executed" promotion by rebuilding the commit too.

## (3) The change

### Ancestry in the task authority (`src/lib/task-state.ts`)

- `ContenderRecord.fork_base`: the commit the contender's fork was created at.
  `registerContender` refuses any value other than the task's baseline commit.
- `ContenderRecord.rebases`: what the rebase service reported, in order:
  `{ outcome: "REBASED" | "UP_TO_DATE", from_sha, onto, new_sha, at }`. Each record
  says `onto` is an ancestor of `new_sha`.
- `permitBases(contender, sha)`: the fork base, then the `onto` of every record whose
  `new_sha` is `sha`.
- `issuePermit` binds a destination head only if it is in `permitBases`. Any other
  head is **`REBASE_REQUIRED`**: no permit is stored, and the refusal is a
  `permit_refused` ledger entry (`outcome`, `winner_sha`, `contender_id`,
  `destination_repo`, `destination_head`, `bases`). The TaskAuthority's `/permit`
  answers 409; the Worker's `POST /tasks/:id/verdict` answers 409
  `{ verdict, permit: null, outcome: "REBASE_REQUIRED", destination_head, bases }`.
- `recordRebase(report)`:
  - `REBASED`: appends the record. If the contender's latest observed commit is still
    `from_sha`, it becomes `new_sha`; a newer observed push is never moved back. The
    new SHA has no evidence, so it cannot be in a verdict until the evaluation domain
    evaluates it.
  - `UP_TO_DATE`: appends the record (`new_sha` = `from_sha`); nothing else changes.
  - `CONFLICT`: escalates the task to the operator-of-record (spec 1 §9.4). The
    escalation carries `data: { kind: "rebase_conflict", contender_id, candidate_sha,
    onto, paths, paths_total }` (at most 1000 paths kept). The paths are never put in
    the escalation's reason text: the contender chose them.
  - A report identical to a recorded one is `ACK_DUP`. Unknown, quarantined and
    revoked contenders, and malformed reports, are refused.
- Trust: the authority has no git. The fork-base rule relies on the evaluation
  domain's `exact_baseline` gate (the candidate descends from the baseline); a
  rebase record relies on the promotion container's report. `promote.sh` checks the
  real ancestry before any write in both cases.

### `container/rebase.sh` (new) and `POST /tasks/:id/rebase`

`POST /tasks/:id/rebase` `{ contender_id, destination_repo }` (CONTROL) rebases the
contender's latest observed commit onto the destination's current head. The Worker
mints a five-minute write token for the contender's fork and a five-minute read token
for the destination, runs `rebase.sh` in the promotion container, revokes both tokens,
and records the result through the TaskAuthority's `/rebase`.

`rebase.sh`:

1. fetches the fork's `main` and refuses unless it is the candidate (exit 42
   `FORK_MOVED`, with `FORK_HEAD`);
2. fetches `ONTO` by SHA from the destination (exit 45 on a mismatch);
3. `ALREADY_IN_DESTINATION` (exit 48) when the candidate is already in `ONTO`'s
   history; `UP_TO_DATE` (exit 0, nothing pushed) when it already descends from
   `ONTO`;
4. otherwise `git rebase ONTO` with a fixed committer (`madgrix-rebase`) and committer
   dates taken from the author dates, so the same candidate rebased onto the same head
   is the same commit. Attributes are read from the empty tree (`GIT_ATTR_SOURCE`):
   the candidate's own `.gitattributes` cannot pick merge drivers such as
   `merge=union` that turn a conflict into a silent merge;
5. a conflict on any path is `CONFLICT` (exit 49) with `CONFLICT_PATHS`, the base64
   of the NUL-terminated paths, so any byte a path may hold survives; the rebase is
   aborted and nothing is pushed. One exception: when the only conflicting path is the
   tool-status log (`.madgrix/tool-status.jsonl`, `tool-status-v1.md`), the
   candidate's version (or its deletion) is kept. Every promoted winner ships its log
   at that path, so without this any rebase across two promotions would conflict
   there;
6. a rebase whose every change was already in `ONTO` is `ALREADY_IN_DESTINATION`;
7. pushes the new commit to the fork's `main` with
   `--force-with-lease=refs/heads/main:<candidate>`, so it replaces the candidate and
   nothing newer (exit 44 `PUSH_REJECTED` otherwise), and reports `REBASED`,
   `REBASED_SHA`, `ONTO`.

The script never writes to the destination. `REBASED` and `UP_TO_DATE` answer 200;
`CONFLICT` answers 409 and escalates; `FORK_MOVED`, `PUSH_REJECTED` and
`ALREADY_IN_DESTINATION` answer 409; git failures answer 502.

### `container/promote.sh`

- Prints `BASE=$EXPECTED_HEAD` and `PARENT=$(git rev-parse -q --verify "$CANDIDATE_SHA^")`
  (empty for a root commit) with `PROMOTED` and `ALREADY_WRITTEN`.
- `ALREADY_WRITTEN` when `git merge-base --is-ancestor $CANDIDATE $CURRENT_HEAD` **and**
  `git merge-base --is-ancestor $EXPECTED_HEAD $CANDIDATE`. The second condition goes
  beyond the first as asked: without it, a permit whose head the candidate does not
  descend from (the old head-move step 5: X in the destination's history, the permit
  bound to H2, a descendant of X) would be finalized and signed as "X shipped on base
  H2". With it, that case is `BASELINE_MISMATCH`.
- Every terminal exit prints its outcome: 43 `TREE_MISMATCH`, 44 `PUSH_REJECTED`,
  46 `UNSUPPORTED_TREE_ENTRY`.
- `src/lib/git-promotion.ts` (`promotionHttpResult`, `rebaseHttpResult`) maps exit
  status and output to the container's answer: 42, 43, 44, 46 and 47 are terminal
  409s; anything else non-zero is 502. The Worker passes 409 through, and the
  PromotionWorkflow returns it rather than retrying; only 5xx is retried. The permit
  stays unconsumed either way.
- The Worker finalizes only a `PROMOTED`/`ALREADY_WRITTEN` answer whose
  `promoted_sha` is the permit's candidate and whose `base` is the permit's head, and
  passes `verified_base` and `promoted_parent` to `/promotion/finalize`.

### Attestation: bundle version 3

- The `AgentPromotionAuthority/v1` predicate's `destination.expected_parent` is renamed
  `destination.base`. The value is unchanged: the permit's expected destination head.
  The permit id is recomputed from `destination.base`.
- The ship record is `{ repo, commit, tree_sha256, base, parent, permit_id }`: `base`
  is the permit's head, `parent` the promoted commit's first parent as `promote.sh`
  read it from git. `parent` is informational and unsigned; the signed candidate
  commit SHA already fixes its parents, and the verifier does not check it.
- Transcript line 6 is `destination base` (`the attested base matches the ship base`).
- `recordPromotionBundle` refuses a promoted commit that is not the permit's
  candidate. Version-2 bundles (no `ship.base`) do not verify under these rules.

### The evaluation base

After a rebase, comparing the candidate with the task baseline counts the
destination's own changes as the contender's: claim-scope failures, and, if the
destination changed test material or runner configuration, a tamper quarantine of an
innocent contender (`test/evaluator-isolation.test.ts` shows both). So:

- `POST /tasks/:id/evaluator-credentials` lists `evaluation_bases`: the fork base, then
  every recorded rebase head.
- `scripts/evaluate-candidate.ts` uses the newest of them the candidate descends from:
  the candidate's changes, the runner configuration and the test material all come
  from it, and the bundle names it as `evaluation_base`. `exact_baseline` and the
  tool-status log binding still use the task baseline.
- `submitEvaluation` refuses an `evaluation_base` that is not one of the contender's
  known bases.

### One fixture table for the scripts and the model

`test/fixtures/promotion-cases.json` holds 25 cases (13 promote, 12 rebase), two of
them races in which another writer moves the ref just before the script's push (the
fast-forward and the lease must refuse it).
`test/promotion-fixtures.test.ts` runs every case through the real script under bash
against real git repositories, and through the TypeScript model of the script
(`runPromoteModel` / `runRebaseModel` in `src/lib/git-promotion.ts`, over FakeArtifacts
via `src/harness/fake-container.ts`). Both must give the case's exit status and
fields, leave its refs, produce a rebased commit with the expected parent chain and
files, map to its HTTP answer, and drive the task authority to its permit decision.
The tree digest in the expected fields is computed in the test from the
tree-digest/v1 definition, so bash, the model and the definition agree. The same test
runs `PromotionContainer.ts` itself with a container whose exec runs the real
scripts.

Model limits: conflicts are found per path, not per line (git merges edits to
different lines of one file; the model reports a conflict), and candidate histories
must be linear. No fixture case lies outside either.

### Harnesses and benchmark

- `src/harness/head-move.ts`: permit at the fork base → concurrent merge → the stale
  permit expires (container exit 42; unconsumed, no effects) → the same SHA,
  re-evaluated, is `REBASE_REQUIRED` (the container would answer exit 47) → the
  rebase makes a new SHA, which is evaluated, permitted at the moved head and
  promoted by a fast-forward. `npm run headmove` passes only through the rebased SHA.
- `src/harness/slice.ts`: `tree_sha256` is tree-digest/v1, and the `canonical_write`
  effect (now `{ repo, commit, tree_sha256, base }`) runs the promote model instead of
  rebuilding the commit.
- `src/lib/benchmark.ts` trial 24 (attack-12b): the same SHA at the new head is
  `REBASE_REQUIRED`; the rebased SHA, re-evaluated, is permitted and promotes.

## Not claimed

- Neither script has run against Cloudflare Artifacts, only against local
  repositories. Both fetch a commit by SHA (`promote.sh` the candidate, `rebase.sh`
  `ONTO`); whether the Artifacts git server serves that has not been checked here.
- `scripts/live-e2e.ts` does not drive the rebase loop. A destination that moves
  during a live run fails at the verdict with 409 `REBASE_REQUIRED`.
- A lost response after `rebase.sh` pushed but before the authority recorded the
  rebase: a retry gets `FORK_MOVED` (the fork's head is the rebased commit, not the
  authority's candidate). Once the push event is ingested, a new `/rebase` of that
  head is `UP_TO_DATE` and records the ancestry, but the `from_sha → new_sha` link is
  not recorded.
- Escalations have no resolution path, and `runVerdictSeam` sets `task_status` on
  every verdict, so a later verdict clears `escalated` (true before this change too).
  A conflict escalation therefore does not by itself block a later permit; the
  ancestry rule does, because the conflicted candidate has no recorded ancestry at the
  new head.

Implementation notes: `container/promote.sh`, `container/rebase.sh`,
`container/Dockerfile`, `src/lib/git-promotion.ts`, `src/lib/tree-digest.ts`,
`src/lib/task-state.ts` (`issuePermit`, `permitBases`, `evaluationBases`,
`recordRebase`, `recordPromotionBundle`), `src/lib/attestation.ts`,
`src/do/PromotionContainer.ts`, `src/do/TaskAuthority.ts` (`/permit`, `/rebase`,
`/promotion/finalize`), `src/worker/index.ts` (`handleVerdict`, `handleRebase`,
`handlePromote`, `handleEvaluatorCredentials`, `PromotionWorkflow`),
`scripts/evaluate-candidate.ts`, `src/harness/fake-container.ts`,
`src/harness/head-move.ts`, `src/harness/slice.ts`, `src/lib/benchmark.ts`. Tests:
`test/rebase-ancestry.test.ts`, `test/promotion-fixtures.test.ts`,
`test/rebase-route.test.ts`, `test/head-move.test.ts`,
`test/evaluator-isolation.test.ts`, `test/attestation.test.ts`.
