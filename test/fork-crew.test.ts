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

import { authorityComposition, crewAgentIds, loadForkCrew, resolveComposition, runCrewOnFork, verifyFrozenBaseline } from "../scripts/lib/fork-crew.mjs";

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

	it("puts two sub-agent commits on one fork and combines them into one SHA", async () => {
		const repo = initFork();
		const crew = loadForkCrew();
		const result = await runCrewOnFork(repo, crew);
		assert.equal(result.status, "COMPOSED");
		assert.equal(result.commits.length, 2);
		assert.equal(result.overlap.length, 0);
		assert.equal(result.resolution, "COMPOSED");
		assert.equal(typeof result.sha, "string");
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


	it("applies both edits when changed lines in one file do not overlap", async () => {
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
		const result = await runCrewOnFork(repo, crew);
		assert.equal(result.status, "COMPOSED");
		assert.deepEqual(result.overlap, []);
		assert.equal(result.resolution, "COMPOSED");
		assert.ok(result.sha);
		const shared = git(repo, ["show", `${result.sha}:src/shared.js`]);
		assert.equal(shared, "api-alpha\nbeta\ngamma\nui-delta");
		assert.doesNotMatch(shared, /<<<<<<<|=======|>>>>>>>/);
		const record = JSON.parse(git(repo, ["show", `${result.sha}:.madgrix/subagent-intents.json`]));
		assert.equal(record.resolution, "COMPOSED");
		assert.deepEqual(
			record.claims.map((claim: { id: string; intent: string }) => `${claim.id}:${claim.intent}`),
			crew.subs.map((sub) => `${sub.id}:${sub.intent}`),
		);
	});

	it("does not make a candidate when sub-agents overlap the same lines", async () => {
		const repo = initFork();
		const head = git(repo, ["rev-parse", "HEAD"]);
		const crew = loadForkCrew();
		for (const sub of crew.subs) {
			sub.paths = ["src/shared.js"];
		}
		crew.subs[0].command = "mkdir -p src && printf '%s\\n' 'api-body' > src/shared.js";
		crew.subs[1].command = "mkdir -p src && printf '%s\\n' 'ui-body' > src/shared.js";
		const result = await runCrewOnFork(repo, crew);
		assert.equal(result.status, "CONFLICTED");
		assert.equal(result.sha, null);
		assert.deepEqual(result.overlap, ["src/shared.js"]);
		assert.equal(git(repo, ["rev-parse", "HEAD"]), head);
		assert.equal(git(repo, ["status", "--porcelain"]), "");
		const names = git(repo, ["ls-tree", "-r", "--name-only", "HEAD"]).split("\n");
		assert.equal(names.includes("src/shared.js"), false);
		const conflict = result.conflict;
		assert.ok(conflict);
		assert.equal(conflict.baseline, head);
		assert.deepEqual(conflict.contributing_shas, result.commits.map((commit) => commit.sha));
		assert.equal(conflict.files.length, 1);
		assert.equal(conflict.files[0].path, "src/shared.js");
		assert.equal(conflict.files[0].classification, "textual-line-overlap");
		const bodies = conflict.files[0].sides.map((side) => side.text.trim());
		assert.deepEqual(bodies.sort(), ["api-body", "ui-body"]);
		assert.deepEqual(
			conflict.agents.map((agent: { id: string; intent: string }) => `${agent.id}:${agent.intent}`),
			crew.subs.map((sub) => `${sub.id}:${sub.intent}`),
		);
		const recorded = authorityComposition({
			status: "CONFLICTED",
			contender_id: "contender-1",
			baseline: result.baseline,
			commits: result.commits,
			conflict,
			sha: null,
		});
		assert.equal(recorded.candidate_sha, null);
		assert.equal(recorded.status, "CONFLICTED");
		assert.deepEqual(recorded.files[0].sides.map((side: { excerpt: string }) => side.excerpt.trim()).sort(), ["api-body", "ui-body"]);
	});

	it("a resolver commit is a new SHA and still not a promoted tree", async () => {
		const repo = initFork();
		const crew = loadForkCrew();
		for (const sub of crew.subs) sub.paths = ["src/shared.js"];
		crew.subs[0].command = "mkdir -p src && printf '%s\\n' 'api-body' > src/shared.js";
		crew.subs[1].command = "mkdir -p src && printf '%s\\n' 'ui-body' > src/shared.js";
		const conflicted = await runCrewOnFork(repo, crew);
		assert.equal(conflicted.status, "CONFLICTED");
		const resolved = resolveComposition(
			repo,
			conflicted,
			"mkdir -p src && printf '%s\\n' 'api-body' 'ui-body' > src/shared.js",
		);
		assert.equal(resolved.status, "RESOLVED");
		assert.notEqual(resolved.sha, conflicted.commits[0].sha);
		assert.notEqual(resolved.sha, conflicted.commits[1].sha);
		for (const commit of conflicted.commits) {
			assert.ok(isAncestor(repo, commit.sha, resolved.sha));
		}
		const shared = git(repo, ["show", `${resolved.sha}:src/shared.js`]);
		assert.equal(shared, "api-body\nui-body");
		assert.doesNotMatch(shared, /<<<<<<<|>>>>>>>/);
		const record = JSON.parse(git(repo, ["show", `${resolved.sha}:.madgrix/subagent-intents.json`]));
		assert.equal(record.status, "RESOLVED");
		assert.deepEqual(record.resolved_from, conflicted.commits.map((commit) => commit.sha));
		const recorded = authorityComposition({
			status: "RESOLVED",
			contender_id: "contender-1",
			baseline: conflicted.baseline,
			commits: conflicted.commits,
			conflict: conflicted.conflict,
			sha: resolved.sha,
		});
		assert.equal(recorded.candidate_sha, resolved.sha);
		assert.equal(recorded.contributing_shas.includes(resolved.sha), false);
	});

	it("runs the two sub-agent commands at the same time", async () => {
		const repo = initFork();
		// Forward slashes survive `bash -c` on Windows. See demo-composition.test.ts.
		const stamp = path.join(tmpdir(), `madgrix-stamp-${Date.now()}-${Math.random().toString(16).slice(2)}`).replace(/\\/g, "/");
		const crew = loadForkCrew();
		for (const sub of crew.subs) {
			const dir = sub.id === "sub-api" ? "src/api" : "src/ui";
			const file = sub.id === "sub-api" ? "src/api/handler.js" : "src/ui/view.js";
			const body = sub.id === "sub-api" ? "api" : "ui";
			sub.command = `node -e ${JSON.stringify(
				`const fs=require('fs'); const stamp=${JSON.stringify(stamp)}; fs.mkdirSync(${JSON.stringify(dir)},{recursive:true}); fs.writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(body + "\n")}); fs.appendFileSync(stamp, process.env.MADGRIX_AGENT_ID+':s:'+Date.now()+'\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,800); fs.appendFileSync(stamp, process.env.MADGRIX_AGENT_ID+':e:'+Date.now()+'\\n');`,
			)}`;
		}
		const result = await runCrewOnFork(repo, crew);
		assert.equal(result.status, "COMPOSED");
		const marks = readFileSync(stamp, "utf8")
			.trim()
			.split("\n")
			.map((line) => {
				const [id, kind, ts] = line.split(":");
				return { id, kind, ts: Number(ts) };
			});
		const starts = marks.filter((mark) => mark.kind === "s").map((mark) => mark.ts);
		const ends = marks.filter((mark) => mark.kind === "e").map((mark) => mark.ts);
		assert.equal(starts.length, 2);
		assert.equal(ends.length, 2);
		assert.ok(Math.max(...starts) < Math.min(...ends), "one command finished before the other started");
	});

	it("does not write the combined commit when TheUstad does not verify", async () => {
		const repo = initFork();
		const crew = loadForkCrew();
		const head = git(repo, ["rev-parse", "HEAD"]);
		await assert.rejects(
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
