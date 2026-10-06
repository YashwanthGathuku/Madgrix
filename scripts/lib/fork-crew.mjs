/**
 * One parent fork, role-scoped sub-agents, one combined SHA.
 *
 * Agentfleet is proprietary. This module does not vendor it. The live runner
 * calls `fleet validate` on configs/git4agents-fork-crew.yaml. Roles and file
 * areas come from configs/git4agents-fork-crew.json, which we own.
 *
 * Sub-agents do not get sibling repos. Each commits on its own worktree of the
 * parent fork, and those commands run concurrently. Disjoint edits, including
 * non-overlapping lines of one file, become one COMPOSED commit. Overlapping
 * lines are CONFLICTED: no commit is written, neither side is dropped, and the
 * result is not a candidate. A resolver may later write a new commit, which is
 * a new candidate and still has to be evaluated.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadContenderIds } from "./agentfleet-slots.mjs";
import { minimalEnv } from "./child-env.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const DEFAULT_FORK_CREW_CONFIG = path.join(repoRoot, "configs/git4agents-fork-crew.json");
export const DEFAULT_FORK_CREW_FLEET_CONFIG = path.join(repoRoot, "configs/git4agents-fork-crew.yaml");

const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RECORD_PATH = ".madgrix/subagent-intents.json";
const CONFLICT_PATH = ".madgrix/conflict.json";

/**
 * @param {string} glob
 * @returns {RegExp}
 */
function globToRegExp(glob) {
	const body = glob
		.replace(/\\/g, "/")
		.replace(/^\.\//, "")
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*/g, "\u0000")
		.replace(/\*/g, "[^/]*")
		.replace(/\u0000/g, ".*");
	return new RegExp(`^${body}$`);
}

/**
 * @param {string} file
 * @param {string[]} globs
 */
export function pathInScope(file, globs) {
	const norm = file.replace(/\\/g, "/").replace(/^\.\//, "");
	return globs.some((glob) => glob !== "**" && globToRegExp(glob).test(norm));
}

/**
 * @param {string} configPath
 */
export function loadForkCrew(configPath = DEFAULT_FORK_CREW_CONFIG) {
	/** @type {unknown} */
	let raw;
	try {
		raw = JSON.parse(readFileSync(configPath, "utf8"));
	} catch {
		throw new Error(`fork crew config is not readable JSON (${configPath})`);
	}
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("fork crew config must be an object");
	}
	const body = /** @type {{ parent?: unknown, subs?: unknown }} */ (raw);
	const parent = asMember(body.parent, "parent");
	if (!Array.isArray(body.subs) || body.subs.length < 2) {
		throw new Error("fork crew needs a parent and at least two sub-agents");
	}
	const subs = body.subs.map((sub, i) => asSub(sub, i));
	const ids = [parent.id, ...subs.map((sub) => sub.id)];
	if (new Set(ids).size !== ids.length) throw new Error("fork crew agent ids must be distinct");
	return { parent, subs };
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function asMember(value, label) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`fork crew ${label} must be an object`);
	}
	const row = /** @type {{ id?: unknown, role?: unknown, intent?: unknown }} */ (value);
	if (typeof row.id !== "string" || !AGENT_ID.test(row.id)) {
		throw new Error(`fork crew ${label} has an id Git4agents cannot enroll`);
	}
	if (typeof row.role !== "string" || row.role.length === 0) {
		throw new Error(`fork crew ${label} needs a role`);
	}
	if (typeof row.intent !== "string" || row.intent.length === 0) {
		throw new Error(`fork crew ${label} needs an intent`);
	}
	return { id: row.id, role: row.role, intent: row.intent };
}

/**
 * @param {unknown} value
 * @param {number} index
 */
function asSub(value, index) {
	const member = asMember(value, `subs[${index}]`);
	const row = /** @type {{ paths?: unknown, command?: unknown }} */ (value);
	if (!Array.isArray(row.paths) || row.paths.length === 0 || row.paths.some((p) => typeof p !== "string" || p.length === 0)) {
		throw new Error(`fork crew ${member.id} needs path globs`);
	}
	if (row.paths.includes("**")) {
		throw new Error(`fork crew ${member.id} has an unbounded path glob`);
	}
	if (typeof row.command !== "string" || row.command.length === 0) {
		throw new Error(`fork crew ${member.id} needs its own command`);
	}
	return { ...member, paths: /** @type {string[]} */ (row.paths), command: row.command };
}

