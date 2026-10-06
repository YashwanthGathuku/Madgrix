/**
 * Write the judge page for configs/demo-composition.json.
 *
 * The git commits, the claim reports, and the resolved SHA are produced by
 * the same functions as the local fixture. The HTML banner says this is
 * fixture/demo input. Evaluation, verdict, permit, and promotion are not
 * invented for the empty sections. This does not deploy and does not talk
 * to Cloudflare.
 *
 *   node scripts/render-demo-graph.mjs [directory]
 *
 * Writes madgrix-demo-graph-conflicted.html and
 * madgrix-demo-graph-resolved.html. The default directory is the OS temp dir.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { sha256Hex } from "../src/lib/canonical.ts";
import { createAuthority, recordComposition, registerClaim } from "../src/lib/task-state.ts";
import { authorityComposition, loadForkCrew, resolveComposition, runCrewOnFork } from "./lib/fork-crew.mjs";
import { renderWorkGraphPage } from "../src/worker/work-graph-page.ts";

/**
 * `python3` on Windows is often the Store stub (exit 9009). TheUstad's
 * default is that name. Prefer a interpreter that actually starts.
 * @returns {string}
 */
function pythonCommand() {
	if (process.env.MADGRIX_PYTHON) return process.env.MADGRIX_PYTHON;
	for (const name of ["python3", "python"]) {
		const probe = spawnSync(name, ["--version"], { encoding: "utf8" });
		if (probe.status === 0) return name;
	}
	return "python3";
}

process.env.MADGRIX_PYTHON = pythonCommand();

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const demoConfig = path.join(root, "configs/demo-composition.json");
const resolver = path.join(root, "scripts/demo-resolve.mjs");
const TOKEN_ID = "token-id-must-stay-off-the-page";
const BANNER =
	"Fixture/demo input. Local git from configs/demo-composition.json. Not a Cloudflare run. Evaluation, verdict, permit, promotion, and offline verification are not recorded for this task.";

/**
 * @param {string} repo
 * @param {string[]} args
 * @returns {string}
 */
function git(repo, args) {
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
	if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
	return (result.stdout ?? "").trim();
}

/**
 * @param {string} agentId
 * @param {string[]} paths
 * @param {import("../src/lib/types.ts").TaskRecord} task
 * @returns {import("../src/lib/task-state.ts").NewClaimInput}
 */
function claimInput(agentId, paths, task) {
	return {
		agent: agentId,
		task: task.task_hash,
		baseline: task.baseline_commit,
		intent: { behavior: [task.intent] },
		scope: { paths, symbols: [] },
		contracts: { reads: [], modifies: [] },
		interfaces: [],
		schema_changes: [],
		expected_tests: [],
		lease: { claimed_at: "2026-10-06T12:00:00.000Z", expires_at: "2026-10-06T13:00:00.000Z" },
	};
}

