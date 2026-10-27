# g4a: Phase 0 local git interception for Git4agents

`g4a` installs a PATH shim named `git`. Coding agents that run `git` through a shell
(Claude Code, Codex CLI, Gemini CLI / Antigravity terminals, Grok Build if it shell-execs)
reach the shim transparently. The shim is deterministic, uses no LLM and makes no network
calls of its own. Phase 0 covers only: pass-through, output compaction for a few safe read
commands, a local JSONL log with measured savings, and generated agent hook configs.
There are no claims, permits, ledger, worktrees or authority remote yet (Phase 1+, see
`research/git4agents-local-intercept.md`).

Plain Node ≥ 22 ESM, no dependencies. It is self-contained in `packages/g4a`.

## Commands
```
node packages/g4a/bin/g4a.mjs install [--rc ~/.bashrc]   # writes $G4A_HOME/bin/git; with --rc adds a marked PATH block
node packages/g4a/bin/g4a.mjs uninstall [--rc ~/.bashrc] # removes shim + exactly the block it added
node packages/g4a/bin/g4a.mjs doctor                     # shim first on PATH? real git resolved? not-covered list
node packages/g4a/bin/g4a.mjs stats                      # savings from $G4A_HOME/log.jsonl
node packages/g4a/bin/g4a.mjs hooks claude|codex|gemini  # prints a hook config snippet
```
`G4A_HOME` defaults to `~/.g4a`. Without `--rc`, install prints the snippet and leaves your shell rc alone.

## How the shim decides
1. `/bin/sh` fast path: `exec`s the real git, with no Node start, if `G4A_RAW` is set, if
   `G4A_ACTIVE` is set (nested call from g4a, which is the recursion guard), if stdout is a TTY,
   or if no agent marker is present. Agent markers: `G4A_AGENT=1`, `CLAUDECODE`, any
   `CODEX_*`, `GEMINI_CLI`, or `G4A_NONTTY_IS_AGENT=1` (opt-in, so a plain piped command
   from a human never counts as an agent). `G4A_AGENT=0` forces pass-through.
2. Otherwise Node classifies the argv (`src/lib.mjs: classify`). Only these forms are compacted:
   | command | compacted output |
   |---|---|
   | bare `git status [-- paths]` | `git status --porcelain=v1 -b` (the `-sb` form) |
   | `git log` without format/patch/stat/-z/etc. (`-n N` allowed) | `%h %s (%an, %ar)` one line per commit, capped at 50 with a note |
   | `git diff --stat`, `git show --stat` | `+++---` bars removed |
   | `git branch` / `-a` / `-r` listing | indentation trimmed, capped at 40 |
   | `git push/pull/fetch` (no `--porcelain`, `-q`, `-v`, `--dry-run`, ...) | progress lines (`Enumerating/Counting/Compressing/Writing objects`, `Total`, `Resolving deltas`) dropped |
   Everything else is spawned with inherited stdio and its exit code or signal is passed
   back. That includes `--porcelain`, `-z`, `--format`/`--pretty`, `-s/--short`,
   `--name-only/--numstat`, plain `diff`/`show` patches, all plumbing, and every write command.
3. Compaction never applies when git exits non-zero, when stdout contains a NUL byte, or when
   the result would not be smaller. In those cases the raw bytes are emitted as captured.
   When compaction does apply, the full raw output is saved to `$G4A_HOME/tee/<id>.txt` and
   capped outputs print that path.
4. Every call in agent context is logged to `$G4A_HOME/log.jsonl`: argv, cwd, mode, exit code,
   bytes before/after and estimated tokens.

Token estimate in the log and in `stats`: `ceil(bytes / 4)`. This is a heuristic, not a
tokenizer. The benchmark can count with `js-tiktoken` (o200k_base) instead.

