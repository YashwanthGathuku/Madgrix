# g4a in editors (Phase 3)

`g4a mcp` is a stdio MCP server. It exposes six tools:

- `g4a_claim`
- `g4a_status`
- `g4a_promote`
- `g4a_verify`
- `g4a_release`
- `g4a_authority_status`

Each tool runs the real `g4a` CLI as a child process, passing arguments as an argv array with no shell. Values that could be read as flags are rejected. So the server opens **no new route** around the daemon, the authority, permits or the shim. It has exactly the privileges of the editor process that started it. Claim secrets stay in `G4A_HOME` and never appear in tool results.

The repo defaults to `G4A_MCP_REPO` or the server's working directory, which is the workspace for all three editors below. Any tool also takes a `repo` argument.

The daemon has to be running already (`g4a daemon --detach`). If it is not, a tool returns `isError` with a hint.

Replace `/ABS/PATH/TO/Madgrix` in the snippets below.

## Claude Code
Project scope: copy `claude-code.mcp.json` to `<repo>/.mcp.json`. Alternatively:
```sh
claude mcp add g4a --env G4A_AGENT=1 -- node --no-warnings /ABS/PATH/TO/Madgrix/packages/g4a/bin/g4a.mjs mcp
```
For the Bash-tool hook that logs git commands, add the output of `g4a hooks claude` to `.claude/settings.json`.

## Codex CLI
Append `codex.config.toml` to `~/.codex/config.toml`. Alternatively:
```sh
codex mcp add g4a --env G4A_AGENT=1 -- node --no-warnings /ABS/PATH/TO/Madgrix/packages/g4a/bin/g4a.mjs mcp
```
For the hook snippet, see `g4a hooks codex`.

## Cursor
Copy `cursor.mcp.json` to `<repo>/.cursor/mcp.json` for the project, or to `~/.cursor/mcp.json` for every project. Then enable `g4a` under Settings → MCP.

## Suggested agent instructions (AGENTS.md / CLAUDE.md / .cursor/rules)
```
Before editing, call g4a_claim with the files you will touch and a witness (e.g. "npm test").
Edit and commit ONLY inside the returned worktree. When done, call g4a_promote; if it returns
"review" or "refused", report it, do not force it. Never push or commit to main directly.
Call g4a_release when you abandon the task.
```

## Editor source-control (SCM) panels
- **Human context.** The SCM panels in VS Code and Cursor run git as you, with no agent marker, so the shim neither blocks nor rewrites them. Commits you make there are human commits, just as in a terminal.
- **Agent worktrees.** Open the agent's worktree (`<repo>/.g4a/worktrees/<agent>`) as its own folder, or add it via *File → Add Folder to Workspace*. The SCM panel then shows that agent's branch and diff. Review there, and let `g4a_promote` land it. Do not use *Sync*, *Push* or *Merge* to main from the panel: in system mode the authority refuses direct writes to main anyway, and in same-user mode a direct write shows up in `g4a verify` / `g4a authority audit` as a violation.
- **Shim logging for the editor's git.** To have it logged, set `"git.path": "<G4A_HOME>/bin/git"`. `G4A_HOME` defaults to `~/.g4a`, and `g4a install` creates the shim. This only affects logging and stats, because humans are not enforced.
- **Agent terminals inside the editor** inherit `G4A_AGENT` (or `CLAUDECODE` / `CODEX_*`) and are enforced by the shim. The `G4A_AGENT=1` set in the MCP snippets applies only to the MCP server's child processes.

## Limits
- The server is local and stdio only, with no HTTP or SSE transport and no auth layer. Anything that can start it can already run `g4a`.
- Tools run under the editor's uid. Agent names are bound to a uid and a per-agent credential. Set `G4A_MCP_SESSION_CREDENTIALS=1` to keep the credential in server memory only; it is never returned to the model. A same-uid process can still read the default file store or the server's memory.
- `g4a_promote` waits for witnesses and sends `notifications/progress` when the client provides a progressToken. It honours `notifications/cancelled`. The default timeout is 600 s (`G4A_MCP_TIMEOUT_MS`), and editors may impose shorter tool timeouts of their own. Use `no_wait` and poll `g4a_status` in that case. Cancelling or a timeout does not stop a promote the daemon already queued.
- Live handshakes passed: `claude mcp list` (Claude Code 2.1.311), Codex 0.164.0 (`initialize` + `tools/list` before an unauthenticated model call), and `cursor-agent mcp list-tools g4a`. Tool calls driven by a model were not run, because that needs a login or API key. Project-scope configs in Claude Code and Cursor need approving once (`cursor-agent mcp enable g4a`).
