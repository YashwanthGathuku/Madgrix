/**
 * live-e2e summary: crew size counts parent + sub-agents; TheUstad verdict is printed.
 * node --test test/live-summary.test.ts
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { loadForkCrew, runCrewOnFork } from "../scripts/lib/fork-crew.mjs";
import { agentCounts, theustadVerdict } from "../scripts/lib/live-summary.mjs";

describe("live-e2e summary", () => {
	it("counts a fork crew as parent + sub-agents, one contender", () => {
		const c = agentCounts(true, { candidates: [{}], subagent_commits: [{}, {}] });
		assert.deepEqual(c, { concurrent_agents: 3, contenders: 1, sub_agents: 2, parent_agents: 1 });
	});
	it("counts a sibling race as one agent per contender", () => {
		const c = agentCounts(false, { candidates: [{}, {}, {}] });
		assert.deepEqual(c, { concurrent_agents: 3, contenders: 3, sub_agents: 0, parent_agents: 0 });
	});
	it("prints TheUstad's FINAL line, and never invents one", () => {
		assert.equal(theustadVerdict(true, { theustad: { final: "FINAL VERIFIED" } }), "FINAL VERIFIED");
		assert.equal(theustadVerdict(true, { theustad: { final: "FINAL FALSIFIED" } }), "FINAL FALSIFIED");
		assert.match(theustadVerdict(true, {}), /^UNKNOWN/);
		assert.match(theustadVerdict(true, { theustad: { final: "VERIFIED; rm -rf" } }), /^UNKNOWN/);
		assert.match(theustadVerdict(false, {}), /^not run/);
	});
	it("runCrewOnFork carries the gate's FINAL line into its result", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "madgrix-ustad-"));
		try {
			const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
			const g = (args: string[]) => assert.equal(spawnSync("git", args, { cwd: dir, env }).status, 0);
			g(["init", "--quiet", "--initial-branch=main"]);
			writeFileSync(path.join(dir, "README.md"), "baseline\n");
			g(["add", "-A"]);
			g(["commit", "--quiet", "-m", "baseline"]);
			const result = await runCrewOnFork(dir, loadForkCrew(), undefined, () => ({ final: "FINAL VERIFIED", exit: 0 }));
			assert.deepEqual(result.theustad, { final: "FINAL VERIFIED", exit: 0 });
			assert.equal(theustadVerdict(true, result), "FINAL VERIFIED");
			// The demo crew must still change something when its baseline already
			// holds a previous run's promoted output (live run on 3b71d3a).
			const next = mkdtempSync(path.join(tmpdir(), "madgrix-ustad-next-"));
			rmSync(next, { recursive: true, force: true });
			assert.equal(spawnSync("git", ["clone", "--quiet", dir, next], { env }).status, 0);
			const again = await runCrewOnFork(next, loadForkCrew(), undefined, () => ({ final: "FINAL VERIFIED", exit: 0 }));
			assert.equal(again.status, "COMPOSED");
			assert.notEqual(again.sha, result.sha);
			rmSync(next, { recursive: true, force: true });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