## Agent hooks
`g4a hooks <agent>` prints one combined `PreToolUse` (Claude Code, Codex) or `BeforeTool`
(Gemini) entry that calls `g4a hook <agent>`. In Phase 0 the hook only records the session
id and the git command to the log, then exits 0 with **no stdout**. It never rewrites or
denies, so it cannot collide with other hooks' rewrites (claude-code issue #79321). The hook
does not put the shim on PATH. Activation still comes from PATH. The snippet formats follow
the public docs. They have not been tested against live Claude Code, Codex or Gemini sessions.

## Tests
`cd packages/g4a && npm test` runs 17 node:test cases against a fixture repo and the real git binary:
- byte-identical stdout, stderr and exit code for porcelain, `-z`, `--format`, plumbing, binary diffs, failures and stdin
- signal propagation (SIGTERM)
- exact exit code from a fake git (42)
- no recursion through `!git` aliases
- humans and TTY untouched (a pty via `script`)
- `G4A_RAW`
- compaction correctness and the tee file
- stats
- hooks
- install/uninstall restoring rc files byte-for-byte

## Benchmark
`node bench/run.mjs <repo>...` (`G4A_TIKTOKEN=<dir containing js-tiktoken>` is optional) clones each repo
to a temp dir, dirties it, and runs a 14-command agent-like workload. It runs each command through
real git and through the shim, then compares bytes and tokens. Results from 2026-10-27, on sindresorhus/ky
@3541888 and this repo, are in `bench/RESULTS.md`:
- **Whole workload:** 95,306 → 6,853 tokens (−92.8%). Most of that comes from two unbounded `git log` calls being capped at 50 commits.
- **Excluding bare `git log`:** 9,571 → 3,762 tokens (−60.7%).
- **Per command:** `git status` −67…78%, `git log -n 20` −65…87%, `diff --stat` ~−18%, `show --stat`/`branch -a` ≤10%. Push/fetch to a local remote gained nothing: non-TTY git prints no progress.
- **Exit codes:** 0 mismatches.
- **Overhead:** about 30–50 ms per compacted or agent-context call (Node startup). Human/TTY calls go through the sh fast path only.
Savings depend on the workload. They shrink as a share of an agent's total token spend.

## Honest limits (not intercepted)
- git invoked by absolute path (`/usr/bin/git`), or from a sandbox that resets PATH.
- git libraries that don't spawn the binary: libgit2, go-git, JGit, isomorphic-git, and GitPython/GitDB object reads.
- IDE SCM panels (Cursor, VS Code, Antigravity) using their own `git.path`. Cursor SCM also forces `core.hooksPath=/dev/null`.
- Cloud agents (GitHub Copilot coding agent) run on remote runners.
- Only CLI calls through PATH are seen. Nothing here enforces policy. Phase 0 observes and compacts only.
- Compaction changes what an agent sees for the listed commands. Agents that parse plain
  `git status`/`git log` human output, instead of porcelain or `--format`, will see the compact form.
  Use `G4A_RAW=1` or `G4A_AGENT=0` to opt out.
- POSIX only (sh shim). Not tested on Windows or macOS.

## Phase 1: local coordination daemon (no Cloudflare)

Phase 1 replaces the Cloudflare control plane with local pieces: the Durable Object becomes
`g4a daemon` + SQLite, Artifacts become git worktrees, and Queues become an in-daemon job loop.
It reuses `src/lib/claims.ts`, `src/lib/ledger.ts`, `src/lib/canonical.ts` and the
resolution-hardening scripts (`scripts/lib/sandbox.mjs`, `scripts/resolvers/mergiraf-resolver.mjs`,
`scripts/lib/fork-crew.mjs`, `scripts/lib/safe-git.mjs`). It does not reimplement them.

```sh
g4a daemon --detach                      # per-user: $G4A_HOME/g4a.sock (0600, dir 0700), g4a.db
g4a claim --agent alice --paths src/calc.js --witness 'npm test' [--allow-overlap]
#   -> worktree <repo>/.g4a/worktrees/alice on branch g4a/alice; secret in $G4A_HOME/secrets/<id> (0600)
g4a status | g4a release --agent alice [--remove-worktree]
g4a promote --agent alice                # queued job; waits for the result
g4a ledger --out bundle.json             # export
g4a verify [bundle.json] [--pin SPKIHEX] # offline: no daemon; reads the bundle or the db read-only
g4a stop
```

