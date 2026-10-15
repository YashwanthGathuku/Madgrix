/**
 * scripts/adapters/claude-code-tool-log.mjs: turns the JSON-lines output of
 * `claude -p --output-format stream-json --verbose` into the tool-status log
 * the evaluator reads (specs/amendments/tool-status-v1.md).
 *
 * The transcripts below use the message shapes the installed Claude Code
 * package emits (@anthropic-ai/claude-code 2.1.42, cli.js): a system/init
 * message carrying `model` and `claude_code_version`, assistant messages
 * whose content holds tool_use blocks, user messages whose content holds
 * tool_result blocks (`is_error` when the tool failed), and a final result
 * message. No model is called.
 *
 * node --test test/claude-code-adapter.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { TOOL_STATUS_LOG_PATH, checkToolStatusLog } from "../src/lib/eval-gates.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ADAPTER = path.join(REPO_ROOT, "scripts", "adapters", "claude-code-tool-log.mjs");
const RUN = {
	task_id: `task_${"c".repeat(24)}`,
	contender_id: "contender-7",
	agent_id: "agent-c",
	baseline_commit: "b".repeat(40),
};

const init = {
	type: "system",
	subtype: "init",
	cwd: "/workspace",
	session_id: "session-1",
	tools: ["Bash", "Edit", "Read"],
	mcp_servers: [],
	model: "claude-opus-test-1[1m]",
	permissionMode: "acceptEdits",
	slash_commands: [],
	apiKeySource: "ANTHROPIC_API_KEY",
	betas: [],
	claude_code_version: "2.1.42",
	output_style: "default",
	agents: [],
	skills: [],
	plugins: [],
	uuid: "u0",
};

function assistant(uuid: string, ...content: unknown[]) {
	return {
		type: "assistant",
		message: { id: `msg-${uuid}`, type: "message", role: "assistant", model: init.model, content },
		parent_tool_use_id: null,
		session_id: "session-1",
		uuid,
	};
}

function toolResults(uuid: string, ...content: unknown[]) {
	return { type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: "session-1", uuid };
}

const TRANSCRIPT = [
	init,
	assistant("u1", { type: "text", text: "Fixing sum." }, { type: "tool_use", id: "toolu_1", name: "Edit", input: { file_path: "src/sum.js" } }),
	toolResults("u2", { type: "tool_result", tool_use_id: "toolu_1", content: "The file has been updated." }),
	assistant("u3", { type: "tool_use", id: "toolu_2", name: "Bash", input: { command: "npm test" } }),
	toolResults("u4", { type: "tool_result", tool_use_id: "toolu_2", content: "1 failing", is_error: true }),
	assistant("u5", { type: "tool_use", id: "toolu_3", name: "Bash", input: { command: "npm test" } }),
	{ type: "result", subtype: "error_max_turns", is_error: true, num_turns: 3, session_id: "session-1" },
];

function runAdapter(stdin: string, cwd: string, env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [ADAPTER], { cwd, env: { PATH: process.env.PATH ?? "", ...env }, stdio: ["pipe", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (b) => (stdout += b));
		child.stderr.on("data", (b) => (stderr += b));
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout, stderr }));
		child.stdin.end(stdin);
	});
}

const runEnv = {
	MADGRIX_TASK_ID: RUN.task_id,
	MADGRIX_CONTENDER_ID: RUN.contender_id,
	MADGRIX_AGENT_ID: RUN.agent_id,
	MADGRIX_BASELINE_SHA: RUN.baseline_commit,
};

describe("Claude Code stream-json → tool-status log", () => {
	it("writes a v1 log the evaluator accepts: model and harness from the init event, one receipt per tool use", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "madgrix-adapter-"));
		try {
			const stream = TRANSCRIPT.map((m) => JSON.stringify(m)).join("\n") + "\n";
			const run = await runAdapter(stream, dir, runEnv);
			assert.equal(run.code, 0, run.stderr);
			assert.equal(run.stdout, stream, "the stream passes through unchanged");

			const text = await readFile(path.join(dir, TOOL_STATUS_LOG_PATH), "utf8");
			const records = text.trim().split("\n").map((line) => JSON.parse(line));
			assert.deepEqual(records.slice(1), [
				{ seq: 1, action: "Edit", tool_status: "OK" },
				{ seq: 2, action: "Bash", tool_status: "FAILED(tool_error)" },
				{ seq: 3, action: "Bash", tool_status: "FAILED(no_result)" },
			]);
			assert.deepEqual(checkToolStatusLog({ text }, RUN), {
				receipts_valid: true,
				session: { agent_id: "agent-c", model: "claude-opus-test-1[1m]", harness: "claude-code/2.1.42" },
				actions: 3,
				errors: [],
			});
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("without a system/init event (not stream-json output) it writes no log and exits non-zero", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "madgrix-adapter-"));
		try {
			const run = await runAdapter("plain text output\n", dir, runEnv);
			assert.notEqual(run.code, 0);
			assert.match(run.stderr, /system\/init/);
			await assert.rejects(stat(path.join(dir, TOOL_STATUS_LOG_PATH)), "no log written");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("refuses to run outside a contender run (no MADGRIX_* identifiers)", async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), "madgrix-adapter-"));
		try {
			const run = await runAdapter(JSON.stringify(init) + "\n", dir, {});
			assert.equal(run.code, 2);
			assert.match(run.stderr, /MADGRIX_TASK_ID/);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
