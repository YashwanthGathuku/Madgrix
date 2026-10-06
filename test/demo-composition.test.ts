/**
 * Deterministic three-agent demo fixture.
 * node --test test/demo-composition.test.ts
 *
 * The git commits, the overlap, and the resolver commit are real.
 * The authority section stores that resolved SHA and refuses a contributing SHA.
 * It does not run the candidate's tests and it does not promote on Cloudflare.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256Hex } from "../src/lib/canonical.ts";
import { createAuthority, recordComposition, submitEvaluation, type Ctx } from "../src/lib/task-state.ts";
import type { EvaluationBundle } from "../src/lib/types.ts";
import { authorityComposition, loadForkCrew, resolveComposition, runCrewOnFork } from "../scripts/lib/fork-crew.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const demoConfig = path.join(root, "configs/demo-composition.json");
const resolver = path.join(root, "scripts/demo-resolve.mjs");
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
	const dir = mkdtempSync(path.join(tmpdir(), "madgrix-demo-"));
	dirs.push(dir);
	git(dir, ["init", "--quiet", "--initial-branch=main"]);
	writeFileSync(path.join(dir, "README.md"), "baseline\n");
	git(dir, ["add", "-A"]);
	git(dir, ["commit", "--quiet", "-m", "baseline"]);
	return dir;
}

after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("demo composition fixture", () => {
	it("three agents overlap once, resolve to a new SHA, and that SHA is the only composition candidate", async () => {
		const crew = loadForkCrew(demoConfig);
		assert.deepEqual(
			crew.subs.map((sub) => sub.id),
			["sub-api", "sub-ui", "sub-test"],
		);
		const testAgent = crew.subs.find((sub) => sub.id === "sub-test");
		assert.ok(testAgent);
		assert.equal(testAgent.paths.includes("**"), false);
		assert.equal(testAgent.command.includes("CONTROL_SERVICE_TOKEN"), false);
		assert.equal(testAgent.command.includes("EVALUATION_SERVICE_TOKEN"), false);

		const repo = initFork();
		const head = git(repo, ["rev-parse", "HEAD"]);
		const stamp = path.join(tmpdir(), `madgrix-demo-stamp-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		for (const sub of crew.subs) {
			sub.command += ` && node -e ${JSON.stringify(
				`const fs=require("fs"); const stamp=${JSON.stringify(stamp)}; fs.appendFileSync(stamp, process.env.MADGRIX_AGENT_ID+":s:"+Date.now()+"\\n"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,500); fs.appendFileSync(stamp, process.env.MADGRIX_AGENT_ID+":e:"+Date.now()+"\\n");`,
			)}`;
		}
		const conflicted = await runCrewOnFork(repo, crew);
		const marks = readFileSync(stamp, "utf8")
			.trim()
			.split("\n")
			.map((line) => {
				const [id, kind, ts] = line.split(":");
				return { id, kind, ts: Number(ts) };
			});
		const starts = marks.filter((mark) => mark.kind === "s").map((mark) => mark.ts);
		const ends = marks.filter((mark) => mark.kind === "e").map((mark) => mark.ts);
		assert.equal(starts.length, 3);
		assert.equal(ends.length, 3);
		assert.ok(Math.max(...starts) < Math.min(...ends));

		assert.equal(conflicted.status, "CONFLICTED");
		assert.equal(conflicted.sha, null);
		assert.deepEqual(conflicted.overlap, ["src/contract.js"]);
		assert.equal(git(repo, ["rev-parse", "HEAD"]), head);
		assert.equal(conflicted.commits.length, 3);
		const conflict = conflicted.conflict;
		assert.equal(conflict.files[0].classification, "textual-line-overlap");
		assert.deepEqual(
			conflict.files[0].sides.map((side: { agent_id: string }) => side.agent_id).sort(),
			["sub-api", "sub-ui"],
		);
		assert.equal(conflict.agents.some((agent: { id: string }) => agent.id === "sub-test"), true);

		const leaked = spawnSync(process.execPath, [resolver], {
			cwd: repo,
			encoding: "utf8",
			env: {
				PATH: process.env.PATH ?? "",
				MADGRIX_CONFLICT_PATH: ".madgrix/conflict.json",
				MADGRIX_BASELINE_SHA: head,
				CONTROL_SERVICE_TOKEN: "not-a-real-token-value",
			},
		});
		assert.equal(leaked.status, 1);
		assert.match(leaked.stderr ?? "", /service credential/);

		const resolved = resolveComposition(repo, conflicted, `node ${JSON.stringify(resolver)}`);
		assert.equal(resolved.status, "RESOLVED");
		assert.equal(conflicted.commits.some((commit) => commit.sha === resolved.sha), false);
		assert.equal(git(repo, ["rev-parse", "HEAD"]), resolved.sha);
		assert.match(git(repo, ["show", `${resolved.sha}:src/api/handler.js`]), /api/);
		assert.match(git(repo, ["show", `${resolved.sha}:src/ui/view.js`]), /ui/);
		assert.match(git(repo, ["show", `${resolved.sha}:test/integration/check.js`]), /api\+ui/);
		assert.equal(git(repo, ["show", `${resolved.sha}:src/contract.js`]), 'export const label = "api+ui";');
		assert.doesNotMatch(git(repo, ["show", `${resolved.sha}:src/contract.js`]), /<<<<<<<|>>>>>>>/);

		const recorded = authorityComposition({
			status: "RESOLVED",
			contender_id: "contender-demo",
			baseline: conflicted.baseline,
			commits: conflicted.commits,
			conflict: conflicted.conflict,
			sha: resolved.sha,
		});
		const ctx: Ctx = {
			now: () => "2026-10-06T12:00:00.000Z",
			randomHex: (n: number) => "a".repeat(n * 2),
			sha256Hex,
			selectorPolicyHash: "policyhash",
			policyVersion: "seam-policy/0.1.0",
		};
		const state = createAuthority({
			task_id: "demo-task",
			task_hash: "demo-task-hash",
			intent: "compose api, ui, and an integration check",
			baseline_repo: "demo/repo",
			baseline_commit: conflicted.baseline,
			behavior_contract: "label is api+ui",
			policy_version: "seam-policy/0.1.0",
			frozen_at: "2026-10-06T11:00:00Z",
		});
		state.contenders["contender-demo"] = {
			contender_id: "contender-demo",
			agent_id: "parent",
			fork_repo: "fork-demo",
			fork_lineage: { parent_repo: "demo/repo", parent_commit: conflicted.baseline },
			fork_base: conflicted.baseline,
			token_id: "tok-demo",
			status: "forked",
			claim_work_id: null,
			latest_commit: resolved.sha,
		};
		const stored = await recordComposition(state, recorded, ctx);
		assert.equal(stored.composition?.status, "RESOLVED");
		assert.equal(stored.composition?.candidate_sha, resolved.sha);
		const side = conflicted.commits[0].sha;
		const rest = {
			candidate_sha: side,
			tree_sha256: "tree-side",
			contender_id: "contender-demo",
			task_hash: "demo-task-hash",
			admission: {
				exact_baseline: true,
				scope_compliance: true,
				valid_tool_states: true,
				no_eval_tampering: true,
				provenance_complete: true,
			},
			hidden_oracle: { passed: true, total: 1, failed: [] as string[] },
			regressions: { passed: true, total: 1, failed: [] as string[] },
			static_analysis: { passed: true, findings: [] as string[] },
			semantic_checks: { passed: true, total: 1, failed: [] as string[] },
			security_policy: { passed: true, findings: [] as string[] },
			evaluated_at: "2026-10-06T12:00:00Z",
			tainted: false,
		};
		const bundle: EvaluationBundle = { ...rest, bundle_hash: await sha256Hex(canonicalJson(rest)) };
		await assert.rejects(submitEvaluation(stored, bundle, { zone: "evaluation_domain" }, ctx), /contributing SHA/);
	});
});
