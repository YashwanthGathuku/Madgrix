/**
 * One parent fork, role-scoped sub-agents, one combined SHA.
 *
 * Agentfleet is proprietary. This module does not vendor it. The live runner
 * calls `fleet validate` on configs/git4agents-fork-crew.yaml. Roles and file
 * areas come from configs/git4agents-fork-crew.json, which we own.
 *
 * Sub-agents do not get sibling repos. Each commits on a branch of the parent
 * fork. Disjoint edits become one merge commit that contains both. Overlapping
 * files are not silently resolved and neither intent is dropped: the combined
 * commit keeps conflict markers for those files and a record of both claims.
 */

import { spawnSync } from "node:child_process";
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
 * @param {{ id: string, intent: string, text: string }[]} parts
 */
function conflictText(parts) {
	const lines = parts.map((part, i) => {
		const marker = i === 0 ? `<<<<<<< ${part.id}` : "=======";
		return `${marker}\n# intent: ${part.intent}\n${part.text.endsWith("\n") ? part.text : `${part.text}\n`}`;
	});
	const last = parts[parts.length - 1];
	return `${lines.join("")}>>>>>>> ${last.id}\n# intent: ${last.intent}\n`;
}

/**
 * @param {string} repo
 * @param {string} baseline
 * @param {Array<{ id: string, role: string, intent: string, paths: string[], sha: string, claim_work_id?: string | null, files?: string[] }>} commits
 */
export function combineSubagentBranches(repo, baseline, commits) {
	if (commits.length < 2) throw new Error("combine needs at least two sub-agent commits");
	/** @type {Map<string, typeof commits>} */
	const owners = new Map();
	for (const commit of commits) {
		const names = git(repo, ["diff", "--name-only", baseline, commit.sha]).stdout.split("\n").filter(Boolean);
		if (names.length === 0) throw new Error(`${commit.id} changed no files`);
		for (const file of names) {
			if (file === RECORD_PATH) continue;
			if (!pathInScope(file, commit.paths)) {
				throw new Error(`${commit.id} changed ${file}, which is outside its role scope`);
			}
			const list = owners.get(file) ?? [];
			list.push(commit);
			owners.set(file, list);
		}
	}
	git(repo, ["checkout", "-B", "main", baseline]);
	git(repo, ["read-tree", baseline]);
	/** @type {string[]} */
	const overlap = [];
	for (const [file, group] of owners) {
		mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
		if (group.length === 1) {
			git(repo, ["checkout", group[0].sha, "--", file]);
			continue;
		}
		const merged = mergeDisjointEdits(repo, baseline, file, group);
		if (merged !== null) {
			writeFileSync(path.join(repo, file), merged);
			git(repo, ["add", "--", file]);
			continue;
		}
		overlap.push(file);
		const parts = group.map((owner) => ({
			id: owner.id,
			intent: owner.intent,
			text: blobText(repo, owner.sha, file),
		}));
		writeFileSync(path.join(repo, file), conflictText(parts));
		git(repo, ["add", "--", file]);
	}
	const record = {
		parent_fork: true,
		resolution: overlap.length === 0 ? "combined" : "conflict-both-intents-kept",
		overlap,
		claims: commits.map((commit) => ({
			id: commit.id,
			role: commit.role,
			intent: commit.intent,
			paths: commit.paths,
			commit: commit.sha,
			claim_work_id: commit.claim_work_id ?? null,
		})),
	};
	mkdirSync(path.join(repo, ".madgrix"), { recursive: true });
	writeFileSync(path.join(repo, RECORD_PATH), `${JSON.stringify(record, null, 2)}\n`);
	git(repo, ["add", "--", RECORD_PATH]);
	const tree = git(repo, ["write-tree"]).stdout.trim();
	const parentArgs = ["-p", baseline, ...commits.flatMap((commit) => ["-p", commit.sha])];
	const message = overlap.length
		? `MADGRIX conflict: both intents kept\n\n${commits.map((commit) => `${commit.id}: ${commit.intent}`).join("\n")}`
		: `MADGRIX combine\n\n${commits.map((commit) => `${commit.id}: ${commit.intent}`).join("\n")}`;
	const sha = git(repo, ["commit-tree", tree, ...parentArgs, "-m", message]).stdout.trim();
	git(repo, ["checkout", "-B", "main", sha]);
	return { sha, overlap, recordPath: RECORD_PATH, resolution: record.resolution };
}

/**
 * Run each sub-agent command on its own branch of `repo`, then combine.
 * `runSub` may record a claim_work_id on the sub object. It must not create
 * another repo.
 *
 * @param {string} repo
 * @param {ReturnType<typeof loadForkCrew>} crew
 * @param {(sub: ReturnType<typeof loadForkCrew>["subs"][number], repo: string) => void} [runSub]
 */
export function runCrewOnFork(repo, crew, runSub) {
	const baseline = git(repo, ["rev-parse", "HEAD"]).stdout.trim();
	/** @type {Array<{ id: string, role: string, intent: string, paths: string[], sha: string, claim_work_id: string | null, files: string[] }>} */
	const commits = [];
	for (const sub of crew.subs) {
		const branch = `madgrix/${sub.id}`;
		git(repo, ["checkout", "-B", branch, baseline]);
		if (runSub) runSub(sub, repo);
		else runConfiguredCommand(sub, repo);
		const files = porcelainPaths(git(repo, ["status", "--porcelain", "-uall"]).stdout);
		if (files.length === 0) throw new Error(`${sub.id} produced no change on the parent fork`);
		for (const file of files) {
			if (!pathInScope(file, sub.paths)) {
				throw new Error(`${sub.id} changed ${file}, which is outside its role scope`);
			}
		}
		git(repo, ["add", "-A"]);
		git(repo, ["commit", "-m", `MADGRIX sub-agent ${sub.id}: ${sub.intent}`]);
		const sha = git(repo, ["rev-parse", "HEAD"]).stdout.trim();
		const claimed = /** @type {{ claim_work_id?: string | null }} */ (sub).claim_work_id ?? null;
		commits.push({
			id: sub.id,
			role: sub.role,
			intent: sub.intent,
			paths: sub.paths,
			sha,
			claim_work_id: claimed,
			files,
		});
	}
	git(repo, ["checkout", "main"]);
	const combined = combineSubagentBranches(repo, baseline, commits);
	return { baseline, commits, ...combined };
}

/**
 * @param {{ id: string, role: string, intent: string, paths: string[], command: string }} sub
 * @param {string} repo
 */
function runConfiguredCommand(sub, repo) {
	const result = spawnSync("bash", ["-c", sub.command], {
		cwd: repo,
		encoding: "utf8",
		env: minimalEnv({
			MADGRIX_AGENT_ID: sub.id,
			MADGRIX_AGENT_ROLE: sub.role,
			MADGRIX_SCOPE_PATHS: sub.paths.join(","),
			MADGRIX_SUBAGENT_INTENT: sub.intent,
		}),
	});
	if (result.error || (result.status ?? 1) !== 0) {
		throw new Error(`${sub.id} command exited ${result.status ?? "signal"}`);
	}
}
