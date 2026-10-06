#!/usr/bin/env node
/**
 * Deterministic resolver for configs/demo-composition.json.
 *
 * It reads the baseline and the structured conflict. It copies each agent's
 * non-overlapping files from that agent's commit, then writes one contract
 * line that keeps both intents. It does not evaluate or promote. A service
 * token in its environment is a hard failure.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const forbidden = Object.keys(process.env).filter((name) =>
	/CONTROL_SERVICE_TOKEN|EVALUATION_SERVICE_TOKEN|AGENT_SERVICE_TOKEN|AUTHORITY_SIGNING_KEY/.test(name),
);
if (forbidden.length > 0) {
	console.error("resolver refuses to run with a service credential in its environment");
	process.exit(1);
}

const conflictPath = process.env.MADGRIX_CONFLICT_PATH;
const baseline = process.env.MADGRIX_BASELINE_SHA;
if (!conflictPath || !baseline) {
	console.error("resolver requires MADGRIX_CONFLICT_PATH and MADGRIX_BASELINE_SHA");
	process.exit(1);
}

const conflict = JSON.parse(readFileSync(conflictPath, "utf8"));
const blocked = new Set(
	/** @type {Array<{ path?: string }>} */ (conflict.files ?? [])
		.map((file) => file.path)
		.filter((filePath) => typeof filePath === "string"),
);

/**
 * @param {string[]} args
 */
function git(args) {
	const result = spawnSync("git", args, { encoding: "utf8" });
	if ((result.status ?? 1) !== 0) {
		console.error((result.stderr || result.stdout || "git failed").trim());
		process.exit(result.status ?? 1);
	}
	return result.stdout ?? "";
}

for (const agent of conflict.agents ?? []) {
	if (typeof agent.commit !== "string" || agent.commit === "") {
		console.error("conflict agent has no commit");
		process.exit(1);
	}
	const names = git(["diff", "--name-only", baseline, agent.commit]).split("\n").filter(Boolean);
	for (const name of names) {
		if (blocked.has(name)) continue;
		mkdirSync(path.dirname(name), { recursive: true });
		git(["checkout", agent.commit, "--", name]);
	}
}

if (!blocked.has("src/contract.js")) {
	console.error("demo resolver expected a conflict on src/contract.js");
	process.exit(1);
}
writeFileSync("src/contract.js", 'export const label = "api+ui";\n');
