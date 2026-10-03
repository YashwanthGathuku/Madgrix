#!/usr/bin/env node
/**
 * Launch real coding agents against isolated MADGRIX contender repositories.
 *
 * Required:
 *   MADGRIX_BASE_URL=https://<worker>
 *   MADGRIX_TASK_ID=task_<24hex>
 *   MADGRIX_AGENT_COMMAND='<command run inside each cloned repo>'
 *   MADGRIX_CLAIM_PATHS=src/auth/**,src/jwt.ts   the WorkClaim's scope.paths:
 *     repo-relative globs ("**" is refused: an unbounded claim is not
 *     admissible, spec 2 §7). Or MADGRIX_CLAIM_TEMPLATE, a JSON claim body
 *     whose own scope.paths is used instead.
 *
 * The agent command writes its tool-status log to .madgrix/tool-status.jsonl
 * in the workspace (specs/amendments/tool-status-v1.md); it is committed with
 * the agent's other changes. Without it the candidate fails valid_tool_states
 * and provenance_complete.
 *
 * Optional:
 *   MADGRIX_AGENT_IDS=agent-a,agent-b,agent-c   (default)
 *   MADGRIX_KEEP_WORKSPACES=1
 *   MADGRIX_WORK_ROOT=/tmp
 *   MADGRIX_AGENT_ENV_ALLOWLIST=NAME[,NAME...]  variables passed through to
 *     the agent command, for the agent's own model API key
 *
 * The command is intentionally provider-neutral. Examples can point at Codex,
 * Claude Code, Aider, or an internal AOS launcher. The runner never writes
 * Artifacts tokens into .git/config or command-line remote URLs.
 *
 * The agent command runs under `bash -c` (not a login shell, so profile files
 * are not re-read) with minimalEnv() plus MADGRIX_AGENT_ID,
 * MADGRIX_CONTENDER_ID, MADGRIX_TASK_ID, MADGRIX_BASELINE_SHA,
 * MADGRIX_WORKSPACE and the allowlisted variables. It receives no service
 * token. See docs/SECURITY.md "Process environment boundaries".
 */

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { minimalEnv, parseAgentEnvAllowlist, pickEnv } from "./lib/child-env.mjs";

const baseUrl = process.env.MADGRIX_BASE_URL?.replace(/\/$/, "");
const taskId = process.env.MADGRIX_TASK_ID;
const agentCommand = process.env.MADGRIX_AGENT_COMMAND;
const agentServiceToken = process.env.MADGRIX_AGENT_SERVICE_TOKEN;
const agentIds = (process.env.MADGRIX_AGENT_IDS ?? "agent-a,agent-b,agent-c")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);
const keep = process.env.MADGRIX_KEEP_WORKSPACES === "1";
const workRoot = process.env.MADGRIX_WORK_ROOT ?? os.tmpdir();

if (!baseUrl || !taskId || !agentCommand || !agentServiceToken) {
	console.error("Missing MADGRIX_BASE_URL, MADGRIX_TASK_ID, MADGRIX_AGENT_COMMAND, or MADGRIX_AGENT_SERVICE_TOKEN");
	process.exit(2);
}
if (agentIds.length < 2) {
	console.error("MADGRIX requires at least two concurrent agents; the competition demo should use three.");
	process.exit(2);
}
/** @type {string[]} */
let agentEnvAllowlist = [];
try {
	agentEnvAllowlist = parseAgentEnvAllowlist(process.env.MADGRIX_AGENT_ENV_ALLOWLIST);
} catch (err) {
	console.error(/** @type {Error} */ (err).message);
	process.exit(2);
}
/** @type {Record<string, any> | null} */
let claimTemplate = null;
if (process.env.MADGRIX_CLAIM_TEMPLATE) {
	try {
		claimTemplate = JSON.parse(process.env.MADGRIX_CLAIM_TEMPLATE);
	} catch {
		console.error("MADGRIX_CLAIM_TEMPLATE must be valid JSON");
		process.exit(2);
	}
}
const claimPaths = (process.env.MADGRIX_CLAIM_PATHS ?? "")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);
const scopePaths = claimTemplate ? claimTemplate.scope?.paths : claimPaths;
if (!Array.isArray(scopePaths) || scopePaths.length === 0) {
	console.error(
		"A WorkClaim needs a bounded scope: set MADGRIX_CLAIM_PATHS (comma-separated repo-relative globs) " +
			"or scope.paths in MADGRIX_CLAIM_TEMPLATE (spec 2 §2).",
	);
	process.exit(2);
}
if (scopePaths.includes("**")) {
	console.error('Claim scope "**" matches every path; unbounded claims are not admissible (spec 2 §7). Name the paths the task may change.');
	process.exit(2);
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string, env?: Record<string, string>, stdio?: import("node:child_process").StdioOptions }} [opts]
 * @returns {Promise<void>}
 */
