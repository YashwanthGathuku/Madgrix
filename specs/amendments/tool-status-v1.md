# Spec amendment: tool-status-v1 — the agent's machine-readable tool log

**Status:** proposed · **Date:** 2026-10-02
**Affects:** `PROMOTION_PROTOCOL.md` (FROZEN-v1) §6, the `valid_tool_states` and
`provenance_complete` rows. This amendment defines the receipt format those rows
require, where the evaluation domain reads it, and how both gates are decided. It is
changed via this amendment file only; spec files are NOT edited. Companion:
`evidence-integrity-v1.md`.

## (1) The invariants (quoted from the specs)

`PROMOTION_PROTOCOL.md` §6 (FROZEN-v1):

> "`valid_tool_states` | Every claimed tool action carries a machine-readable
> receipt with a named status (`OK`/`FAILED`/…); narration without receipts →
> fail."
>
> "`provenance_complete` | Agent identity, model, harness version, and fork lineage
> are present and well-formed."
>
> "Gates MUST be evaluated by the **control plane**, never by the contender or by
> model judgment."

`EVALUATION_THREAT_MODEL.md` §6 (FROZEN):

> "2. Candidate fabricates tool success (claims OK without receipts) → admission
> gate `valid_tool_states` fails → REJECT."

## (2) What the implementation violated

`scripts/evaluate-candidate.ts` set `valid_tool_states: true` for every candidate. Its
comment called this "mechanical" because the evaluator had fetched the candidate
itself, but no receipt from the agent was read, so a candidate with no receipts
passed. `provenance_complete` was `Boolean(MADGRIX_MODEL_NAME && harnessVersion)`,
two values from the evaluator's own environment. That is the same for every
candidate and says nothing about the agent that produced any of them.

## (3) The tool-status log, v1

**Location.** `.madgrix/tool-status.jsonl` at the root of the candidate tree,
committed in the candidate commit. The agent command writes it into its workspace,
and `scripts/run-contenders.mjs` commits the workspace (`git add -A`). It must be a
regular file (not a symlink) of at most 1 MiB, UTF-8 JSON Lines: one JSON object per
line, separated by `\n`. The final newline is optional and blank lines are invalid.

**Line 1, the session record:**

```json
{"format":"madgrix-tool-status/v1","task_id":"task_5f…","contender_id":"contender-2","agent_id":"agent-b","baseline_commit":"a6f4…","model":"claude-opus-x","harness":"claude-code/2.1.0"}
```

| Member | Rule |
|---|---|
| `format` | exactly `madgrix-tool-status/v1` |
| `task_id`, `contender_id`, `agent_id`, `baseline_commit` | the values of `MADGRIX_TASK_ID`, `MADGRIX_CONTENDER_ID`, `MADGRIX_AGENT_ID` and `MADGRIX_BASELINE_SHA`, which `run-contenders.mjs` gives the agent command |
| `model` | the model id the agent used; matches `^[A-Za-z0-9][A-Za-z0-9._:@/+[\]-]{0,127}$` (brackets admit context suffixes such as `[1m]`) |
| `harness` | the agent harness and its version; same pattern |

**Lines 2…n, one action record per tool action, in order:**

```json
{"seq":1,"action":"edit_file","tool_status":"OK"}
{"seq":2,"action":"run_tests","tool_status":"FAILED(nonzero_exit)"}
{"seq":3,"action":"run_tests","tool_status":"OK"}
```

| Member | Rule |
|---|---|
| `seq` | 1, 2, 3, … with no gaps |
| `action` | the tool's name: a non-empty string of at most 200 characters |
| `tool_status` | `OK`, or `FAILED(<category>)` with `<category>` matching `^[a-z][a-z0-9_.-]{0,63}$` (for example `timeout`, `nonzero_exit`, `permission_denied`) |

Other members (`detail`, `ts`, …) are allowed in both kinds of record and ignored.

