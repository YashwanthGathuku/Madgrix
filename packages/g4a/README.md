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
