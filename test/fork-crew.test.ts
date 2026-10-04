/**
 * One parent fork, two role-scoped sub-agent commits, one combined SHA.
 * node --test test/fork-crew.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { crewAgentIds, loadForkCrew, runCrewOnFork, verifyFrozenBaseline } from "../scripts/lib/fork-crew.mjs";

const dirs: string[] = [];

function git(repo: string, args: string[]): string {
	const result = spawnSync("git", args, {
		cwd: repo,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Git4agents",
			GIT_AUTHOR_EMAIL: "git4agents@madgrix.invalid",
			GIT_COMMITTER_NAME: "Git4agents",
			GIT_COMMITTER_EMAIL: "git4agents@madgrix.invalid",
		},
	});
	assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
	return (result.stdout ?? "").trim();
}

function initFork(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "madgrix-fork-"));
	dirs.push(dir);
	git(dir, ["init", "--quiet", "--initial-branch=main"]);
	writeFileSync(path.join(dir, "README.md"), "baseline\n");
	git(dir, ["add", "-A"]);
	git(dir, ["commit", "--quiet", "-m", "baseline"]);
	return dir;
}

function isAncestor(repo: string, ancestor: string, tip: string): boolean {
	const result = spawnSync("git", ["merge-base", "--is-ancestor", ancestor, tip], { cwd: repo });
	return result.status === 0;
}

after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("fork crew", () => {
	it("configures a parent and two sub-agents with different roles and paths", () => {
		const crew = loadForkCrew();
		assert.deepEqual(crewAgentIds(crew), ["parent", "sub-api", "sub-ui"]);
		assert.equal(crew.parent.role, "parent");
		assert.notEqual(crew.subs[0].role, crew.subs[1].role);
		assert.notDeepEqual(crew.subs[0].paths, crew.subs[1].paths);
		assert.notEqual(crew.subs[0].command, crew.subs[1].command);
		assert.notEqual(crew.subs[0].intent, crew.subs[1].intent);
	});

	it("puts two sub-agent commits on one fork and combines them into one SHA", () => {
		const repo = initFork();
		const crew = loadForkCrew();
		const result = runCrewOnFork(repo, crew);
		assert.equal(result.commits.length, 2);
		assert.equal(result.overlap.length, 0);
		assert.equal(result.resolution, "combined");
		assert.equal(git(repo, ["rev-parse", "HEAD"]), result.sha);
		for (const commit of result.commits) {
			assert.ok(isAncestor(repo, commit.sha, result.sha), `${commit.id} is on the combined fork`);
			assert.notEqual(commit.sha, result.sha);
		}
		const files = git(repo, ["ls-tree", "-r", "--name-only", result.sha]).split("\n");
		assert.ok(files.includes("src/api/handler.js"));
		assert.ok(files.includes("src/ui/view.js"));
		assert.ok(files.includes(".madgrix/subagent-intents.json"));
		const record = JSON.parse(readFileSync(path.join(repo, ".madgrix/subagent-intents.json"), "utf8"));
		assert.deepEqual(
			record.claims.map((claim: { intent: string }) => claim.intent),
			[crew.subs[0].intent, crew.subs[1].intent],
		);
		assert.equal(git(repo, ["show", `${result.sha}:src/api/handler.js`]).includes("api"), true);
		assert.equal(git(repo, ["show", `${result.sha}:src/ui/view.js`]).includes("ui"), true);
	});


	it("applies both edits when changed lines in one file do not overlap", () => {
		const repo = initFork();
		mkdirSync(path.join(repo, "src"), { recursive: true });
		writeFileSync(path.join(repo, "src/shared.js"), "alpha\nbeta\ngamma\ndelta\n");
		git(repo, ["add", "src/shared.js"]);
		git(repo, ["commit", "--quiet", "-m", "shared baseline"]);
		const crew = loadForkCrew();
		for (const sub of crew.subs) sub.paths = ["src/shared.js"];
		crew.subs[0].command =
			"python3 -c \"from pathlib import Path; p=Path('src/shared.js'); p.write_text(p.read_text().replace('alpha', 'api-alpha', 1))\"";
		crew.subs[1].command =
			"python3 -c \"from pathlib import Path; p=Path('src/shared.js'); p.write_text(p.read_text().replace('delta', 'ui-delta', 1))\"";
		const result = runCrewOnFork(repo, crew);
		assert.deepEqual(result.overlap, []);
		assert.equal(result.resolution, "combined");
		const shared = git(repo, ["show", `${result.sha}:src/shared.js`]);
		assert.equal(shared, "api-alpha\nbeta\ngamma\nui-delta");
		assert.doesNotMatch(shared, /<<<<<<<|=======|>>>>>>>/);
		const record = JSON.parse(git(repo, ["show", `${result.sha}:.madgrix/subagent-intents.json`]));
		assert.equal(record.resolution, "combined");
		assert.deepEqual(
			record.claims.map((claim: { id: string; intent: string }) => `${claim.id}:${claim.intent}`),
			crew.subs.map((sub) => `${sub.id}:${sub.intent}`),
		);
	});

	it("keeps both intents when sub-agents touch the same file", () => {
		const repo = initFork();
		const crew = loadForkCrew();
		for (const sub of crew.subs) {
			sub.paths = ["src/shared.js"];
		}
		crew.subs[0].command = "mkdir -p src && printf '%s\\n' 'api-body' > src/shared.js";
		crew.subs[1].command = "mkdir -p src && printf '%s\\n' 'ui-body' > src/shared.js";
		const result = runCrewOnFork(repo, crew);
		assert.deepEqual(result.overlap, ["src/shared.js"]);
		assert.equal(result.resolution, "conflict-both-intents-kept");
		for (const commit of result.commits) {
			assert.ok(isAncestor(repo, commit.sha, result.sha));
		}
		const shared = git(repo, ["show", `${result.sha}:src/shared.js`]);
		assert.match(shared, /<<<<<<< sub-api/);
		assert.match(shared, /api-body/);
		assert.match(shared, /ui-body/);
		assert.match(shared, />>>>>>> sub-ui/);
		const record = JSON.parse(git(repo, ["show", `${result.sha}:.madgrix/subagent-intents.json`]));
		assert.equal(record.resolution, "conflict-both-intents-kept");
		assert.deepEqual(
			record.claims.map((claim: { id: string; intent: string }) => `${claim.id}:${claim.intent}`),
			crew.subs.map((sub) => `${sub.id}:${sub.intent}`),
		);
		assert.notEqual(shared.trim(), "api-body");
		assert.notEqual(shared.trim(), "ui-body");
	});

	it("does not write the combined commit when TheUstad does not verify", () => {
		const repo = initFork();
		const crew = loadForkCrew();
		const head = git(repo, ["rev-parse", "HEAD"]);
		assert.throws(
			() =>
				runCrewOnFork(repo, crew, undefined, (worktree) => {
					verifyFrozenBaseline(worktree, "0".repeat(40));
				}),
			/TheUstad blocked the combined commit: FINAL FALSIFIED/,
		);
		assert.equal(git(repo, ["rev-parse", "HEAD"]), head);
		assert.equal(git(repo, ["status", "--porcelain"]), "");
		assert.equal(git(repo, ["rev-parse", "HEAD"]), head);
	});
});
