#!/usr/bin/env node
/**
 * Bounded-wave launcher for large MADGRIX fleets.
 *
 * run-contenders.mjs runs its selected roster concurrently. This wrapper
 * keeps that behavior per wave while preventing a 10,000-agent roster from
 * spawning 10,000 Git clones/processes at once.
 *
 * Required in addition to run-contenders.mjs inputs:
 *   MADGRIX_AGENT_SECRETS_FILE=/secure/path/agent-secrets.json
 *
 * Roster sources, in priority order:
 *   MADGRIX_AGENT_IDS_FILE  JSON string[] or newline-delimited ids
 *   MADGRIX_AGENT_IDS       existing comma-separated override
 *   Agentfleet manifest     existing loadContenderIds() path
 *
 * Optional:
 *   MADGRIX_ACTIVE_AGENT_WINDOW=32   integer 1..256
 *   MADGRIX_RESULT_PATH=...          aggregate result JSON
 *
 * This is a process/resource bound, not a claim that 10,000 full coding
 * agents were live-tested simultaneously on Cloudflare.
 */
import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { loadContenderIds } from "./lib/agentfleet-slots.mjs";
import { DEFAULT_ACTIVE_AGENT_WINDOW, planAgentWaves } from "../src/lib/fleet-scale.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** @param {string | undefined} raw @param {number} fallback */
function parsePositiveInt(raw, fallback) {
	if (raw === undefined || raw === "") return fallback;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < 1 || n > 256) {
		throw new Error("MADGRIX_ACTIVE_AGENT_WINDOW must be an integer from 1 to 256");
	}
	return n;
}

/** @returns {Promise<string[]>} */
async function loadRoster() {
	const file = process.env.MADGRIX_AGENT_IDS_FILE;
	if (!file) return loadContenderIds();
	const raw = await readFile(file, "utf8");
	try {
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed) && parsed.every((id) => typeof id === "string")) return parsed;
	} catch {
		// Newline format below.
	}
	return raw.split(/\r?\n/).map((id) => id.trim()).filter(Boolean);
}

/**
 * @param {string[]} agentIds
 * @param {Record<string, string>} secrets
 * @param {number} index
 * @returns {Promise<any>}
 */
async function runWave(agentIds, secrets, index) {
	const resultPath = path.join(os.tmpdir(), `madgrix-fleet-wave-${process.pid}-${index}.json`);
	const selectedSecrets = Object.fromEntries(agentIds.map((id) => [id, secrets[id]]));
	const env = /** @type {NodeJS.ProcessEnv} */ ({
		...process.env,
		MADGRIX_AGENT_IDS: agentIds.join(","),
		MADGRIX_AGENT_SECRETS: JSON.stringify(selectedSecrets),
		MADGRIX_RESULT_PATH: resultPath,
	});
	delete env.MADGRIX_AGENT_IDS_FILE;
	delete env.MADGRIX_AGENT_SECRETS_FILE;

	try {
		await new Promise((resolve, reject) => {
			const child = spawn(process.execPath, [path.join(repoRoot, "scripts/run-contenders.mjs")], {
				cwd: repoRoot,
				env,
				stdio: "inherit",
			});
			child.on("error", reject);
			child.on("exit", (code, signal) => {
				if (code === 0) resolve(undefined);
				else reject(new Error(`fleet wave ${index + 1} exited ${code ?? signal}`));
			});
		});
		return JSON.parse(await readFile(resultPath, "utf8"));
	} finally {
		await rm(resultPath, { force: true });
	}
}

const secretsPath = process.env.MADGRIX_AGENT_SECRETS_FILE;
if (!secretsPath) {
	console.error(
		"MADGRIX_AGENT_SECRETS_FILE is required for fleet-wave mode; keep large secret maps out of one environment variable",
	);
	process.exit(2);
}

const roster = await loadRoster();
const activeWindow = parsePositiveInt(process.env.MADGRIX_ACTIVE_AGENT_WINDOW, DEFAULT_ACTIVE_AGENT_WINDOW);
const waves = planAgentWaves(roster, activeWindow);
const parsedSecrets = JSON.parse(await readFile(secretsPath, "utf8"));
if (!parsedSecrets || typeof parsedSecrets !== "object" || Array.isArray(parsedSecrets)) {
	throw new Error("MADGRIX_AGENT_SECRETS_FILE must contain a JSON object");
}
const secrets = /** @type {Record<string, string>} */ (parsedSecrets);
for (const id of roster) {
	if (typeof secrets[id] !== "string" || !/^[0-9a-f]{64}$/.test(secrets[id])) {
		throw new Error(`missing/invalid enrolled secret for ${id}`);
	}
}

console.error(
	`[Git4agents] logical fleet ${roster.length}; ${waves.length} waves; at most ${activeWindow} active contender processes`,
);
const started = Date.now();
/** @type {any[]} */
const results = [];
for (const wave of waves) {
	console.error(`[Git4agents] wave ${wave.index + 1}/${waves.length}: ${wave.agent_ids.length} agents`);
	results.push(await runWave(wave.agent_ids, secrets, wave.index));
}

const aggregate = {
	task_id: process.env.MADGRIX_TASK_ID ?? null,
	logical_agents: roster.length,
	active_window: activeWindow,
	waves: waves.length,
	completed_agents: results.reduce((sum, row) => sum + (Number(row.concurrent_agents) || 0), 0),
	elapsed_ms: Date.now() - started,
	results,
	proof_scope: "bounded-wave launcher; simultaneous 10,000-agent Cloudflare execution is not claimed",
};
if (process.env.MADGRIX_RESULT_PATH) {
	const { writeFile } = await import("node:fs/promises");
	await writeFile(process.env.MADGRIX_RESULT_PATH, JSON.stringify(aggregate, null, 2) + "\n", "utf8");
}
console.log(JSON.stringify(aggregate, null, 2));
