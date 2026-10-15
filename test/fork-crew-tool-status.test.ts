/**
 * The fork crew writes a fresh tool-status log bound to this run, replacing a
 * stale log inherited from the baseline (live run 2 failed on one).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { loadForkCrew, runCrewOnFork, useToolStatusSession } from "../scripts/lib/fork-crew.mjs";
import { checkToolStatusLog } from "../src/lib/eval-gates.ts";

const dirs: string[] = [];
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid" };
function git(repo: string, args: string[]): string {
	const r = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: gitEnv });
	assert.equal(r.status, 0, r.stderr);
	return (r.stdout ?? "").trim();
}
after(() => {
	useToolStatusSession(null);
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("fork crew tool-status log", () => {
	it("replaces an inherited stale log with one that passes the evaluator's binding check", async () => {
		const repo = mkdtempSync(path.join(tmpdir(), "madgrix-ts-"));
		dirs.push(repo);
		git(repo, ["init", "--quiet", "--initial-branch=main"]);
		mkdirSync(path.join(repo, ".madgrix"));
		const stale = '{"format":"madgrix-tool-status/v1","task_id":"task_old","contender_id":"old","agent_id":"agent-a","baseline_commit":"0000000","model":"m","harness":"h"}\n';
		writeFileSync(path.join(repo, ".madgrix/tool-status.jsonl"), stale);
		writeFileSync(path.join(repo, "README.md"), "baseline\n");
		git(repo, ["add", "-A"]);
		git(repo, ["commit", "--quiet", "-m", "baseline with a stale log"]);
		const baseline = git(repo, ["rev-parse", "HEAD"]);
		const run = { task_id: "task_new", contender_id: "c-1", agent_id: "parent", baseline_commit: baseline };
		useToolStatusSession({ ...run, model: "none", harness: "madgrix-fork-crew/0.1.0" });
		const result = await runCrewOnFork(repo, loadForkCrew());
		assert.equal(result.status, "COMPOSED");
		const text = git(repo, ["show", `${result.sha}:.madgrix/tool-status.jsonl`]) + "\n";
		const check = checkToolStatusLog({ text }, run);
		assert.deepEqual(check.errors, []);
		assert.equal(check.receipts_valid, true);
		assert.equal(check.session?.agent_id, "parent");
		assert.equal(check.actions, 2, "one receipt per sub-agent");
		// The stale log would have failed the same check.
		assert.equal(checkToolStatusLog({ text: stale }, run).receipts_valid, false);
	});
});
