#!/usr/bin/env node
/**
 * Deterministic resolver for configs/demo-composition.json.
 *
 * Under the resolution lease (specs/amendments/resolution-lease-v1.md) the
 * authority has already written every file that was not in conflict. This
 * resolver reads the structured conflict from outside the repository and
 * writes the one leased path: a contract line that keeps both intents. It does
 * not evaluate or promote. A service token in its environment is a hard
 * failure.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

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

if (!blocked.has("src/contract.js")) {
	console.error("demo resolver expected a conflict on src/contract.js");
	process.exit(1);
}
mkdirSync("src", { recursive: true });
writeFileSync("src/contract.js", 'export const label = "api+ui";\n');