function run(cmd, args, opts = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, {
			cwd: opts.cwd,
			env: opts.env ?? minimalEnv(),
			stdio: opts.stdio ?? "inherit",
		});
		child.on("error", reject);
		child.on("exit", (code, signal) => {
			if (code === 0) resolve();
			else reject(new Error(`${cmd} exited ${code ?? signal}`));
		});
	});
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string, env?: Record<string, string> }} [opts]
 * @returns {Promise<string>}
 */
function capture(cmd, args, opts = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, {
			cwd: opts.cwd,
			env: opts.env ?? minimalEnv(),
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		let err = "";
		child.stdout.on("data", (b) => (out += b));
		child.stderr.on("data", (b) => (err += b));
		child.on("error", reject);
		// "close", not "exit": stdout may still hold unread output at "exit".
		child.on("close", (code) => {
			if (code === 0) resolve(out.trim());
			else reject(new Error(`${cmd} exited ${code}: ${err.trim()}`));
		});
	});
}

/**
 * @param {string} url
 * @returns {Promise<any>}
 */
async function getJson(url) {
	const res = await fetch(url, { headers: { authorization: `Bearer ${agentServiceToken}` } });
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(`GET ${url} -> ${res.status}: ${JSON.stringify(data)}`);
	return data;
}

/**
 * @param {string} url
 * @param {unknown} body
 * @param {Record<string, string>} [extraHeaders]
 * @returns {Promise<any>}
 */
