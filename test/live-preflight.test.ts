/**
 * live-e2e.ts preflight: refuses before any network call, without echoing
 * a token value. node --test test/live-preflight.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function runLive(extra: Record<string, string>) {
	return spawnSync(process.execPath, ["scripts/live-e2e.ts"], {
		cwd: REPO_ROOT,
		encoding: "utf8",
		timeout: 30_000,
		env: {
			PATH: process.env.PATH ?? "",
			HOME: process.env.HOME ?? "",
			MADGRIX_BASE_URL: "http://127.0.0.1:9",
			MADGRIX_CONTROL_SERVICE_TOKEN: "short-ctl",
			MADGRIX_AGENT_SERVICE_TOKEN: "agent-token-long-enough-1",
			MADGRIX_EVALUATION_SERVICE_TOKEN: "agent-token-long-enough-1",
			MADGRIX_BASELINE_REPO: "baseline",
			MADGRIX_BASELINE_COMMIT: "a".repeat(40),
			MADGRIX_INTENT: "x",
			MADGRIX_BEHAVIOR_CONTRACT: "x",
			MADGRIX_HIDDEN_TEST_COMMAND: "true",
			MADGRIX_AGENT_COMMAND: "true",
			MADGRIX_AGENT_IDS: "a,b,c",
			MADGRIX_CLAIM_PATHS: "src/**",
			MADGRIX_TRUST_KEY: "/nonexistent/authority.pub",
			...extra,
		},
	});
}

describe("live-e2e preflight", () => {
	it("refuses short/duplicate tokens and a missing trust key, exit 2, no token echoed", () => {
		const r = runLive({});
		assert.equal(r.status, 2);
		assert.match(r.stderr, /preflight failed/);
		assert.match(r.stderr, /MADGRIX_CONTROL_SERVICE_TOKEN is shorter than 16/);
		assert.match(r.stderr, /must be distinct/);
		assert.match(r.stderr, /authority public key not found/);
		assert.ok(!r.stderr.includes("short-ctl") && !r.stderr.includes("agent-token-long-enough-1"));
		assert.ok(!r.stderr.includes("1/9"), "no task is created");
	});
});
