#!/usr/bin/env node
/**
 * Demo path: one parent contender forks the baseline. Sub-agents are created
 * on that fork, split by role and path, and their commits are combined into
 * the one SHA promotion ships.
 *
 * The parent calls `fleet validate` (not `fleet run`) so Agentfleet stays a
 * subprocess. Copy-baseline remains inside the worker, and only if fork()
 * throws the known 10101 failure. This script never creates a second repo.
 *
 * Required:
 *   MADGRIX_BASE_URL, MADGRIX_TASK_ID, MADGRIX_AGENT_SERVICE_TOKEN
 *   MADGRIX_AGENT_SECRETS  one secret per parent and sub-agent
 *   MADGRIX_CLAIM_PATHS    the parent claim's bounded scope
 *
 * Optional:
 *   MADGRIX_FORK_CREW_CONFIG, MADGRIX_FLEET_CONFIG, MADGRIX_FLEET_BIN
 *   MADGRIX_QUEUE_ID, MADGRIX_ARTIFACTS_NAMESPACE, MADGRIX_RESULT_PATH
 *   MADGRIX_KEEP_WORKSPACES, MADGRIX_WORK_ROOT
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { gitAuthEnv, minimalEnv } from "./lib/child-env.mjs";
import {
	DEFAULT_FORK_CREW_CONFIG,
	assertFleetRoster,
	authorityComposition,
	fleetConfigForCrew,
	loadForkCrew,
	resolveComposition,
	runCrewOnFork,
} from "./lib/fork-crew.mjs";

const baseUrl = process.env.MADGRIX_BASE_URL?.replace(/\/$/, "");
const taskId = process.env.MADGRIX_TASK_ID;
const agentServiceToken = process.env.MADGRIX_AGENT_SERVICE_TOKEN;
const keep = process.env.MADGRIX_KEEP_WORKSPACES === "1";
const workRoot = process.env.MADGRIX_WORK_ROOT ?? os.tmpdir();
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const claimPaths = (process.env.MADGRIX_CLAIM_PATHS ?? "")
	.split(",")
	.map((s) => s.trim())
	.filter(Boolean);
if (!baseUrl || !taskId || !agentServiceToken) {
	console.error("Missing MADGRIX_BASE_URL, MADGRIX_TASK_ID, or MADGRIX_AGENT_SERVICE_TOKEN");
	process.exit(2);
}
if (claimPaths.length === 0 || claimPaths.includes("**")) {
	console.error("The parent claim needs MADGRIX_CLAIM_PATHS, and \"**\" is not admissible.");
	process.exit(2);
}

/** @type {ReturnType<typeof loadForkCrew>} */
let crew;
try {
	const crewConfig = process.env.MADGRIX_FORK_CREW_CONFIG || DEFAULT_FORK_CREW_CONFIG;
	crew = loadForkCrew(crewConfig);
	assertFleetRoster(crew, process.env.MADGRIX_FLEET_CONFIG || fleetConfigForCrew(crewConfig));
} catch (err) {
	console.error(/** @type {Error} */ (err).message);
	process.exit(2);
}

/** @type {Record<string, unknown>} */
let agentSecrets = {};
try {
	const parsed = JSON.parse(process.env.MADGRIX_AGENT_SECRETS ?? "");
	if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) agentSecrets = parsed;
} catch {
	// reported below, without echoing the value
}
const ids = [crew.parent.id, ...crew.subs.map((sub) => sub.id)];
const unenrolled = ids.filter((id) => {
	const secret = Object.hasOwn(agentSecrets, id) ? agentSecrets[id] : undefined;
	return typeof secret !== "string" || !/^[0-9a-f]{64}$/.test(secret);
});
if (unenrolled.length) {
	console.error(
		`MADGRIX_AGENT_SECRETS has no secret for ${unenrolled.join(", ")}. ` +
			"Sub-agents claim on the parent fork; they do not get their own repos.",
	);
	process.exit(2);
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
		child.on("close", (code) => {
			if (code === 0) resolve(out.trim());
			else reject(new Error(`${cmd} exited ${code}: ${redact(err)}`));
		});
	});
}

/**
 * @param {string} text
 */
function redact(text) {
	return text
		.replace(/https:\/\/\S+/g, "[url]")
		.replace(/art_v2_\S+/g, "[token]")
		.replace(/[0-9a-f]{32,}/gi, "[id]");
}

/**
 * @param {string} url
 * @param {unknown} body
 * @param {Record<string, string>} [extraHeaders]
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
	if (!res.ok) throw new Error(`POST ${url} -> ${res.status}: ${redact(JSON.stringify(data))}`);
	return data;
}

/**
 * @param {string} url
 */
async function getJson(url) {
	const res = await fetch(url, { headers: { authorization: `Bearer ${agentServiceToken}` } });
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(`GET ${url} -> ${res.status}: ${redact(JSON.stringify(data))}`);
	return data;
}

/**
 * @param {string} repoName
 * @returns {Promise<"skipped" | "created" | "existing">}
 */