async function postJson(url, body, extraHeaders = {}) {
	const res = await fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${agentServiceToken}`,
			...extraHeaders,
		},
		body: JSON.stringify(body),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(`POST ${url} -> ${res.status}: ${JSON.stringify(data)}`);
	return data;
}

const taskUrl = `${baseUrl}/tasks/${encodeURIComponent(taskId)}`;
const context = await getJson(`${taskUrl}/context`);
const task = context.task;
if (!task || typeof task.task_hash !== "string" || typeof task.baseline_commit !== "string") {
	throw new Error("MADGRIX task context is incomplete");
}

const defaultClaim = {
	intent: { behavior: [task.intent] },
	scope: { paths: claimPaths, symbols: [] },
	contracts: { reads: [], modifies: [] },
	interfaces: [],
	schema_changes: [],
	expected_tests: [],
};

/** @param {string} agentId */
const runOne = async (agentId) => {
	const now = new Date();
	const claimInput = {
		...(claimTemplate ?? defaultClaim),
		agent: agentId,
		task: task.task_hash,
		baseline: task.baseline_commit,
		lease: {
			claimed_at: now.toISOString(),
			expires_at: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
		},
	};
	const claimRes = await postJson(`${taskUrl}/claim`, { claim: claimInput });
	const workId = claimRes.work_id;
	if (typeof workId !== "string") throw new Error(`claim registration returned no work_id for ${agentId}`);
	// Proves to /contenders that this runner registered agentId's claim. Held
	// only in this variable: never logged, written to disk or put in the
	// agent command's environment.
	const agentSecret = claimRes.agent_secret;
	if (typeof agentSecret !== "string" || !/^[0-9a-f]{64}$/.test(agentSecret)) {
		throw new Error(`claim registration returned no agent secret for ${agentId}`);
	}

	const contender = await postJson(
		`${taskUrl}/contenders`,
		{ agent_id: agentId, claim_work_id: workId },
		{ "x-madgrix-agent-secret": agentSecret },
	);
	const { contender_id: contenderId, remote, token, fork_repo: forkRepo } = contender;
	if (![contenderId, remote, token, forkRepo].every((x) => typeof x === "string" && x.length > 0)) {
		throw new Error(`invalid contender response for ${agentId}`);
	}

	const dir = await mkdtemp(path.join(workRoot, `madgrix-${agentId.replace(/[^A-Za-z0-9._-]/g, "_")}-`));
	const auth = `Authorization: Bearer ${token}`;
	try {
		await run("git", ["-c", `http.extraHeader=${auth}`, "clone", "--quiet", "--single-branch", "--branch", "main", remote, dir]);
		const baseline = await capture("git", ["rev-parse", "HEAD"], { cwd: dir });

		// No service token and no other operator credential: only the agent's
		// own identifiers plus what the operator explicitly allowlisted.
		const env = minimalEnv({
			...pickEnv(agentEnvAllowlist),
			MADGRIX_AGENT_ID: agentId,
			MADGRIX_CONTENDER_ID: contenderId,
			MADGRIX_TASK_ID: taskId,
			MADGRIX_BASELINE_SHA: baseline,
			MADGRIX_WORKSPACE: dir,
		});
		console.error(`[madgrix] starting ${agentId} in isolated repo ${forkRepo}`);
		await run("bash", ["-c", agentCommand], { cwd: dir, env });

		const dirty = await capture("git", ["status", "--porcelain"], { cwd: dir });
		if (dirty) {
			await run("git", ["add", "-A"], { cwd: dir });
			const name = process.env.GIT_AUTHOR_NAME ?? `MADGRIX ${agentId}`;
			const email = process.env.GIT_AUTHOR_EMAIL ?? `${agentId.replace(/[^A-Za-z0-9]/g, "")}@madgrix.invalid`;
			await run("git", ["-c", `user.name=${name}`, "-c", `user.email=${email}`, "commit", "-m", `MADGRIX contender: ${agentId}`], { cwd: dir });
		}

		const candidateSha = await capture("git", ["rev-parse", "HEAD"], { cwd: dir });
		if (candidateSha === baseline) {
			throw new Error(`${agentId} produced no candidate change`);
		}
		await run("git", ["-c", `http.extraHeader=${auth}`, "push", "--quiet", "origin", "HEAD:refs/heads/main"], { cwd: dir });
		console.error(`[madgrix] ${agentId} pushed ${candidateSha.slice(0, 12)}`);
		return {
			agent_id: agentId,
			contender_id: contenderId,
			claim_work_id: workId,
			conflicts: Array.isArray(claimRes.conflicts) ? claimRes.conflicts : [],
			fork_repo: forkRepo,
			candidate_sha: candidateSha,
			baseline_sha: baseline,
			workspace: keep ? dir : undefined,
		};
	} finally {
		// The server-side contender token has a short TTL and is separately
		// revocable by quarantine. Locally, ensure no credential survives in
		// a remote URL/config; clone used only an ephemeral extraHeader.
		if (!keep) await rm(dir, { recursive: true, force: true });
	}
};

const started = Date.now();
const settled = await Promise.allSettled(agentIds.map(runOne));
const failed = settled.filter((r) => r.status === "rejected");
if (failed.length) {
	for (const f of failed) console.error("[madgrix] contender failed:", f.reason);
	process.exit(1);
}
const candidates = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
const result = {
	task_id: taskId,
	concurrent_agents: candidates.length,
	elapsed_ms: Date.now() - started,
	candidates,
};
if (process.env.MADGRIX_RESULT_PATH) {
	const { writeFile } = await import("node:fs/promises");
	await writeFile(process.env.MADGRIX_RESULT_PATH, JSON.stringify(result, null, 2) + "\n", "utf8");
}
console.log(JSON.stringify(result, null, 2));