**Claims.** Claims are serialized in the daemon. A claim overlapping an active claim (using `globsOverlap`) is refused
unless both claims set `--allow-overlap`. Globs are exact paths or `dir/**`, and `**` alone is
rejected. Every claim, refusal, release and scope warning is appended to a hash-chained ledger.

**Promotion** (one job at a time). The steps are:
1. Check the agent secret (only its sha256 is stored).
2. Scope check: files changed since the claim baseline must match the claim globs.
3. Ladder: fast-forward, then `git merge-tree`, then Mergiraf run through `runContained` (bwrap). An unresolved
   conflict is refused with a conflict capsule, and the ledger records it.
4. Run the witness commands (at least one is required) in bwrap on a detached checkout of the merged
   commit. The report is signed with a local Ed25519 key, `$G4A_HOME/witness-ed25519.pem`. The key is
   generated on first start and its public key is pinned in the db. The daemon refuses to start if the key does not match the pin.
5. `git update-ref refs/heads/main NEW OLD` (CAS), retried up to 3 times if main moved.
6. A `promote_intent` entry is written before the CAS and a `promote` entry after it. If the daemon is killed,
   `running` jobs are requeued at the next start. A CAS that already landed is recorded from
   the intent (`recovered: true`) and is not merged a second time.

**Verify.** Verification recomputes every payload hash and the chain, checks each witness signature
(optionally against `--pin`), and requires every witness exit code to be 0.

**Shim wiring.** Inside `*/.g4a/worktrees/*`, write subcommands (commit, push, merge, rebase,
reset, checkout, switch, cherry-pick, am, apply, revert, pull) ask the daemon to `check` them first, with a 500 ms timeout.
The check flags staged files outside the claim, pushes to main, and moving onto main. The default is to warn
(`[g4a] warning:` on stderr plus a ledger entry). `G4A_ENFORCE=1` blocks instead. If the daemon is down, the shim warns
and lets the command run (fail open).

### Phase 1 hardening
- **Merges are never trusted to Mergiraf alone.** When `git merge-tree` reports a conflict, g4a reads the
  `git diff -U0` hunks base→main and base→candidate. If both sides changed the same base lines, or one side
  inserts inside a range the other side changed, the verdict is **REVIEW**. A `promote_review` entry
  records the capsule hash and main is left alone. `a + b + 0` vs `Number(a) + Number(b)`, which Mergiraf
  would merge, is a regression test for this. Mergiraf is tried only after that. If Mergiraf fails and
  every overlap is a pure insertion at the same base point, a union rung keeps both blocks, ours first.
  Adjacent edits are refused.
- **Frozen intents.** When a claim is promoted, its witness commands are frozen in the `intents` table.
  Every later promotion, fast-forwards included, runs the candidate's witnesses plus every frozen intent
  in bwrap on the merged tree. Results are tagged with the owning agents. Verdicts are ADMIT (promote),
  REFUSE (`promote_refused`) and REVIEW (`promote_review`).
- **Ledger anchors outside `$G4A_HOME`.** After every append, the daemon writes two anchors, both
  signed `{repo, seq, entry_hash, counter}`:
  - a commit chain at `refs/g4a/ledger-head` in the repo, advanced by a CAS update-ref;
  - a file at `$G4A_KEY_DIR/anchors/<repo-hash>.json`, which is only ever raised.

  `g4a verify` checks the signature of every anchor and the hash at its seq. It reports truncation,
  rollback, or a missing anchor when entries exist. It also warns when main moved outside the daemon
  (the daemon logs `main_external`). If an anchor is ahead of the db, the daemon refuses to append or
  start (fail closed).