**Binding.** The evaluator compares the session record with its own run: the task it
evaluates, the contender it evaluates, the agent the authority bound to that
contender (`agent_id` from `POST /tasks/:id/evaluator-credentials`), and the task's
baseline commit. A log from another task or contender, or one left over from an
earlier promotion, fails the comparison.

**`valid_tool_states`** passes when the log exists and parses, the session record
has the v1 format and is bound to this run, there is at least one action record, and
every action record is well-formed. A `FAILED(…)` action is a valid receipt: the gate
checks that receipts exist and name a status, not that the tools succeeded. The
hidden and regression suites judge the result.

**`provenance_complete`** passes when the session record is bound to this run, its
`model` and `harness` are well-formed, and the authority's fork lineage for the
contender names a parent repository and the task's baseline commit. Agent identity
is the bound `agent_id`. Model and harness version come from the log. Fork lineage
comes from the authority. No environment variable supplies any of them: the
evaluator no longer reads `MADGRIX_MODEL_NAME`, and `live-e2e.ts` no longer requires
or forwards it.

**Scope and run directory.** The log path is exempt from the scope and tamper rules
(`evidence-integrity-v1.md`) and is never copied into the directory the evaluation
commands run in. Promotion ships the candidate commit unchanged, so the promoted
tree carries the winner's log. A later task's agent overwrites it, and a stale copy
fails the binding.

The evaluator's result JSON reports `tool_status: { actions, errors }` and
`provenance: { agent_id, model, harness, evaluator_harness_version }`. The bundle
schema is unchanged.

## Claude Code adapter

`scripts/adapters/claude-code-tool-log.mjs` writes this log for Claude Code. It reads
the JSON-lines output of `claude -p ... --output-format stream-json --verbose` and
passes it through unchanged. The session record's `model` and `harness`
(`claude-code/<version>`) come from the stream's `system`/`init` event. There is one
action record per `tool_use`, in order: `OK`, `FAILED(tool_error)` when its
`tool_result` has `is_error`, or `FAILED(no_result)` when no result arrived. Only
tool names are logged, never inputs or outputs.

```
MADGRIX_AGENT_COMMAND='set -o pipefail; claude -p "$(cat /srv/task.md)" --output-format stream-json --verbose --permission-mode acceptEdits | node /srv/madgrix/scripts/adapters/claude-code-tool-log.mjs'
MADGRIX_AGENT_ENV_ALLOWLIST=ANTHROPIC_API_KEY
```

The message shapes were read from the installed package
(`@anthropic-ai/claude-code` 2.1.42, `cli.js`). The tests drive the adapter with
transcripts of those shapes and a stand-in `claude`; no live Claude Code run was
made.

## Not claimed

- The agent's harness writes the log inside the contender zone. The evaluator can
  check that receipts exist, are well-formed, and belong to this task, contender,
  agent and baseline. It cannot show that the listed actions happened, that their
  statuses are true, or that the named model produced the change. Spec 1 §9.5
  "mechanically proven tool-status fabrication" needs an independent record of the
  agent's actions, for example one written by the runner or the model provider,
  which v1 does not have.
- The log is not signed. Its integrity rests on the candidate commit: it is part of
  the tree that `tree_sha256` and the permit bind.
- Common coding-agent CLIs do not write this format. The agent command (or a wrapper
  around the agent) has to.

Implementation notes: `src/lib/eval-gates.ts` (`checkToolStatusLog`,
`evaluatorGates`), `scripts/evaluate-candidate.ts`, `scripts/run-contenders.mjs`,
`scripts/live-e2e.ts`, `src/worker/index.ts` (`handleEvaluatorCredentials`). Tests:
`test/eval-gates.test.ts`, `test/evaluator-isolation.test.ts`,
`test/env-isolation.test.ts` (its agent command writes a v1 log, and the full
`live-e2e.ts` run admits only candidates whose log passes both gates).
