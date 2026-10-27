# g4a privacy

g4a runs locally. It sends no telemetry anywhere. The only network traffic it creates is git
traffic that you configure yourself, such as an optional `G4A_ANCHOR_REMOTE` push of ledger-head
anchors. Everything below is stored on the local disk. Run `g4a privacy` to list what exists on
your machine (paths, sizes and modes, never contents). Run `g4a purge` to delete it.

## What is stored, where, and for how long

`G4A_HOME` defaults to `~/.g4a`. The directory is created `0700`, and g4a refuses to use it if it
is a symlink or is owned by another uid. Key directories with a symlinked parent, and private
files with more than one hardlink, are refused rather than written.

| Data | Location | Contents | Mode | Retention |
|---|---|---|---|---|
| Usage log | `G4A_HOME/log.jsonl` (+ `.1`, `.2`) | One line per intercepted git call: event, timestamp, cwd, subcommand, git argv, agent marker, token estimates. Each hook event also adds the session id, tool name and command string. | 0600 | Rotates at `G4A_LOG_MAX_BYTES` (default 5 MiB) and keeps `G4A_LOG_KEEP` old files (default 2). Total cap is about 15 MiB. |
| Tee files | `G4A_HOME/tee/*.txt` | The full git output behind a compacted summary, kept so the agent can read what was cut. | dir 0700, files 0600 | Pruned on every write to the newest `G4A_TEE_MAX_FILES` (default 200), dropping files older than `G4A_TEE_MAX_AGE_DAYS` (default 7). `G4A_TEE=0` turns tee off. |
| Agent credentials | `G4A_HOME/credentials/<repo-hash>/<agent>` | Random per-agent authority credential. Not stored when the MCP client or CLI uses session credentials. | dir 0700, file 0600 | Until `g4a purge --credentials`. It is kept across claims, because the agent binding persists. |
| Promote secrets (detect-only mode) | `G4A_HOME/secrets/<claim-id>` | Random per-claim secret the daemon checks on promote. | dir 0700, file 0600 (`O_NOFOLLOW`) | Kept with the daemon db; removed with `G4A_HOME`. Not touched by `g4a purge`. |
| Daemon state (detect-only mode) | `G4A_HOME/g4a.db` (+ WAL/SHM), `g4a.sock`, `g4a.pid`, witness key | Claims: agent name, claimed path globs, witness commands, worktree paths, branch names, commit SHAs. Also intents, jobs (result JSON, redacted) and the signed ledger. | 0600 (socket 0600) | Indefinite. This is the audit trail. |
| Agent users (system mode) | `/var/lib/g4a-agents/<name>/`: `repo/` (clone), `.g4a/` (log, tee, daemon db, credential); `/etc/g4a/agents.json`; `/etc/sudoers.d/g4a-agents`; authority `state/os-agents.json` | The same per-agent data as above, owned by `g4a-a-<name>`. Name, uid, home and operator in the maps, plus one sudoers line per agent. | home 0700, credential 0600; maps and sudoers root-owned (sudoers 0440) | Until `g4a agent remove <name>` or `authority uninstall`, which delete all of it. |
| Authority root (system or detect-only) | `/var/lib/g4a` or `DIR`: `state/`, `keys/`, `nonces/`, `accepted.jsonl` | Signed ledger, agent-to-uid bindings and credential hashes, accepted-push log (agent, uid, ref, old/new SHA, time), signing keys. | dirs 0700, owned by the authority user | Indefinite. Remove it with `g4a authority uninstall`. |

Some data is never stored: commit message bodies, file contents (except git output inside tee
files), environment variables, and witness command output. Witness runs record only the exit
status, signal, timeout and sandbox kind.

## Minimisation and redaction

Every log and tee write and every daemon job result passes through `src/privacy.mjs`, as do the
error messages shown by the CLI, the daemon and the authority, and all MCP tool output.

- **Redacted:** GitHub, GitLab, Slack, OpenAI/Anthropic, AWS, Google and npm token shapes; JWTs;
  `Authorization:`, `Bearer` and `Basic` headers; `scheme://user:pass@` and `scheme://token@`
  URLs of any length (also inside `url.<base>.insteadOf` config; a bare `ssh://git@` is kept); `*_TOKEN=`, `*password=`, `*secret=` and `*api_key=` style assignments; and PEM
  private-key blocks.
- **Minimised git argv:** values given with `-m`, `--message`, `-F`, `--file` and `--template`
  are replaced by `[N chars]`, in every form: separate (`-m X`), attached (`-mX`,
  `--message=X`) and combined short flags (`-qm X`, `-am X`, `-qmX`). `--trailer` values
  (`--trailer K: V`, `--trailer=K: V`) are minimised too. Search content
  (`--grep`, `-S`, `-G`) is minimised the same way. A `-c` value whose key looks like a header, token or credential is redacted.
- **`G4A_LOG_ARGV=0`:** stores no argv and no hook command string at all.
- **`G4A_REDACT_EMAILS=1`:** also replaces email addresses. This is off by default because git
  identities are often useful in a local log.
- **Not redacted:** paths and cwd. Usernames that appear in paths, such as `/home/alice`, stay as
  they are.

Redaction is pattern-based. It catches common secret formats, but it cannot catch every secret.
An arbitrary string that happens to be a password, written without a recognisable key or prefix,
will be stored.

## The ledger cannot be redacted afterwards

The claim ledger is hash-chained and signed, so changing an entry would break verification. To
keep secrets out of it, `claim` refuses:

- any witness command that contains something that looks like a secret (pass secrets to
  witnesses through the environment instead);
- witness commands that pass credentials (`-u`/`--user user:pass`, any `-H` header outside a
  short plain-header allowlist, glued `-Hname:` included, `--oauth2-bearer`, `-b`/`--cookie`,
  `mysql`-family `-pX`/`--password`, `sshpass -p`, any `--password=`);
- claim or witness paths that are absolute, start with `~`, contain `..`, control characters,
  newlines or non-ASCII characters, use pathspec magic (a leading `:`), or point into `.git/` or
  `.g4a/`.

With agent OS users (`g4a agent add`, the default for system mode), each agent's credential and
logs sit in its own `0700` home, out of reach of other agents. If you run agents as one shared
uid instead, `G4A_HOME/credentials/` keeps them apart in name only; see SECURITY.md.

## Deleting data

```
g4a privacy                       # inventory: paths, sizes, modes, warnings for loose permissions
g4a purge --logs | --tee | --credentials | --all
```

`purge` deletes local telemetry only. It does not touch the daemon db, the ledger or any authority
root, because they are the audit trail. Stop the daemon and delete `G4A_HOME`, or run
`g4a authority uninstall`, to remove them.
