# g4a security notes

This file covers what g4a prevents, what it only detects, and the known gaps. For what is stored,
see PRIVACY.md.

## Prevented (enforced by code, covered by tests)

- **Lands outside a claim (system mode only).** The authority runs as a separate uid. Its
  pre-receive hook refuses pushes to `main` that lack a valid signed permit. An agent uid cannot
  read the signing keys (`0700` directories owned by the authority user).
- **Local file exposure.**
  - `G4A_HOME`, `tee/` and `credentials/` are `0700`.
  - The log, tee files, credentials, pid file and daemon db/WAL/SHM are `0600` whatever the umask.
  - The daemon socket is created under umask `0177` and then chmodded to `0600`.
  - Existing files with loose modes are tightened on the next write.
- **Symlink and TOCTOU attacks on g4a-owned paths.**
  - Log, tee, credential, pid, promote-secret and key-dir writes (witness and operator keys and
    their `.pub.hex`, anchors, overrides) use `O_NOFOLLOW` plus an owner check, so a planted
    symlink at the target fails the write instead of redirecting it.
  - `G4A_KEY_DIR` and its `anchors/` and `overrides/` subdirectories must be real directories
    owned by the current uid; a symlinked key dir is refused.
  - `G4A_HOME` and its subdirectories must be real directories owned by the current uid.
  - Temp dirs come from `mkdtemp` (`0700`). The system installer's seed bundle is `0600` in a
    `0700` dir, owned only by the authority user, and removed on success, failure, exit or signal.
  - Nonce files are created with `wx`.
- **Shell injection in generated hooks.** Authority hook wrappers single-quote every path. The
  old double quotes allowed `$()` and backticks to run.
- **Claim input traversal and hygiene.** Absolute paths, `~` paths and `..` segments are refused
  in claim paths and witness paths, as are control characters and newlines, non-ASCII
  characters (fullwidth dots and other lookalikes), pathspec magic (a leading `:`), a leading
  `-`, `.` segments, and anything under `.git/` or `.g4a/`. Claim overlap is checked
  case-insensitively as well, so `A.TXT` collides with `a.txt`. Agent names must match `[A-Za-z0-9._-]{1,64}`, which is also what
  makes `credentials/<hash>/<agent>` safe.
- **Secrets in the signed ledger.** Witness commands that look like they contain a secret are
  refused at claim time, including credentials passed to curl-style tools (`-u`/`--user
  user:pass`, `-H`/`--header` with an auth-, token-, key-, secret- or cookie-like name,
  `--oauth2-bearer`, `--cookie`) and `scheme://token@` URLs of any length.
- **Shim scope enforcement in an agent context** (git reached through `PATH`).
  - Every git global option is parsed (`-C`, `-c`, `--config-env`, `--git-dir`,
    `--work-tree`, `--exec-path`, `-p`/`--paginate`, `--no-advice`, the pathspec flags and the
    rest). An option git itself would reject is blocked: the shim fails closed.
  - The repo checked is the one git will act on: cumulative `-C`, `--git-dir`/`--work-tree` and
    `GIT_DIR`/`GIT_WORK_TREE`, so running from outside the worktree with `-C` is still checked.
  - In a g4a-managed repo, agents may not override `core.hooksPath`, `core.logAllRefUpdates`,
    `core.fsmonitor`, `core.worktree`, `core.sshCommand`, `alias.*`, `include.*` or
    `includeIf.*`, whether through `-c`, `--config-env`, `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`,
    `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM`, or `git config` writes.
    `--exec-path`/`GIT_EXEC_PATH` are refused; so are `--git-dir`/`--work-tree` (and the `GIT_DIR`
    family) on writes, and `GIT_INDEX_FILE` on commits.
  - Aliases from git config are resolved and the expanded command is checked. Shell (`!`)
    aliases run their own `git` calls, which re-enter the shim and are checked there.
  - Write subcommands include tag, stash, notes, symbolic-ref, replace, commit-tree, worktree,
    rm, mv, restore, clean, reflog expire/delete, update-index, read-tree and filter-branch, as
    well as commit, push, merge, rebase, reset, checkout, switch, cherry-pick, am, apply, revert,
    pull, update-ref and branch. Read forms (`tag -l`, `stash list`, `worktree list`) are not.
  - The daemon gets the parsed subcommand and arguments; commit pathspecs (`git commit -m x
    b.txt`), `update-ref --stdin`, `symbolic-ref` onto main and `git replace` are checked too.
  - An operator-signed `G4A_ENFORCE` override turns these blocks into warnings.
- **Environment leakage to children.**
  - Witness and resolver (mergiraf) children get a minimal environment (`PATH`, `HOME`) inside a
    sandbox where one is available.
  - The system installer strips `SUDO_*`.
  - Control-plane git calls go through `safeGit`, which takes an argv array and never a shell.
- **Error and stack leakage.**
  - The CLI prints only the redacted error message.
  - Stack traces are shown only with `G4A_DEBUG=1`, and they are redacted too.
  - Daemon, authority and MCP errors are redacted before they are returned or stored.

