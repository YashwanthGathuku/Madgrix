# Spec amendment: resolution-lease-v1 — a resolver writes only the conflicted paths

**Status:** proposed · **Date:** 2026-10-18
**Affects:** `specs/amendments/composition-result-v1.md` §(2) RESOLVED, and
`specs/amendments/conflict-capsule-v1.md`, by this amendment file only.
The frozen spec files are not edited.

## (1) The defect

composition-result-v1 let a resolver "read the baseline tree,
`.madgrix/conflict.json`, and `.madgrix/sides/<agent>/`". `resolveComposition`
implemented that by resetting the parent checkout to the baseline, writing the
conflict inputs into the working tree, running the resolver, and checking only
the conflicted files. Three things followed, each reproduced on commit
`ee421f0` with the demo crew:

1. **Clean work could be dropped.** The resolver had to rebuild every
   non-conflicting file itself. A resolver that wrote only `src/contract.js`
   produced a RESOLVED commit holding none of `src/api/handler.js`,
   `src/ui/view.js` or `test/integration/check.js`. `commitIndex` still wrote
   every sub-agent commit as a parent, so Git history claimed the crew's work
   was merged while the tree did not contain it.
2. **Writes were unbounded.** After the resolver exited, everything was staged
   with `git add -A`. A resolver could rewrite another agent's test, edit an
   unrelated file, or add a new one.
3. **Inputs were committed.** `.madgrix/conflict.json` and
   `.madgrix/sides/<agent>/…` were staged into the candidate tree, so both
   sides' full text would ship to canonical history on promotion.

## (2) The lease

A resolver receives a **resolution lease**: the set of conflicted paths and
nothing else.

1. The lease is derived from the crew's commits (`classifyEdits`), not taken
   from the conflict record. A record whose paths differ from the derived
   conflicts is refused before the resolver runs.
2. The authority writes the **pre-composed tree** itself: the baseline plus
   every crew edit outside the lease, using the same rule as COMPOSED (one
   owner → that agent's blob; several owners → their disjoint three-way merge).
   Leased paths keep their baseline text.
3. Resolver inputs are written to a fresh directory outside the repository.
   The resolver receives `MADGRIX_CONFLICT_PATH` (absolute path to the
   conflict JSON), `MADGRIX_SIDES_DIR` (absolute path to the side texts),
   `MADGRIX_BASELINE_SHA`, `MADGRIX_LEASED_PATHS_FILE` and, when small,
   `MADGRIX_LEASED_PATHS` (newline-separated); see (2a). It
   still receives no service token. The directory is deleted when the resolver
   exits.
4. After the resolver exits, the staged tree is compared with the pre-composed
   tree. Any changed path outside the lease — a modification, an addition or a
   deletion — refuses the resolution. Each leased path must exist, must have
   changed, and must contain no `<<<<<<<` or `>>>>>>>` text.
5. On refusal the parent checkout returns to the baseline and no commit is
   written.
6. The RESOLVED record (`.madgrix/subagent-intents.json`) carries
   `lease: { format: "madgrix-resolution-lease/v1", paths, precomposed_tree }`,
   so anyone can check that the resolved tree differs from the pre-composed
   tree only on leased paths and the authority's own records.

## (2a) Containment (resolution hardening, stress report 2026-10-19)

1. **The resolver does not run in the authority repository.** Its working
   directory is a fresh directory holding only the leased files at their
   pre-composed text and mode. It is not a git repository; there is no
   `.git`, so it cannot plant hooks or config. A resolver that relied on
   `git` inside its working directory must read `MADGRIX_LEASED_PATHS_FILE`
   instead.
2. Every file left in that directory must be a leased path and a regular file
   (checked with `lstat`; a symlink, FIFO or device is refused). A leased file
   must keep its pre-composed exec bit. Only then are the files copied into
   the authority repository; `diff-index --raw` against the pre-composed tree
   is checked again, modes included.
3. The authority repository's config, hooks, info files, refs and working
   tree status are fingerprinted before the resolver runs; any change refuses
   the resolution.
4. The leased paths are in `MADGRIX_LEASED_PATHS_FILE` (a JSON array).
   `MADGRIX_LEASED_PATHS` (newline-separated) is still set when it is at most
   32 KiB, so a wide lease no longer hits the kernel's per-variable limit.
5. The resolver runs in its own process group under a reaper
   (`scripts/lib/sandbox-reaper.mjs`). When it exits or reaches its timeout
   (`opts.timeoutMs`, else `MADGRIX_RESOLVER_TIMEOUT_MS`, else 10 minutes) the
   group is killed, and so is every process still carrying the run's
   `MADGRIX_SANDBOX_RUN` nonce (one that called `setsid`). stdout is
   discarded and stderr goes to a file, so there is no output cap.
6. Bubblewrap is mandatory (`MADGRIX_RESOLVER_SANDBOX` defaults to `bwrap`).
   The resolver gets a new PID namespace and `/proc` (the runner's
   `/proc/<pid>/environ` is not visible; every process in the namespace dies
   with it), a read-only root file system, a private writable `TMPDIR`, and an
   empty `~/.madgrix`. When bubblewrap cannot create a sandbox the resolver is
   not run and the attempt is refused (REVIEW). `MADGRIX_RESOLVER_SANDBOX=none`
   is honoured only together with `MADGRIX_I_ACCEPT_UNSANDBOXED_RESOLVER=1`
   and prints a warning; in that mode a same-uid resolver can read other
   processes' `/proc/<pid>/environ` and write outside its directory.
7. Conflict markers: a line that is exactly a git marker line
   (`<<<<<<< `, `||||||| `, `=======`, `>>>>>>> `) is refused unless that same
   line is already in the base or a side, so a file that legitimately contains
   one can be resolved and a lone `=======` cannot slip through.
8. Control-plane git runs with `core.hooksPath=/dev/null`,
   `core.fsmonitor=false`, no system or global config, and NUL-separated path
   output (`-z`, no rename detection). Witness trees are written with a
   private index and `checkout-index`, not `worktree add`, so no hook runs.
   Witness replays run candidate code and are contained like the resolver
   (item 6, `purpose: "witness"`): bubblewrap is required, only the witness's
   own checkout is writable, and when bubblewrap is unavailable the replay
   throws and nothing is admitted. `MADGRIX_WITNESS_SANDBOX` overrides
   `MADGRIX_RESOLVER_SANDBOX` for witnesses; `none` needs the same opt-in.
9. Control-plane steps that move `main` or write the working tree of one
   repository hold `.git/madgrix-control.lock` (stale locks of dead pids are
   taken over). Sub-agent worktrees are detached; their commits are kept under
   `refs/madgrix/runs/<run>/<agent>`, not `madgrix/<agent>` branches. Those
   refs are deleted once the run's candidate is on main (reachable through its
   parents); a run that did not publish keeps them for forensics
   (`npm run prune:runs -- <repo> [--older-than-days N]`).
