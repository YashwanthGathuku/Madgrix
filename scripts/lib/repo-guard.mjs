/**
 * The repository files that make git run code or change what it reads:
 * config, per-worktree config, every file a config pulls in through
 * `include.path` or `includeIf.<cond>.path` (followed recursively, wherever it
 * lives, whether or not the condition holds now), hooks, info/ (attributes,
 * exclude, sparse-checkout), object alternates, and every file in each watched
 * linked worktree's admin dir except git's own volatile state (index, logs,
 * refs, merge/rebase state, locks). HEAD is watched for being attached
 * (`ref: …`), not for which commit it is at. A sub-agent or resolver that
 * writes any of them is refused, and the files are restored, before
 * control-plane git touches the repository again.
 */
import os from "node:os";
import { lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { safeGit } from "./safe-git.mjs";

/** @param {string} repo */
export function gitCommonDir(repo) {
	return path.resolve(repo, safeGit(repo, ["rev-parse", "--git-common-dir"]).stdout.trim());
}

/**
 * @param {string} root
 * @param {string} rel
 * @param {Map<string, string>} out
 */
function collect(root, rel, out) {
	const full = path.join(root, rel);
	let stat;
	try {
		stat = lstatSync(full);
	} catch {
		return;
	}
	if (stat.isSymbolicLink()) out.set(rel, `link:${readlinkSync(full)}`);
	else if (stat.isDirectory()) {
		out.set(rel, `dir:${stat.mode & 0o7777}`);
		for (const name of readdirSync(full)) collect(root, path.join(rel, name), out);
	} else if (stat.isFile()) out.set(rel, `file:${stat.mode & 0o7777}:${readFileSync(full).toString("base64")}`);
	else out.set(rel, `special:${stat.mode}`);
}

/** Linked-worktree admin entries git itself rewrites during ordinary work. */
const VOLATILE_ADMIN = new Set([
	"index", "logs", "refs", "ORIG_HEAD", "FETCH_HEAD", "AUTO_MERGE", "MERGE_HEAD", "MERGE_MSG", "MERGE_MODE", "MERGE_RR",
	"CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD", "BISECT_LOG", "BISECT_START", "BISECT_TERMS", "BISECT_EXPECTED_REV",
	"BISECT_ANCESTORS_OK", "BISECT_NAMES", "rebase-merge", "rebase-apply", "sequencer", "COMMIT_EDITMSG",
]);

/**
 * @param {string} root
 * @param {string} dir  relative admin dir (worktrees/<name>)
 * @param {Map<string, string>} out
 */
function collectAdminDir(root, dir, out) {
	let names = [];
	try {
		names = readdirSync(path.join(root, dir));
	} catch {
		return;
	}
	for (const name of names) {
		if (VOLATILE_ADMIN.has(name) || name.endsWith(".lock")) continue;
		const rel = path.join(dir, name);
		if (name === "HEAD") {
			let head = "";
			try {
				head = readFileSync(path.join(root, rel), "utf8").trim();
			} catch {}
			out.set(rel, head.startsWith("ref:") ? `head:${head}` : "head:detached");
			continue;
		}
		collect(root, rel, out);
	}
}

const ABS = "@abs:";

/**
 * Include targets of one config file, as absolute paths.
 * @param {string} configFile
 * @returns {string[]}
 */
function includeTargets(configFile) {
	let text;
	try {
		if (!lstatSync(configFile).isFile()) return [];
		text = safeGit(path.dirname(configFile), ["config", "--file", configFile, "--null", "--get-regexp", "^include(if\\..*)?\\.path$"], {
			allowFailure: true,
		}).stdout;
	} catch {
		return [];
	}
	const out = [];
	for (const entry of text.split("\0").filter(Boolean)) {
		const nl = entry.indexOf("\n");
		if (nl === -1) continue;
		let value = entry.slice(nl + 1);
		if (value.startsWith("~/")) value = path.join(os.homedir(), value.slice(2));
		out.push(path.resolve(path.dirname(configFile), value));
	}
	return out;
}

/**
 * Follow include.path / includeIf.*.path from `configs` (absolute paths)
 * recursively and record every target's state under an "@abs:" key.
 * @param {string[]} configs
 * @param {Map<string, string>} out
 */
function collectIncludes(configs, out) {
	const seen = new Set();
	const queue = [...configs];
	while (queue.length > 0 && seen.size < 256) {
		const file = /** @type {string} */ (queue.shift());
		for (const target of includeTargets(file)) {
			if (seen.has(target)) continue;
			seen.add(target);
			const key = `${ABS}${target}`;
			let stat;
			try {
				stat = lstatSync(target);
			} catch {
				out.set(key, "absent");
				continue;
			}
			if (stat.isFile()) {
				out.set(key, `file:${stat.mode & 0o7777}:${readFileSync(target).toString("base64")}`);
				queue.push(target);
			} else if (stat.isSymbolicLink()) out.set(key, `link:${readlinkSync(target)}`);
			else out.set(key, `special:${stat.mode}`);
		}
	}
}

/** @param {string} root @param {string} rel */
const fullPath = (root, rel) => (rel.startsWith(ABS) ? rel.slice(ABS.length) : path.join(root, rel));

/**
 * @param {string} repo
 * @param {{ worktrees?: string[] }} [opts] linked-worktree admin dir names to
 *   include (default: all). A crew passes only its own, so another crew adding
 *   or removing worktrees concurrently is not mistaken for tampering.
 * @returns {{ root: string, files: Map<string, string>, worktrees?: string[] }}
 */
export function snapshotControlFiles(repo, opts = {}) {
	const root = gitCommonDir(repo);
	/** @type {Map<string, string>} */
	const files = new Map();
	for (const rel of ["config", "config.worktree", "hooks", "info", "objects/info/alternates", "objects/info/http-alternates", "commondir"]) {
		collect(root, rel, files);
	}
	/** @type {string[]} */
	let worktrees = [];
	try {
		worktrees = readdirSync(path.join(root, "worktrees"));
	} catch {}
	if (opts.worktrees) worktrees = worktrees.filter((name) => opts.worktrees?.includes(name));
	const configs = [path.join(root, "config"), path.join(root, "config.worktree")];
	for (const name of worktrees) {
		collectAdminDir(root, path.join("worktrees", name), files);
		configs.push(path.join(root, "worktrees", name, "config.worktree"), path.join(root, "worktrees", name, "config"));
	}
	collectIncludes(configs, files);
	return { root, files, worktrees: opts.worktrees };
}

/**
 * Paths that differ between `before` and now.
 * @param {ReturnType<typeof snapshotControlFiles>} before
 * @param {ReturnType<typeof snapshotControlFiles>} [now]
 */
export function changedControlFiles(before, now = snapshotControlFiles(before.root, { worktrees: before.worktrees })) {
	const changed = new Set();
	for (const [rel, value] of before.files) if (now.files.get(rel) !== value) changed.add(rel);
	for (const rel of now.files.keys()) if (!before.files.has(rel)) changed.add(rel);
	return [...changed].sort();
}

/**
 * Put every control file back as it was in `before`; remove added ones.
 * @param {ReturnType<typeof snapshotControlFiles>} before
 */
export function restoreControlFiles(before) {
	const now = snapshotControlFiles(before.root, { worktrees: before.worktrees });
	const changed = changedControlFiles(before, now);
	// Remove additions deepest-first, then rewrite what existed.
	for (const rel of [...changed].sort((a, b) => b.length - a.length)) {
		if (!before.files.has(rel)) rmSync(fullPath(before.root, rel), { recursive: true, force: true });
	}
	for (const rel of [...changed].sort((a, b) => a.length - b.length)) {
		const value = before.files.get(rel);
		if (value === undefined) continue;
		const full = fullPath(before.root, rel);
		if (value === "absent") {
			rmSync(full, { recursive: true, force: true });
			continue;
		}
		if (value.startsWith("head:")) {
			// Only an attached HEAD is restored; a detached one is left at its commit.
			if (value !== "head:detached") writeFileSync(full, `${value.slice(5)}\n`);
			else {
				const text = readFileSync(full, "utf8").trim();
				if (text.startsWith("ref:")) {
					const sha = safeGit(path.dirname(full), ["rev-parse", "--verify", "--quiet", "HEAD"], {
						allowFailure: true,
						env: { GIT_DIR: path.dirname(full) },
					}).stdout.trim();
					writeFileSync(full, `${sha || "0".repeat(40)}\n`);
				}
			}
			continue;
		}
		if (value.startsWith("dir:")) {
			try {
				if (!lstatSync(full).isDirectory()) rmSync(full, { force: true });
			} catch {}
			mkdirSync(full, { recursive: true, mode: Number(value.slice(4)) });
			continue;
		}
		rmSync(full, { recursive: true, force: true });
		mkdirSync(path.dirname(full), { recursive: true });
		if (value.startsWith("link:")) symlinkSync(value.slice(5), full);
		else if (value.startsWith("file:")) {
			const [, mode, data] = value.split(":");
			writeFileSync(full, Buffer.from(data, "base64"), { mode: Number(mode) });
		}
	}
	return changed;
}
