#!/usr/bin/env node
/**
 * Tool-status log adapter for Claude Code (specs/amendments/tool-status-v1.md).
 *
 * Pipe the JSON-lines output of
 *
 *   claude -p "<task>" --output-format stream-json --verbose
 *
 * into this script inside a contender workspace. The stream passes through to
 * stdout unchanged, and the script writes .madgrix/tool-status.jsonl:
 *
 * - the session record: the run's MADGRIX_TASK_ID, MADGRIX_CONTENDER_ID,
 *   MADGRIX_AGENT_ID and MADGRIX_BASELINE_SHA, and from the stream's
 *   system/init event the `model` and `claude_code_version`
 *   (harness `claude-code/<version>`);
 * - one action record per tool_use, in order: OK, FAILED(tool_error) when its
 *   tool_result has is_error, FAILED(no_result) when none arrived.
 *
 * Tool inputs and outputs are not copied into the log, only tool names.
 *
 * As MADGRIX_AGENT_COMMAND (run-contenders.mjs runs it under bash -c with the
 * workspace as cwd):
 *
 *   set -o pipefail; claude -p "$(cat /srv/task.md)" --output-format stream-json \
 *     --verbose --permission-mode acceptEdits \
 *     | node /srv/madgrix/scripts/adapters/claude-code-tool-log.mjs
 *
 * with MADGRIX_AGENT_ENV_ALLOWLIST=ANTHROPIC_API_KEY for the agent's own key.
 * `set -o pipefail` keeps claude's own exit status.
 *
 * Exit 2 without the MADGRIX_* identifiers (not a contender run); exit 1, with
 * nothing written, when the stream has no system/init event.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

const run = {
	task_id: process.env.MADGRIX_TASK_ID,
	contender_id: process.env.MADGRIX_CONTENDER_ID,
	agent_id: process.env.MADGRIX_AGENT_ID,
	baseline_commit: process.env.MADGRIX_BASELINE_SHA,
};
const missing = Object.entries({
	MADGRIX_TASK_ID: run.task_id,
	MADGRIX_CONTENDER_ID: run.contender_id,
	MADGRIX_AGENT_ID: run.agent_id,
	MADGRIX_BASELINE_SHA: run.baseline_commit,
})
	.filter(([, value]) => !value)
	.map(([name]) => name);
if (missing.length) {
	console.error(
		`claude-code-tool-log: missing ${missing.join(", ")}; run it inside the agent command of scripts/run-contenders.mjs`,
	);
	process.exit(2);
}

/** @type {{ model: string, version: string } | null} */
let session = null;
/** @type {Array<{ id: string, name: string }>} */
const uses = [];
/** tool_use id → the tool_result's is_error. @type {Map<string, boolean>} */
const results = new Map();

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
	process.stdout.write(`${line}\n`);
	/** @type {any} */
	let event;
	try {
		event = JSON.parse(line);
	} catch {
		continue;
	}
	if (event === null || typeof event !== "object") continue;
	if (event.type === "system" && event.subtype === "init" && session === null) {
		session = {
			model: typeof event.model === "string" ? event.model : "",
			version: typeof event.claude_code_version === "string" ? event.claude_code_version : "",
		};
	}
	const content = event.message?.content;
	if (!Array.isArray(content)) continue;
	for (const block of content) {
		if (event.type === "assistant" && block?.type === "tool_use" && typeof block.id === "string") {
			uses.push({ id: block.id, name: typeof block.name === "string" ? block.name : "" });
		}
		if (event.type === "user" && block?.type === "tool_result" && typeof block.tool_use_id === "string") {
			results.set(block.tool_use_id, block.is_error === true);
		}
	}
}

if (session === null) {
	console.error(
		"claude-code-tool-log: no system/init event in the input; pipe in " +
			"`claude -p ... --output-format stream-json --verbose`",
	);
	process.exit(1);
}

const records = [
	{
		format: "madgrix-tool-status/v1",
		...run,
		model: session.model,
		harness: session.version ? `claude-code/${session.version}` : "claude-code",
	},
	...uses.map((use, i) => ({
		seq: i + 1,
		action: use.name,
		tool_status: !results.has(use.id) ? "FAILED(no_result)" : results.get(use.id) ? "FAILED(tool_error)" : "OK",
	})),
];
const file = path.join(process.env.MADGRIX_WORKSPACE || process.cwd(), ".madgrix", "tool-status.jsonl");
await mkdir(path.dirname(file), { recursive: true });
await writeFile(file, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