async function ensurePushSubscription(repoName) {
	const queueId = process.env.MADGRIX_QUEUE_ID;
	if (!queueId) return "skipped";
	if (!/^[A-Za-z0-9._-]{1,128}$/.test(repoName)) {
		throw new Error("refusing to subscribe a repo name that is not a single Artifacts path segment");
	}
	const namespace = process.env.MADGRIX_ARTIFACTS_NAMESPACE || "default";
	const body = {
		name: `madgrix-${repoName}`.slice(0, 63),
		enabled: true,
		source: { type: "artifacts.repo", namespace, repo_name: repoName },
		events: ["pushed"],
		destination: { type: "queues.queue", queue_id: queueId },
	};
	try {
		await capture("cf", ["queues", "subscriptions", "create", "--body", JSON.stringify(body)], {
			cwd: repoRoot,
			env: minimalEnv(),
		});
	} catch (err) {
		const raw = err instanceof Error ? err.message : String(err);
		if (/already exists|duplicate|409/i.test(raw)) return "existing";
		throw new Error(`push subscription for ${repoName} failed: ${redact(raw.split(queueId).join("[id]"))}`);
	}
	return "created";
}

/**
 * @param {number} ms
 */
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {string} contenderId
 * @param {string} sha
 * @param {number} timeoutMs
 */
async function pushWasApplied(contenderId, sha, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const context = await getJson(`${taskUrl}/context`);
		const row = (context.contenders ?? []).find(
			(/** @type {{ contender_id?: string, latest_commit?: string }} */ c) => c.contender_id === contenderId,
		);
		if (row?.latest_commit === sha) return true;
		if (Date.now() >= deadline) return false;
		await sleep(2000);
	}
}

/**
 * @param {string} agentId
 * @param {string[]} paths
 * @param {string} taskHash
 * @param {string} baseline
 */
function claimBody(agentId, paths, taskHash, baseline) {
	const now = new Date();
	return {
		agent: agentId,
		task: taskHash,
		baseline,
		intent: { behavior: [task.intent] },
		scope: { paths, symbols: [] },
		contracts: { reads: [], modifies: [] },
		interfaces: [],
		schema_changes: [],
		expected_tests: [],
		lease: {
			claimed_at: now.toISOString(),
			expires_at: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
		},
	};
}

const taskUrl = `${baseUrl}/tasks/${encodeURIComponent(taskId)}`;
const context = await getJson(`${taskUrl}/context`);
const task = context.task;
if (!task || typeof task.task_hash !== "string" || typeof task.baseline_commit !== "string" || typeof task.intent !== "string") {
	throw new Error("task context has no frozen task");
}

const parentSecret = /** @type {string} */ (agentSecrets[crew.parent.id]);
const parentClaim = await postJson(
	`${taskUrl}/claim`,
	{ claim: claimBody(crew.parent.id, claimPaths, task.task_hash, task.baseline_commit) },
	{ "x-madgrix-agent-secret": parentSecret },
);
if (typeof parentClaim.work_id !== "string") throw new Error("parent claim returned no work_id");

const contender = await postJson(
	`${taskUrl}/contenders`,
	{ agent_id: crew.parent.id, claim_work_id: parentClaim.work_id },
	{ "x-madgrix-agent-secret": parentSecret },
);
const { contender_id: contenderId, remote, token, fork_repo: forkRepo } = contender;
if (![contenderId, remote, token, forkRepo].every((x) => typeof x === "string" && x.length > 0)) {
	throw new Error("parent fork response was incomplete");
}
console.error(`[Git4agents] parent ${crew.parent.id} forked ${forkRepo}; sub-agents stay on this repo`);

