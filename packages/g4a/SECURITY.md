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
  - Log, tee, credential and pid writes use `O_NOFOLLOW`, so a planted symlink at the target
    fails the write instead of redirecting it.
  - `G4A_HOME` and its subdirectories must be real directories owned by the current uid.
  - Temp dirs come from `mkdtemp` (`0700`).
  - Nonce files are created with `wx`.
- **Shell injection in generated hooks.** Authority hook wrappers single-quote every path. The
  old double quotes allowed `$()` and backticks to run.
- **Claim input traversal.** Absolute paths, `~` paths and `..` segments are refused in claim
  paths and witness paths. Agent names must match `[A-Za-z0-9._-]{1,64}`, which is also what
  makes `credentials/<hash>/<agent>` safe.
- **Secrets in the signed ledger.** Witness commands that look like they contain a secret are
  refused at claim time.
- **Environment leakage to children.**
  - Witness and resolver (mergiraf) children get a minimal environment (`PATH`, `HOME`) inside a
    sandbox where one is available.
  - The system installer strips `SUDO_*`.
  - Control-plane git calls go through `safeGit`, which takes an argv array and never a shell.
- **Error and stack leakage.**
  - The CLI prints only the redacted error message.
  - Stack traces are shown only with `G4A_DEBUG=1`, and they are redacted too.
  - Daemon, authority and MCP errors are redacted before they are returned or stored.

## Detected only (not prevented)

- **Detect-only mode** (`g4a authority init DIR`, same uid). An agent running as your uid can
  edit the db, the keys and the hooks. Tampering shows up when `g4a verify` checks the ledger
  chain against the pinned key or an external anchor remote. It is not stopped.
- **Bypassing the git shim.** Agents can call the real git by absolute path. The shim only
  intercepts git through `PATH`. Only system-mode push enforcement stops a bad land.
- **Purging telemetry.** Any process running as your uid can delete or edit `G4A_HOME` logs.
  They are a convenience record, not evidence. The ledger and anchors are the evidence.

## Known gaps and risks

- Redaction is pattern-based (see PRIVACY.md). Tee files hold raw git output, which can include
  diff content and therefore source code.
- Paths, cwd and worktree paths are stored as they are, so usernames in home paths are kept.
- The daemon db and ledger have no retention limit.
- The system installer briefly makes a seed bundle world-readable (`0755` tmp dir, `0644` bundle)
  so the authority uid can read it during `init --system`. It is deleted straight afterwards.
- g4a has no runtime npm dependencies. It uses only `node:` builtins, plus `better-sqlite3` when
  available (optional). `npm audit` findings in the repo root affect development tooling only:
  vite, wrangler/miniflare, sharp, undici and zod. g4a does not load any of them at runtime.

## Reporting

Report vulnerabilities privately to the repository owner through a GitHub security advisory on
YashwanthGathuku/Madgrix. Do not open a public issue.
