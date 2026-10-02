#!/usr/bin/env node
/**
 * Launch real coding agents against isolated MADGRIX contender repositories.
 *
 * Required:
 *   MADGRIX_BASE_URL=https://<worker>
 *   MADGRIX_TASK_ID=task_<24hex>
 *   MADGRIX_AGENT_COMMAND='<command run inside each cloned repo>'
 *
 * Optional:
 *   MADGRIX_AGENT_IDS=agent-a,agent-b,agent-c   (default)
 *   MADGRIX_KEEP_WORKSPACES=1
 *   MADGRIX_WORK_ROOT=/tmp
 *
 * The command is intentionally provider-neutral. Examples can point at Codex,
 * Claude Code, Aider, or an internal AOS launcher. The runner never writes
 * Artifacts tokens into .git/config or command-line remote URLs.
 */

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const baseUrl = process.env.MADGRIX_BASE_URL?.replace(/\/$/, "");
const taskId = process.env.MADGRIX_TASK_ID;
const agentCommand = process.env.MADGRIX_AGENT_COMMAND;
const agentIds = (process.env.MADGRIX_AGENT_IDS ?? "agent-a,agent-b,agent-c")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);
const keep = process.env.MADGRIX_KEEP_WORKSPACES === "1";
const workRoot = process.env.MADGRIX_WORK_ROOT ?? os.tmpdir();

if (!baseUrl || !taskId || !agentCommand) {
	console.error("Missing MADGRIX_BASE_URL, MADGRIX_TASK_ID, or MADGRIX_AGENT_COMMAND");
	process.exit(2);
}
if (agentIds.length < 2) {
	console.error("MADGRIX requires at least two concurrent agents; the competition demo should use three.");
	process.exit(2);
}

function run(cmd, args, opts = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, {
			cwd: opts.cwd,
			env: opts.env ?? process.env,
			stdio: opts.stdio ?? "inherit",
		});
		child.on("error", reject);
		child.on("exit", (code, signal) => {
			if (code === 0) resolve();
			else reject(new Error(`${cmd} exited ${code ?? signal}`));
		});
	});
}

function capture(cmd, args, opts = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, {
			cwd: opts.cwd,
			env: opts.env ?? process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		let err = "";
		child.stdout.on("data", (b) => (out += b));
		child.stderr.on("data", (b) => (err += b));
		child.on("error", reject);
		child.on("exit", (code) => {
			if (code === 0) resolve(out.trim());
			else reject(new Error(`${cmd} exited ${code}: ${err.trim()}`));
		});
	});
}

async function postJson(url, body) {
	const res = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(`POST ${url} -> ${res.status}: ${JSON.stringify(data)}`);
	return data;
}

async function runOne(agentId) {
	const contender = await postJson(`${baseUrl}/tasks/${encodeURIComponent(taskId)}/contenders`, {
		agent_id: agentId,
	});
	const { contender_id: contenderId, remote, token, fork_repo: forkRepo } = contender;
	if (![contenderId, remote, token, forkRepo].every((x) => typeof x === "string" && x.length > 0)) {
		throw new Error(`invalid contender response for ${agentId}`);
	}

	const dir = await mkdtemp(path.join(workRoot, `madgrix-${agentId.replace(/[^A-Za-z0-9._-]/g, "_")}-`));
	const auth = `Authorization: Bearer ${token}`;
	try {
		await run("git", ["-c", `http.extraHeader=${auth}`, "clone", "--quiet", "--single-branch", "--branch", "main", remote, dir]);
		const baseline = await capture("git", ["rev-parse", "HEAD"], { cwd: dir });

		const env = {
			...process.env,
			MADGRIX_AGENT_ID: agentId,
			MADGRIX_CONTENDER_ID: contenderId,
			MADGRIX_TASK_ID: taskId,
			MADGRIX_BASELINE_SHA: baseline,
			MADGRIX_WORKSPACE: dir,
		};
		console.error(`[madgrix] starting ${agentId} in isolated repo ${forkRepo}`);
		await run("bash", ["-lc", agentCommand], { cwd: dir, env });

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
}

const started = Date.now();
const settled = await Promise.allSettled(agentIds.map(runOne));
const failed = settled.filter((r) => r.status === "rejected");
if (failed.length) {
	for (const f of failed) console.error("[madgrix] contender failed:", f.reason);
	process.exit(1);
}
const candidates = settled.map((r) => r.value);
console.log(JSON.stringify({
	task_id: taskId,
	concurrent_agents: candidates.length,
	elapsed_ms: Date.now() - started,
	candidates,
}, null, 2));