const subscription = await ensurePushSubscription(forkRepo);
const dir = await mkdtemp(path.join(workRoot, "madgrix-parent-"));
try {
	await capture("git", ["clone", "--quiet", "--single-branch", "--branch", "main", remote, dir], {
		env: gitAuthEnv(token),
	});
	for (const sub of crew.subs) {
		const secret = /** @type {string} */ (agentSecrets[sub.id]);
		const claimed = await postJson(
			`${taskUrl}/claim`,
			{ claim: claimBody(sub.id, sub.paths, task.task_hash, task.baseline_commit) },
			{ "x-madgrix-agent-secret": secret },
		);
		if (typeof claimed.work_id !== "string") throw new Error(`${sub.id} claim returned no work_id`);
		/** @type {{ claim_work_id?: string }} */ (sub).claim_work_id = claimed.work_id;
		console.error(`[Git4agents] ${sub.id} (${sub.role}) claimed ${sub.paths.join(", ")} on ${forkRepo}`);
	}
	const crewRun = await runCrewOnFork(dir, crew);
	/** @type {string | null} */
	let candidateSha = crewRun.sha;
	/** @type {string} */
	let compositionStatus = crewRun.status;
	/** @type {unknown} */
	let conflict = crewRun.status === "CONFLICTED" ? crewRun.conflict : null;
	/** @param {string} status @param {string | null} sha */
	const compositionFor = (status, sha) =>
		authorityComposition({
			status: /** @type {"COMPOSED" | "CONFLICTED" | "RESOLVED"} */ (status),
			baseline: crewRun.baseline,
			commits: crewRun.commits,
			conflict: crewRun.conflict,
			sha,
			contender_id: contenderId,
		});
	if (crewRun.status === "CONFLICTED") {
		const resolver = process.env.MADGRIX_RESOLVER_COMMAND;
		if (!resolver) {
			const blocked = {
				mode: "fork-crew",
				status: "CONFLICTED",
				fork_repo: forkRepo,
				parent_agent: crew.parent.id,
				resolution: "CONFLICTED",
				overlap: crewRun.overlap,
				conflict: crewRun.conflict,
				composition: compositionFor("CONFLICTED", null),
				candidate_sha: null,
				subagent_commits: crewRun.commits.map((commit) => ({
					id: commit.id,
					role: commit.role,
					intent: commit.intent,
					sha: commit.sha,
					claim_work_id: commit.claim_work_id,
					paths: commit.paths,
				})),
			};
			console.error("[Git4agents] CONFLICTED; not pushing a candidate");
			if (process.env.MADGRIX_RESULT_PATH) {
				await writeFile(process.env.MADGRIX_RESULT_PATH, `${JSON.stringify(blocked, null, 2)}\n`);
			} else {
				process.stdout.write(`${JSON.stringify(blocked)}\n`);
			}
			process.exitCode = 3;
		} else {
		const resolved = resolveComposition(dir, crewRun, resolver);
		candidateSha = resolved.sha;
		compositionStatus = resolved.status;
		console.error(
			`[Git4agents] resolved ${candidateSha.slice(0, 12)} from CONFLICTED; the new SHA still needs evaluation`,
		);
		}
	}
	if (process.exitCode !== 3) {
	if (typeof candidateSha !== "string" || candidateSha.length === 0) {
		throw new Error("fork crew produced no candidate SHA");
	}
	console.error(
		`[Git4agents] ${compositionStatus} ${candidateSha.slice(0, 12)} ` +
			`(${crewRun.resolution}; sub-agents ${crewRun.commits.map((c) => c.sha.slice(0, 12)).join(", ")})`,
	);
	if (subscription === "created") {
		console.error(`[Git4agents] waiting for the ${forkRepo} push subscription to start emitting`);
		await sleep(30000);
	}
	await capture("git", ["push", "--quiet", "origin", "HEAD:refs/heads/main"], {
		cwd: dir,
		env: gitAuthEnv(token),
	});
	if (subscription !== "skipped") {
		let applied = await pushWasApplied(contenderId, candidateSha, 45000);
		if (!applied) {
			console.error("[Git4agents] combined push was not applied; pushing again");
			const name = process.env.GIT_AUTHOR_NAME ?? "Git4agents";
			const email = process.env.GIT_AUTHOR_EMAIL ?? "git4agents@madgrix.invalid";
			await capture(
				"git",
				["-c", `user.name=${name}`, "-c", `user.email=${email}`, "commit", "--allow-empty", "-m", "MADGRIX contender republish: parent"],
				{ cwd: dir },
			);
			candidateSha = await capture("git", ["rev-parse", "HEAD"], { cwd: dir });
			await capture("git", ["push", "--quiet", "origin", "HEAD:refs/heads/main"], {
				cwd: dir,
				env: gitAuthEnv(token),
			});
			applied = await pushWasApplied(contenderId, candidateSha, 50000);
		}
		if (!applied) throw new Error("combined push event was not applied by the task authority");
	}
	const result = {
		mode: "fork-crew",
		status: compositionStatus,
		fork_repo: forkRepo,
		parent_agent: crew.parent.id,
		resolution: compositionStatus,
		overlap: crewRun.overlap,
		conflict,
		composition: compositionFor(compositionStatus, candidateSha),
		subagent_commits: crewRun.commits.map((commit) => ({
			id: commit.id,
			role: commit.role,
			intent: commit.intent,
			sha: commit.sha,
			claim_work_id: commit.claim_work_id,
			paths: commit.paths,
		})),
		candidates: [
			{
				agent_id: crew.parent.id,
				contender_id: contenderId,
				claim_work_id: parentClaim.work_id,
				conflicts: Array.isArray(parentClaim.conflicts) ? parentClaim.conflicts : [],
				fork_repo: forkRepo,
				candidate_sha: candidateSha,
				baseline_sha: crewRun.baseline,
				subagent_claims: crewRun.commits.map((commit) => ({
					id: commit.id,
					claim_work_id: commit.claim_work_id,
					intent: commit.intent,
				})),
			},
		],
	};
	if (process.env.MADGRIX_RESULT_PATH) {
		await writeFile(process.env.MADGRIX_RESULT_PATH, `${JSON.stringify(result, null, 2)}\n`);
	} else {
		process.stdout.write(`${JSON.stringify(result)}\n`);
	}
	}
} finally {
	if (!keep) await rm(dir, { recursive: true, force: true });
}
