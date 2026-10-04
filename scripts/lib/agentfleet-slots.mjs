/**
 * Contender roster from Agentfleet.
 *
 * Agentfleet (github.com/YashwanthGathuku/agent-orchestration-os) is
 * proprietary. This file does not vendor its source. It runs
 * `fleet validate --config <manifest> --json` and reads summary.agent_ids.
 * How many contenders launch is the length of `agents` in
 * configs/git4agents-contenders.yaml, not a new script.
 *
 * MADGRIX_AGENT_IDS still overrides that roster (comma-separated).
 * MADGRIX_FLEET_BIN selects the fleet executable (default: `fleet` on PATH).
 * MADGRIX_FLEET_CONFIG selects the manifest.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { minimalEnv } from "./child-env.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const DEFAULT_FLEET_CONFIG = path.join(repoRoot, "configs/git4agents-contenders.yaml");

/** Same pattern the worker enrolls (src/lib/task-state.ts AGENT_ID_PATTERN). */
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * @param {unknown} report
 * @returns {string[]}
 */
export function contenderIdsFromReport(report) {
	const body = /** @type {{ is_valid?: boolean, issues?: { message?: string }[], summary?: { agent_ids?: unknown } }} */ (
		report && typeof report === "object" ? report : {}
	);
	if (body.is_valid !== true) {
		const issues = Array.isArray(body.issues)
			? body.issues.map((issue) => issue?.message).filter((message) => typeof message === "string").slice(0, 5)
			: [];
		throw new Error(
			issues.length
				? `fleet validate rejected the contender manifest: ${issues.join("; ")}`
				: "fleet validate rejected the contender manifest",
		);
	}
	const ids = body.summary?.agent_ids;
	if (!Array.isArray(ids) || ids.length < 2) {
		throw new Error("fleet validate JSON did not list at least two summary.agent_ids");
	}
	const seen = new Set();
	for (const id of ids) {
		if (typeof id !== "string" || !AGENT_ID.test(id) || seen.has(id)) {
			throw new Error("fleet validate returned an agent id Git4agents cannot enroll");
		}
		seen.add(id);
	}
	return ids;
}

/**
 * @param {{ env?: Record<string, string | undefined>, configPath?: string, fleetBin?: string }} [options]
 * @returns {string[]}
 */
export function loadContenderIds(options = {}) {
	const env = options.env ?? process.env;
	const override = env.MADGRIX_AGENT_IDS;
	if (typeof override === "string" && override.trim()) {
		const ids = override.split(",").map((id) => id.trim()).filter(Boolean);
		const seen = new Set();
		for (const id of ids) {
			if (!AGENT_ID.test(id) || seen.has(id)) {
				throw new Error("MADGRIX_AGENT_IDS has an id Git4agents cannot enroll");
			}
			seen.add(id);
		}
		return ids;
	}

	const configPath = options.configPath ?? (env.MADGRIX_FLEET_CONFIG || DEFAULT_FLEET_CONFIG);
	const bin = options.fleetBin ?? (env.MADGRIX_FLEET_BIN || "fleet");
	const result = spawnSync(bin, ["validate", "--config", configPath, "--json"], {
		encoding: "utf8",
		env: minimalEnv(),
		maxBuffer: 2 * 1024 * 1024,
	});
	if (result.error) {
		const code = /** @type {NodeJS.ErrnoException} */ (result.error).code;
		if (code === "ENOENT") {
			throw new Error(
				`fleet binary not found (${bin}). Set MADGRIX_FLEET_BIN to the Agentfleet fleet executable.`,
			);
		}
		throw new Error("failed to run fleet validate");
	}
	let report;
	try {
		report = JSON.parse(result.stdout);
	} catch {
		throw new Error(`fleet validate did not print JSON (exit ${result.status ?? "signal"})`);
	}
	if (result.status !== 0 && report?.is_valid === true) {
		throw new Error(`fleet validate exited ${result.status}`);
	}
	return contenderIdsFromReport(report);
}