/**
 * @param {{ parent: { id: string }, subs: { id: string }[] }} crew
 * @returns {string[]}
 */
export function crewAgentIds(crew) {
	return [crew.parent.id, ...crew.subs.map((sub) => sub.id)];
}

/**
 * Agentfleet must list the same ids, in crew order. Does not copy fleet source
 * and does not call `fleet run` (that would invoke a model).
 *
 * @param {{ parent: { id: string }, subs: { id: string }[] }} crew
 * @param {string} [fleetConfig]
 * @param {Record<string, string | undefined>} [env]
 */
export function assertFleetRoster(crew, fleetConfig = DEFAULT_FORK_CREW_FLEET_CONFIG, env = process.env) {
	const ids = loadContenderIds({
		env: { ...env, MADGRIX_FLEET_CONFIG: fleetConfig, MADGRIX_AGENT_IDS: undefined },
		configPath: fleetConfig,
		fleetBin: env.MADGRIX_FLEET_BIN,
	});
	const expected = crewAgentIds(crew);
	if (ids.join("\n") !== expected.join("\n")) {
		throw new Error(`fleet validate roster is ${ids.join(", ")}; fork crew is ${expected.join(", ")}`);
	}
	return ids;
}

/**
 * @param {string} repo
 * @param {string[]} args
 * @param {{ allowFailure?: boolean }} [opts]
 */
