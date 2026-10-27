# Governed-resolution benchmark

Does a resolution pipeline admit a wrong resolution of overlapping agent work,
and does it refuse a right one? This benchmark measures the three resolve paths
of Git4agents on two agents editing real JavaScript packages.

```
node scripts/bench-resolution.mjs            # writes results/results.{json,md}
python3 bench/resolution/build_scenarios.py  # rebuilds scenarios/ from upstream/
```

Requires commit `ee421f0` in local history (P0 loads that commit's resolver
unchanged; a `--depth 1` clone does not have it). Mergiraf is used when
installed (`cargo install mergiraf`). A run takes about 50 s.

## Pipelines

| | What it checks | Code |
|---|---|---|
| **P0** pre-lease | The resolve path as submitted to the competition (commit `ee421f0`): the conflicted files changed and contain no merge markers | `git show ee421f0:scripts/lib/fork-crew.mjs` |
| **P1** lease | P0 plus the resolution lease: the authority writes all clean work, the resolver may change only the conflicted hunks | `specs/amendments/resolution-lease-v1.md`, hunk lease in `governed-resolution-v1.md` §2 |
| **P2** governed | P1 plus the frozen witness gate: each side's discriminating witnesses must pass | `governed-resolution-v1.md` §3 |

## Scenarios

Twelve scenarios on three MIT packages by Sindre Sorhus, vendored unmodified in
`upstream/` (each with its license):

| Package | Upstream commit |
|---|---|
| [indent-string](https://github.com/sindresorhus/indent-string) | `7e6c356c4a8425b06efb5c031479304ee0bd67ea` |
| [escape-string-regexp](https://github.com/sindresorhus/escape-string-regexp) | `a7f7dabaf336bda98d2166848af15d9168b10bcf` |
| [decamelize](https://github.com/sindresorhus/decamelize) | `48866469ca1793e1f163a964fc77e839f5038a3f` |

Each scenario is two agents with stated intents. Each agent changes the package
source and also makes one clean change elsewhere (a type declaration or a
changelog), so losing clean work is observable.

| Kind | Count | What happens |
|---|---|---|
| textual | 6 | the agents change the same lines; git reports a conflict |
| list | 2 | git reports a conflict, but the only overlap is two additions to the same option list |
| semantic | 2 | the edits are in different files and git merges them cleanly, but the merged behaviour is wrong (a changed default that another agent's new helper relies on) |
| control | 2 | the edits merge cleanly and the merged behaviour is right |

Per scenario, `scenarios/<ID>/` holds each agent's files, one **witness** per
agent (checks that agent's intent only), the **reference** resolution a careful
developer writes, and a held-out **acceptance** test (both intents, both
agents' clean work, and baseline behaviour). The pipelines never see the
acceptance test. The benchmark checks before running that every witness
discriminates its side (fails on the baseline, passes on the agent's commit)
and that each scenario conflicts or merges as its kind says.

## Resolver behaviours

`scripts/bench/resolution-strategy.mjs` — behaviours real resolvers show:

| Strategy | Behaviour |
|---|---|
| ours / theirs | keep one side's file |
| union | git's union merge: both sides' lines, no markers |
| markers | leave git's conflict markers |
| reference | the careful developer's resolution |
| tamper | the reference, plus deleting another agent's clean file |
| drop-clean | the reference, but (under P0) without rebuilding the clean files the resolver was responsible for |
| mergiraf | Mergiraf 0.20.0's syntax-aware merge |

## Results (2026-10-18, Node 22.22.0, Mergiraf 0.20.0)

Full tables: [`results/results.md`](results/results.md). Two runs gave identical
outcomes on all 204 attempts.

Conflicting scenarios, 64 attempts per pipeline (8 scenarios × 8 behaviours):

| Pipeline | Admitted | Admitted and correct | False accepts | Refused but correct |
|---|---|---|---|---|
| P0 pre-lease | 49 | 12 | **37** (76% of admitted) | 0 |
| P1 lease | 36 | 19 | **17** (47%) | 1 |
| P2 governed | 19 | 19 | **0** | 1 |

Clean-merging scenarios: P0 and P1 admit all four composed candidates, two of
them wrong (the semantic scenarios). P2 refuses both semantic conflicts and
admits both controls. A witness check took 87 ms median (117 ms max) per
candidate with two witnesses.

What the rows show:

- **The lease removes two whole failure classes.** Under P0 every *tamper* (8/8)
  and every *drop-clean* (8/8) resolution is admitted and wrong. Under P1
  tamper is refused 8/8, and drop-clean becomes correct 8/8 because the
  authority, not the resolver, writes the clean work.
- **The lease cannot see intent.** *ours* and *theirs* are admitted and wrong
  under P1 in the six textual scenarios. The witness gate refuses all of them.
- **Union merge is sometimes right.** It is correct in 3 of 8 conflicting
  scenarios (an insert/insert conflict and both list scenarios); P2 admits
  exactly those 3 and refuses the 5 wrong ones.
- **The one false refusal** is Mergiraf's only successful merge (ES-1): its
  output is correct but rewrites a clean line as `return  string` (two spaces),
  and the hunk lease compares bytes. Splicing only a resolver's hunk text into
  the authority's clean bytes would remove this; it is not implemented.
- **Mergiraf resolved 1 of 8 conflicts.** It does not treat additions to a
  destructuring option list as order-free, so the two list scenarios still
  conflict under it.

## Threats to validity

- **Small and constructed.** Twelve scenarios, written by the authors on three
  small packages. They exercise the mechanics of the gates; they are not a
  sample of real-world conflicts and give no real-world precision or recall.
- **Witnesses and acceptance tests share an author.** Each witness checks a
  subset of what its acceptance test checks. P2's zero false accepts partly
  reflects that: a resolution that keeps every witnessed behaviour but breaks
  an unwitnessed one would be admitted. The acceptance tests also check
  baseline behaviour and clean work that no witness covers.
- **The resolver behaviours are scripted.** No language-model resolver is
  evaluated here. The replay rung and dual-order agreement are tested only with
  deterministic replayers (`test/governed-resolution-runner.test.ts`).
- **One ground-truth stand-in.** A lease refusal leaves no commit; "refused but
  correct" then uses the same behaviour's P0 candidate, which carries the same
  resolver output.
- TheUstad's frozen-baseline gate is stubbed; it is not part of what is measured.