## Agent OS users (default for system mode)

To set an agent up, run `g4a agent add <name>` once as the operator. You need passwordless sudo,
and the repo must already be under a system authority. The command:

- creates a non-sudo system user `g4a-a-<name>` with a private `0700` home at
  `/var/lib/g4a-agents/<name>`;
- gives that user its own clone of authority main at `~/repo`, so there are no shared worktrees
  and no group permissions to manage, plus its own `G4A_HOME`, shim and daemon;
- writes a `0600` credential owned by the agent user, inside a `0700` directory;
- binds name→uid at the authority (root-only `os-bind`).

`g4a run --agent <name> -- <cmd>` starts the command as that user. It goes through a single
sudoers rule, `<operator> ALL=(g4a-a-<name>) NOPASSWD: /usr/local/lib/g4a/bin/g4a-agent-exec`,
which `visudo` checks. The rule uses `env_reset`, and only a short allowlist of variables is kept.

Once a repo has agent users, claim, permit, land and release are refused for the operator uid,
and for any uid acting under another agent's name. The operator can turn this back on with
`g4a agent policy --allow-operator on`. Agent writes through the shim started as the operator are
refused too, and both `g4a run` and the launcher refuse root.

Each agent also anchors its client ledger under its own `refs/g4a/client-ledgers/<name>`, and
only the bound uid may append to that ref.

`g4a agent remove <name>` cleans up completely:

- kills the agent's processes;
- releases its claim and deletes its ref;
- unbinds it at the authority;
- removes its sudoers line, crontab, user, group and home;
- deletes its files in `/tmp`, `/var/tmp` and `/dev/shm`.

`authority uninstall` removes every agent first. test/system.test.mjs covers all of this: two
agents can't read each other's credential or home, can't write each other's worktree or anchor,
and can't impersonate each other; the launcher can't escalate and doesn't evaluate arguments; and
removal leaves nothing behind.

## Detected only (not prevented)

- **Detect-only mode** (`g4a authority init DIR`, same uid). An agent running as your uid can
  edit the db, the keys and the hooks. Tampering shows up when `g4a verify` checks the ledger
  chain against the pinned key or an external anchor remote. It is not stopped.
- **Bypassing the git shim.** Agents can call the real git by absolute path. The shim only
  intercepts git through `PATH`. Only system-mode push enforcement stops a bad land.
- **Disabling the local ref guard.** The reference-transaction hook (`src/refguard.mjs`) only
  stops git CLI calls that run hooks. The shim refuses `core.hooksPath` overrides for agents, but
  the real git by absolute path with `-c core.hooksPath=/dev/null`, libgit2/JGit/isomorphic-git,
  or writing `.git/refs` directly can still move local `main`. `g4a verify` reports it (local main
  differs from the authority, reflog entries not written by g4a), and system mode refuses the
  land.
- **Purging telemetry.** Any process running as your uid can delete or edit `G4A_HOME` logs.
  They are a convenience record, not evidence. The ledger and anchors are the evidence.

## Known gaps and risks

- **Same-uid agents are not isolated from each other.** This is why one OS user per agent is now
  the default for system mode (see "Agent OS users" below). If you still run several agents as
  your own uid, the per-agent credential in `G4A_HOME/credentials/<hash>/<agent>` is a `0600`
  file that every process running as your uid can read. Any of them can then release or promote
  another agent's claim. `G4A_MCP_SESSION_CREDENTIALS=1` narrows this but does not close it:
  ptrace and `/proc` are still open to same-uid processes.
- **Limits of agent OS users:**
  - The operator account still has sudo. It installs, adds and removes agents, so anything
    running as the operator can do the same, and agents must never run as the operator.
  - The launcher's `env_keep` allowlist passes `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and
    `GEMINI_API_KEY` to the agent, so each agent sees the key you launch it with.
  - `no_new_privs` cannot be set, because agents need sudo to reach the authority wrappers.
  - Agent CLIs (Codex, Claude Code, …) need their own login inside the agent home, and their
    binaries must be readable by the agent user. A `0700` operator home hides them.
  - A witness command runs as `g4a-authority`, unsandboxed where bwrap is unavailable. It could
    therefore write `state/os-agents.json` directly. This is the same exposure as the existing
    witness and `init-root` risk.
  - Detect-only (same-user) mode still only detects.

- Redaction is pattern-based (see PRIVACY.md). Tee files hold raw git output, which can include
  diff content and therefore source code.
- Paths, cwd and worktree paths are stored as they are, so usernames in home paths are kept.
- The daemon db and ledger have no retention limit.
- g4a has no runtime npm dependencies. It uses only `node:` builtins, plus `better-sqlite3` when
  available (optional). `npm audit` findings in the repo root affect development tooling only:
  vite, wrangler/miniflare, sharp, undici and zod. g4a does not load any of them at runtime.

## Reporting

Report vulnerabilities privately to the repository owner through a GitHub security advisory on
YashwanthGathuku/Madgrix. Do not open a public issue.