function git(repo, args, opts = {}) {
	const result = spawnSync("git", args, {
		cwd: repo,
		encoding: "utf8",
		env: gitEnv(),
	});
	if (result.error) throw new Error(`git ${args[0]} failed to start`);
	if ((result.status ?? 1) !== 0 && !opts.allowFailure) {
		const detail = (result.stderr || result.stdout || "").trim().split("\n")[0];
		throw new Error(`git ${args[0]} exited ${result.status}${detail ? `: ${detail}` : ""}`);
	}
	return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function gitEnv() {
	const name = process.env.GIT_AUTHOR_NAME ?? "Git4agents";
	const email = process.env.GIT_AUTHOR_EMAIL ?? "git4agents@madgrix.invalid";
	return minimalEnv({
		GIT_AUTHOR_NAME: name,
		GIT_AUTHOR_EMAIL: email,
		GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? name,
		GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? email,
	});
}

/**
 * @param {string} status
 * @returns {string[]}
 */
function porcelainPaths(status) {
	/** @type {string[]} */
	const files = [];
	for (const line of status.split("\n")) {
		if (!line.trim()) continue;
		const pathPart = line.slice(3).trim();
		const renamed = pathPart.split(" -> ");
		files.push(renamed[renamed.length - 1]);
	}
	return files;
}


/**
 * Text of a blob, or empty when the path does not exist at that commit.
 * @param {string} repo
 * @param {string} sha
 * @param {string} file
 */
function blobText(repo, sha, file) {
	const exists = git(repo, ["cat-file", "-e", `${sha}:${file}`], { allowFailure: true });
	if (exists.status !== 0) return "";
	return git(repo, ["show", `${sha}:${file}`]).stdout;
}

/**
 * Three-way merge of each version against the baseline. Returns the combined
 * text when changed lines do not overlap, or null when they do.
 * @param {string} repo
 * @param {string} baseline
 * @param {string} file
 * @param {Array<{ sha: string }>} group
 * @returns {string | null}
 */
function mergeDisjointEdits(repo, baseline, file, group) {
	const base = blobText(repo, baseline, file);
	let merged = blobText(repo, group[0].sha, file);
	for (let i = 1; i < group.length; i += 1) {
		const next = blobText(repo, group[i].sha, file);
		const step = threeWayMerge(base, merged, next);
		if (!step.clean) return null;
		merged = step.text;
	}
	return merged;
}

/**
 * @param {string} base
 * @param {string} ours
 * @param {string} theirs
 */
function threeWayMerge(base, ours, theirs) {
	const dir = mkdtempSync(path.join(os.tmpdir(), "madgrix-merge-"));
	try {
		writeFileSync(path.join(dir, "base"), base);
		writeFileSync(path.join(dir, "ours"), ours);
		writeFileSync(path.join(dir, "theirs"), theirs);
		const result = spawnSync("git", ["merge-file", "-p", "ours", "base", "theirs"], {
			cwd: dir,
			encoding: "utf8",
		});
		if (result.error || (result.status ?? 1) < 0) {
			throw new Error("git merge-file failed");
		}
		return { clean: result.status === 0, text: result.stdout ?? "" };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * @typedef {{ id: string, role: string, intent: string, paths: string[], sha: string, claim_work_id?: string | null, files?: string[] }} SubCommit
 */

/**
 * @param {SubCommit[]} commits
 */
function claimRecord(commits) {
	return commits.map((commit) => ({
		id: commit.id,
		role: commit.role,
		intent: commit.intent,
		paths: commit.paths,
		commit: commit.sha,
		claim_work_id: commit.claim_work_id ?? null,
	}));
}

/**
 * @param {string} repo
 * @param {string} baseline
 * @param {SubCommit[]} commits
 * @returns {{ owners: Map<string, SubCommit[]>, conflicts: Array<{ path: string, group: SubCommit[] }> }}
 */
function classifyEdits(repo, baseline, commits) {
	if (commits.length < 2) throw new Error("combine needs at least two sub-agent commits");
	/** @type {Map<string, SubCommit[]>} */
	const owners = new Map();
	for (const commit of commits) {
		const names = git(repo, ["diff", "--name-only", baseline, commit.sha]).stdout.split("\n").filter(Boolean);
		if (names.length === 0) throw new Error(`${commit.id} changed no files`);
		for (const file of names) {
			if (file === RECORD_PATH || file === CONFLICT_PATH || file.startsWith(".madgrix/sides/")) continue;
			if (!pathInScope(file, commit.paths)) {
				throw new Error(`${commit.id} changed ${file}, which is outside its role scope`);
			}
			const list = owners.get(file) ?? [];
			list.push(commit);
			owners.set(file, list);
		}
	}
	/** @type {Array<{ path: string, group: SubCommit[] }>} */
	const conflicts = [];
	for (const [file, group] of owners) {
		if (group.length < 2) continue;
		if (mergeDisjointEdits(repo, baseline, file, group) === null) conflicts.push({ path: file, group });
	}
	return { owners, conflicts };
}

/**
 * Control-plane composition record. The runner writes it into the result
 * file. live-e2e posts it with the control token. A coding agent never
 * receives that token, and the resolver does not receive it either.
 * Conflict side text is shortened to the display excerpt.
 *
 * @param {{ status: "COMPOSED" | "CONFLICTED" | "RESOLVED", baseline: string, commits: SubCommit[], conflict: { files: Array<{ path: string, classification: string, sides: Array<{ agent_id: string, role: string, intent: string, sha: string, text?: string }> }> } | null, sha: string | null, contender_id: string }} input
 */
export function authorityComposition(input) {
	const files = (input.conflict?.files ?? []).map((file) => ({
		path: file.path,
		classification: file.classification,
		sides: file.sides.map((side) => ({
			agent_id: side.agent_id,
			role: side.role,
			intent: side.intent,
			sha: side.sha,
			excerpt: typeof side.text === "string" ? side.text.slice(0, 400) : "",
		})),
	}));
	return {
		status: input.status,
		contender_id: input.contender_id,
		baseline: input.baseline,
		agents: input.commits.map((commit) => ({
			id: commit.id,
			role: commit.role,
			intent: commit.intent,
			sha: commit.sha,
			paths: commit.paths,
			claim_work_id: commit.claim_work_id ?? null,
		})),
		contributing_shas: input.commits.map((commit) => commit.sha),
		files,
		candidate_sha: input.status === "CONFLICTED" ? null : input.sha,
	};
}

/**
 * Resolver input. Side bodies stay here; the authority record keeps excerpts.
 *
 * @param {string} repo
 * @param {string} baseline
 * @param {SubCommit[]} commits
 * @param {Array<{ path: string, group: SubCommit[] }>} conflicts
 */
function conflictRecord(repo, baseline, commits, conflicts) {
	return {
		status: /** @type {const} */ ("CONFLICTED"),
		baseline,
		agents: claimRecord(commits),
		contributing_shas: commits.map((commit) => commit.sha),
		files: conflicts.map((conflict) => ({
			path: conflict.path,
			classification: "textual-line-overlap",
			sides: conflict.group.map((owner) => ({
				agent_id: owner.id,
				role: owner.role,
				intent: owner.intent,
				sha: owner.sha,
				text: blobText(repo, owner.sha, conflict.path),
			})),
		})),
	};
}

/**
 * @param {string} repo
 * @param {string} baseline
 * @param {SubCommit[]} commits
 * @param {Record<string, unknown>} record
 * @param {string} message
 */
function commitIndex(repo, baseline, commits, record, message) {
	mkdirSync(path.join(repo, ".madgrix"), { recursive: true });
	writeFileSync(path.join(repo, RECORD_PATH), `${JSON.stringify(record, null, 2)}\n`);
	git(repo, ["add", "--", RECORD_PATH]);
	const tree = git(repo, ["write-tree"]).stdout.trim();
	const parentArgs = ["-p", baseline, ...commits.flatMap((commit) => ["-p", commit.sha])];
	const sha = git(repo, ["commit-tree", tree, ...parentArgs, "-m", message]).stdout.trim();
	git(repo, ["checkout", "-B", "main", sha]);
	return sha;
}

/**
 * COMPOSED writes one commit whose parents are the baseline and every
 * sub-agent commit. CONFLICTED writes nothing: main stays at the baseline,
 * and the return value is the only conflict object.
 *
 * @param {string} repo
 * @param {string} baseline
 * @param {SubCommit[]} commits
 */
export function combineSubagentBranches(repo, baseline, commits) {
	const { owners, conflicts } = classifyEdits(repo, baseline, commits);
	if (conflicts.length > 0) {
		const conflict = conflictRecord(repo, baseline, commits, conflicts);
		return {
			status: /** @type {const} */ ("CONFLICTED"),
			sha: null,
			overlap: conflicts.map((conflict) => conflict.path),
			recordPath: null,
			resolution: /** @type {const} */ ("CONFLICTED"),
			conflict,
		};
	}
	git(repo, ["checkout", "-B", "main", baseline]);
	git(repo, ["read-tree", baseline]);
	for (const [file, group] of owners) {
		mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
		if (group.length === 1) {
			git(repo, ["checkout", group[0].sha, "--", file]);
			continue;
		}
		const merged = mergeDisjointEdits(repo, baseline, file, group);
		if (merged === null) throw new Error(`combine lost a conflict on ${file}`);
		writeFileSync(path.join(repo, file), merged);
		git(repo, ["add", "--", file]);
	}
	const record = {
		parent_fork: true,
		status: "COMPOSED",
		resolution: "COMPOSED",
		overlap: /** @type {string[]} */ ([]),
		claims: claimRecord(commits),
	};
	const sha = commitIndex(
		repo,
		baseline,
		commits,
		record,
		`MADGRIX compose\n\n${commits.map((commit) => `${commit.id}: ${commit.intent}`).join("\n")}`,
	);
	return {
		status: /** @type {const} */ ("COMPOSED"),
		sha,
		overlap: /** @type {string[]} */ ([]),
		recordPath: RECORD_PATH,
		resolution: /** @type {const} */ ("COMPOSED"),
		conflict: null,
	};
}

/** MIT commit of https://github.com/YashwanthGathuku/theustad branch claude/project-analysis-bugs-xdq0xz. */
export const THEUSTAD_MIT_COMMIT = "7d021cbbfede6db8b37ae01e49cd89919f80535d";

/**
 * Gate the combined commit. `python theustad.py` runs on the frozen baseline
 * with state and logs outside the agent workspace. Only exit 0 and
 * `FINAL VERIFIED` may continue. Hook mode is not used.
 *
 * @param {string} repo
 * @param {string} baseline
 */
export function verifyFrozenBaseline(repo, baseline) {
	const root = process.env.MADGRIX_THEUSTAD_ROOT || path.join(repoRoot, "third_party/theustad");
	const script = path.join(root, "theustad.py");
	const python = process.env.MADGRIX_PYTHON || "python3";
	const claim = path.join(repoRoot, "scripts/theustad-baseline-claim.py");
	const check = path.join(repoRoot, "scripts/theustad-baseline-check.py");
	const stateDir = mkdtempSync(path.join(os.tmpdir(), "madgrix-theustad-state-"));
	const logDir = mkdtempSync(path.join(os.tmpdir(), "madgrix-theustad-logs-"));
	const result = spawnSync(
		python,
		[
			script,
			"--repo",
			repo,
			"--cmd",
			`${python} ${claim}`,
			"--verifier",
			`${python} ${check} ${baseline}`,
			"--state-dir",
			stateDir,
			"--log",
			logDir,
			"--max-retries",
			"0",
			"--timeout",
			"30",
			"--no-color",
		],
		{
			cwd: root,
			encoding: "utf8",
			timeout: 60_000,
			env: minimalEnv({
				PYTHONDONTWRITEBYTECODE: "1",
				PYTHONUNBUFFERED: "1",
			}),
		},
	);
	const stdout = result.stdout ?? "";
	const finalLine = stdout.match(/^FINAL \S+$/m)?.[0] ?? "no FINAL line";
	if (result.error || (result.status ?? 1) !== 0 || finalLine !== "FINAL VERIFIED") {
		const exit = result.error ? result.error.message : String(result.status ?? "signal");
		throw new Error(`TheUstad blocked the combined commit: ${finalLine} (exit ${exit})`);
	}
}

/**
 * Run each sub-agent command in its own worktree of `repo`, concurrently,
 * then combine. `runSub` may record a claim_work_id on the sub object. It
 * must not create another repo. The worktree path is the directory it receives.
 *
 * @param {string} repo
 * @param {ReturnType<typeof loadForkCrew>} crew
 * @param {(sub: ReturnType<typeof loadForkCrew>["subs"][number], repo: string) => void | Promise<void>} [runSub]
 * @param {(repo: string, baseline: string) => void} [verify]
 */
export async function runCrewOnFork(repo, crew, runSub, verify = verifyFrozenBaseline) {
	const baseline = git(repo, ["rev-parse", "HEAD"]).stdout.trim();
	/** @type {Array<{ sub: ReturnType<typeof loadForkCrew>["subs"][number], wt: string }>} */
	const prepared = crew.subs.map((sub) => {
		const wt = mkdtempSync(path.join(os.tmpdir(), `madgrix-${sub.id}-`));
		git(repo, ["worktree", "add", "--quiet", "-b", `madgrix/${sub.id}`, wt, baseline]);
		return { sub, wt };
	});
	/** @type {SubCommit[]} */
	let commits = [];
	try {
		await Promise.all(prepared.map(({ sub, wt }) => (runSub ? runSub(sub, wt) : runConfiguredCommand(sub, wt))));
		commits = prepared.map(({ sub, wt }) => commitWorktree(sub, wt));
	} finally {
		for (const { wt } of prepared) {
			git(repo, ["worktree", "remove", "--force", wt], { allowFailure: true });
			rmSync(wt, { recursive: true, force: true });
		}
	}
	verify(repo, baseline);
	const combined = combineSubagentBranches(repo, baseline, commits);
	return { baseline, commits, ...combined };
}

/**
 * Apply a resolver command to a CONFLICTED crew result. The command sees the
 * baseline tree, `.madgrix/conflict.json`, and `.madgrix/sides/<agent>/`.
 * It does not receive a MADGRIX service token. The commit it produces is a
 * new candidate; this function does not evaluate or promote it.
 *
 * @param {string} repo
 * @param {{ status: string, baseline: string, commits: SubCommit[], conflict: ReturnType<typeof conflictRecord> | null }} crewResult
 * @param {string} command
 */
export function resolveComposition(repo, crewResult, command) {
	if (crewResult.status !== "CONFLICTED" || crewResult.conflict === null) {
		throw new Error("resolveComposition requires a CONFLICTED result");
	}
	if (typeof command !== "string" || command.length === 0) throw new Error("resolver command is empty");
	git(repo, ["checkout", "-B", "main", crewResult.baseline]);
	git(repo, ["reset", "--hard", crewResult.baseline]);
	mkdirSync(path.join(repo, ".madgrix"), { recursive: true });
	writeFileSync(path.join(repo, CONFLICT_PATH), `${JSON.stringify(crewResult.conflict, null, 2)}\n`);
	for (const file of crewResult.conflict.files) {
		for (const side of file.sides) {
			const dest = path.join(repo, ".madgrix", "sides", side.agent_id, file.path);
			mkdirSync(path.dirname(dest), { recursive: true });
			writeFileSync(dest, side.text);
		}
	}
	const result = spawnSync("bash", ["-c", command], {
		cwd: repo,
		encoding: "utf8",
		env: minimalEnv({
			MADGRIX_CONFLICT_PATH: CONFLICT_PATH,
			MADGRIX_BASELINE_SHA: crewResult.baseline,
		}),
	});
	if (result.error || (result.status ?? 1) !== 0) {
		throw new Error(`resolver exited ${result.status ?? "signal"}`);
	}
	const dirty = porcelainPaths(git(repo, ["status", "--porcelain", "-uall"]).stdout);
	if (dirty.length === 0) throw new Error("resolver produced no change");
	for (const file of crewResult.conflict.files) {
		let onDisk = "";
		try {
			onDisk = readFileSync(path.join(repo, file.path), "utf8");
		} catch {
			throw new Error(`resolver left ${file.path} unresolved`);
		}
		if (onDisk.includes("<<<<<<<") || onDisk.includes(">>>>>>>")) {
			throw new Error(`resolver left conflict markers in ${file.path}`);
		}
		if (!dirty.includes(file.path)) throw new Error(`resolver left ${file.path} unresolved`);
	}
	const record = {
		parent_fork: true,
		status: "RESOLVED",
		resolution: "RESOLVED",
		overlap: crewResult.conflict.files.map((file) => file.path),
		claims: claimRecord(crewResult.commits),
		resolved_from: crewResult.conflict.contributing_shas,
	};
	git(repo, ["add", "-A"]);
	const sha = commitIndex(
		repo,
		crewResult.baseline,
		crewResult.commits,
		record,
		`MADGRIX resolve\n\n${crewResult.commits.map((commit) => `${commit.id}: ${commit.intent}`).join("\n")}`,
	);
	return { status: /** @type {const} */ ("RESOLVED"), sha, resolution: /** @type {const} */ ("RESOLVED"), recordPath: RECORD_PATH };
}

/**
 * @param {ReturnType<typeof loadForkCrew>["subs"][number]} sub
 * @param {string} wt
 * @returns {SubCommit}
 */
function commitWorktree(sub, wt) {
	const files = porcelainPaths(git(wt, ["status", "--porcelain", "-uall"]).stdout);
	if (files.length === 0) throw new Error(`${sub.id} produced no change on the parent fork`);
	for (const file of files) {
		if (!pathInScope(file, sub.paths)) {
			throw new Error(`${sub.id} changed ${file}, which is outside its role scope`);
		}
	}
	git(wt, ["add", "-A"]);
	git(wt, ["commit", "-m", `MADGRIX sub-agent ${sub.id}: ${sub.intent}`]);
	const sha = git(wt, ["rev-parse", "HEAD"]).stdout.trim();
	const claimed = /** @type {{ claim_work_id?: string | null }} */ (sub).claim_work_id ?? null;
	return {
		id: sub.id,
		role: sub.role,
		intent: sub.intent,
		paths: sub.paths,
		sha,
		claim_work_id: claimed,
		files,
	};
}

/**
 * @param {{ id: string, role: string, intent: string, paths: string[], command: string }} sub
 * @param {string} repo
 * @returns {Promise<void>}
 */
function runConfiguredCommand(sub, repo) {
	const env = minimalEnv({
		MADGRIX_AGENT_ID: sub.id,
		MADGRIX_AGENT_ROLE: sub.role,
		MADGRIX_SCOPE_PATHS: sub.paths.join(","),
		MADGRIX_SUBAGENT_INTENT: sub.intent,
	});
	return new Promise((resolve, reject) => {
		const child = spawn("bash", ["-c", sub.command], { cwd: repo, env });
		child.on("error", () => reject(new Error(`${sub.id} command failed to start`)));
		child.on("close", (status) => {
			if (status !== 0) reject(new Error(`${sub.id} command exited ${status ?? "signal"}`));
			else resolve();
		});
	});
}