const repo = mkdtempSync(path.join(tmpdir(), "madgrix-demo-graph-"));
try {
	git(repo, ["init", "--quiet", "--initial-branch=main"]);
	writeFileSync(path.join(repo, "README.md"), "baseline\n");
	git(repo, ["add", "-A"]);
	git(repo, ["commit", "--quiet", "-m", "baseline"]);

	const crew = loadForkCrew(demoConfig);
	const conflicted = await runCrewOnFork(repo, crew);
	if (conflicted.status !== "CONFLICTED" || conflicted.sha !== null) {
		throw new Error(`expected CONFLICTED with no SHA, got ${conflicted.status} ${conflicted.sha}`);
	}
	const resolved = resolveComposition(repo, conflicted, `node ${JSON.stringify(resolver)}`);
	if (resolved.status !== "RESOLVED") throw new Error(`expected RESOLVED, got ${resolved.status}`);
	if (conflicted.commits.some((commit) => commit.sha === resolved.sha)) {
		throw new Error("resolver SHA is a contributing SHA");
	}

	const task = {
		task_id: "demo-task",
		task_hash: "demo-task-hash",
		intent: "compose api, ui, and an integration check",
		baseline_repo: "demo/repo",
		baseline_commit: conflicted.baseline,
		behavior_contract: "label is api+ui",
		policy_version: "seam-policy/0.1.0",
		frozen_at: "2026-10-06T11:00:00Z",
	};
	let n = 0;
	const ctx = {
		now: () => "2026-10-06T12:00:00.000Z",
		/**
		 * @param {number} bytes
		 * @returns {string}
		 */
		randomHex: (bytes) => {
			n += 1;
			return `${n}`.repeat(bytes * 2).slice(0, bytes * 2);
		},
		sha256Hex,
		selectorPolicyHash: "policyhash",
		policyVersion: "seam-policy/0.1.0",
	};
	let state = createAuthority(task);
	/** @type {Record<string, string>} */
	const workIds = {};
	/** @type {string[]} */
	const secrets = [];
	for (const sub of crew.subs) {
		const registered = await registerClaim(state, claimInput(sub.id, sub.paths, task), ctx);
		state = registered.state;
		workIds[sub.id] = registered.claim.work_id;
		if (registered.agent_secret) secrets.push(registered.agent_secret);
		if (registered.claim.agent_secret_sha256) secrets.push(registered.claim.agent_secret_sha256);
	}
	const commits = conflicted.commits.map((commit) => ({ ...commit, claim_work_id: workIds[commit.id] ?? null }));
	/** @type {import("../src/lib/types.ts").ContenderRecord} */
	const contender = {
		contender_id: "contender-demo",
		agent_id: crew.parent.id,
		fork_repo: "fork-demo",
		fork_lineage: { parent_repo: "demo/repo", parent_commit: conflicted.baseline },
		fork_base: conflicted.baseline,
		token_id: TOKEN_ID,
		token_ids: [TOKEN_ID],
		status: "forked",
		claim_work_id: null,
		latest_commit: conflicted.baseline,
	};
	state.contenders["contender-demo"] = contender;
	const compositionInput = {
		contender_id: "contender-demo",
		baseline: conflicted.baseline,
		commits,
		conflict: conflicted.conflict,
	};
	state = await recordComposition(
		state,
		authorityComposition({ ...compositionInput, status: "CONFLICTED", sha: null }),
		ctx,
	);
	const conflictedHtml = renderWorkGraphPage(state, { fixtureBanner: BANNER });
	state = {
		...state,
		contenders: {
			"contender-demo": { ...contender, latest_commit: resolved.sha },
		},
	};
	state = await recordComposition(
		state,
		authorityComposition({ ...compositionInput, status: "RESOLVED", sha: resolved.sha }),
		ctx,
	);
	const resolvedHtml = renderWorkGraphPage(state, { fixtureBanner: BANNER });

	for (const html of [conflictedHtml, resolvedHtml]) {
		const leaked = [TOKEN_ID, ...secrets].filter((secret) => secret && html.includes(secret));
		if (leaked.length > 0) throw new Error("graph page included a secret or token id");
		if (!html.includes("Fixture/demo input")) throw new Error("fixture banner missing");
		if (html.includes("VERIFIED")) throw new Error("page claimed offline verification");
	}
	if (!conflictedHtml.includes("CONFLICTED") || !conflictedHtml.includes("Resolution state: unresolved")) {
		throw new Error("conflicted page did not show the unresolved record");
	}
	if (conflictedHtml.includes("New candidate")) throw new Error("conflicted page invented a candidate");
	if (!resolvedHtml.includes("RESOLVED") || !resolvedHtml.includes("New candidate")) {
		throw new Error("resolved page did not show the new candidate");
	}

	const dest = process.argv[2] ? path.resolve(process.argv[2]) : tmpdir();
	const conflictedOut = path.join(dest, "madgrix-demo-graph-conflicted.html");
	const resolvedOut = path.join(dest, "madgrix-demo-graph-resolved.html");
	writeFileSync(conflictedOut, conflictedHtml);
	writeFileSync(resolvedOut, resolvedHtml);
	console.log(conflictedOut);
	console.log(resolvedOut);
} finally {
	rmSync(repo, { recursive: true, force: true });
}