- **Key placement.** The Ed25519 key lives in `$G4A_KEY_DIR`, which defaults to
  `${XDG_CONFIG_HOME:-~/.config}/g4a-keys`. The dir is 0700 and the key 0600. The dir must not be inside
  `$G4A_HOME` or contain it. A Phase 1 key found in `$G4A_HOME` is moved there. The OS keyring is not used.
- **Enforcement by default for agents.** Agents are identified by an agent marker; `G4A_AGENT=0` marks a
  human. In a g4a-managed repo, the daemon checks these git commands: commit, push, merge, rebase, reset,
  checkout, switch, cherry-pick, am, apply, revert, pull, update-ref and branch. The command is blocked
  when it is out of scope, runs outside a claimed worktree, or touches main or `refs/g4a/*`. If the
  daemon is down, agents are blocked with a message that says how to start it. `G4A_ENFORCE=0` is the
  explicit opt-out, and with it these cases only warn. Humans are never checked. Main moves only through
  `g4a promote` (the daemon).
- **No test switches in production.** Crash points are injected through `promote(..., hooks)` and
  `startDaemon(home, { hooks })` by `test/fixtures/crash-daemon.mjs` only.

### Phase 1 limits fixes (Part A)

- **Witness pinning.** On promote, each claim's witness paths (`--witness-path`, or the script files that witness commands execute, tracked on main) are frozen at their blob hashes. A claim that overlaps another agent's frozen or claimed witness paths is refused (`claim_refused`, reason `witness_paths`). If an agent changes its own frozen witness, the result is REVIEW (`witness_modified` / `witness_tamper`). Commands like `npm test` derive no paths; pass `--witness-path` yourself.
- **Opt-out variables in agent contexts.** `G4A_RAW`, `G4A_ENFORCE=0` and `G4A_AGENT=0` are ignored when an agent marker is present. They take effect only with a valid, unexpired override that the operator signed (`g4a operator init`, then `g4a override --repo --minutes --reason --var`). Both commands are human-only: they refuse when an agent marker is set or when stdin is not a TTY. Every attempt is logged as an `opt_out` ledger entry, whether it was honored or not.
- **External anchor witness.** If `G4A_ANCHOR_REMOTE` is set, each anchor is pushed to that remote. `verify --anchor-remote` then compares against it. If `G4A_KEY_PASSPHRASE_FILE` is set, the witness key is stored encrypted.
- **Main checked out.** If main is checked out and clean, it is updated in place after the CAS. If it is dirty, the promote is refused (`main_checked_out_dirty`).
- **Concurrency and SQLite.** Each repo has its own job queue, and different repos run in parallel. If `node:sqlite` is missing, you get a clear error.

**What a same-uid attacker can still do.** The following are not fixed:
- A process running as the same uid can read the operator key unless it is passphrase-protected, and it can read the passphrase file if that file is readable.
- `script` can fake a TTY.
- An anchor remote on the same machine and uid can be rewritten. Real protection needs a remote on another host or uid.
- Such a process can edit the DB or refs directly. Verify and the anchors detect this; they do not prevent it.

### Phase 1 limits (what it still does not do)
- Bypasses remain. An agent can run the real git binary by absolute path, set `G4A_RAW=1` or
  `G4A_ENFORCE=0`, or edit files without git. Claims gate promotion to main, not edits. Closing these
  bypasses is Phase 2's job (the authority repo).
- Anyone who can write both `$G4A_KEY_DIR` and the repo's refs, which is the same local user, can still
  re-sign history. The anchors detect rollback or truncation of the db alone, or the ref alone. They are
  not a defense against a fully compromised local account.
- Agents can edit test files inside their own claim, so a frozen intent is only as strong as the paths
  its witness depends on. Keep witness files out of other agents' claims.
- The union rung is line-based. Witnesses are what reject semantically bad unions, such as a duplicated
  `export const v`, which is tested.
- `update-ref` moves `refs/heads/main` but does not update a checkout of main. Use a bare repo or keep the
  main worktree detached.
- There is one daemon per user, and jobs run serially. `node:sqlite` is experimental in Node 22, so the
  CLI runs it with `--no-warnings`.