10. `main` moves only by compare-and-swap (`git update-ref refs/heads/main
    <new> <expected>`, scripts/lib/main-ref.mjs). The expected value is main
    when the crew started. A crew refuses to start when HEAD is not main. A
    composition or admitted resolution whose publish finds main moved is
    rebased onto the new main (`rebaseCandidate`: a three-way tree merge with
    the old base as merge base; files under `.madgrix/` are the candidate's;
    the new commit's parents are the new main and the sub-agent commits) and
    tried again, at most `MADGRIX_MAIN_REBASE_RETRIES` times (default 3; 0
    refuses at once). The new main must descend from the old one. An admitted
    resolution is published on a new base only if its frozen witnesses,
    re-run on the rebased commit, ADMIT it again; a COMPOSED candidate is
    witness-checked by governCrewResult after publishing and taken back off
    main (CAS) if refused. A REVIEW candidate a person cleared is not rebased
    (the person cleared other content). A conflicting rebase, a failed
    re-verification or exhausted retries refuse: `MainMovedError` for a
    composition, REVIEW ("main moved …") for a resolution. Records of a
    rebased candidate carry `rebased_onto` (admission-proof-v1, v2 payload).
    A refused COMPOSED candidate is taken back off main only if main is still
    at it. All other steps work on a detached HEAD.
11. Sub-agents share the repository's git dir. The repository's control files
    (config, `config.worktree`, every file reached through `include.path` or
    `includeIf.<cond>.path` from those configs — followed recursively,
    wherever it lives, whether or not the condition currently holds, and
    recorded as absent when it does not exist yet — hooks, `info/`, object
    alternates, and every file in the crew's own worktrees' admin dirs except
    git's volatile state: index, logs, refs, merge/rebase/bisect state,
    locks; HEAD is watched for being attached, not for its commit) are
    snapshotted after the worktrees are created; when a sub-agent changed any,
    the files are restored and the crew is refused before any control-plane
    git runs in its worktree. Control-plane git in a sub-agent worktree uses
    the admin dir recorded before the agent ran (`GIT_DIR`), not the
    worktree's `.git` file, which the agent can rewrite.

## (3) What does not change

- RESOLVED is still a new SHA that is not a contributing SHA, and still needs
  its own evaluation, verdict and permit.
- The authority's composition state machine (`recordComposition`) is unchanged.
- COMPOSED output is byte-for-byte unchanged; the clean-edit rule was moved
  into a shared helper, not altered.

## (4) What this amendment does not say

- **Intent is not checked here.** The lease bounds *where* a resolver writes.
  A resolver that keeps only one side's text inside a leased path is still
  accepted at this layer. Whether a resolution preserves each side's intent is
  an evaluation question (a per-side witness gate is planned; it is not part of
  this amendment).
- **The lease is file-level.** Hunk-level leases (only the conflicting line
  ranges are writable) are planned with Conflict Capsule v2.
- **The resolver is not sandboxed.** It runs as a local process with a minimal
  environment, as fork-crew sub-agents do (`docs/KNOWN_LIMITATIONS.md` #11).
  The lease is enforced on what is committed, not on what the process can touch.
- The capsule id and the resolver's identity are not yet bound into the
  authority ledger.

Tests: `test/resolve-lease.test.ts`.
