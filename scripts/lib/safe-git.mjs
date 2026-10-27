/**
 * Control-plane git. Every git call the authority makes goes through here.
 *
 * A resolver or a sub-agent may have written to the repository it ran in
 * (hooks, `core.fsmonitor`, other config). Control-plane git therefore runs
 * with hooks and fsmonitor off, no system or global config, no pager, no
 * external diff, and path quoting off. Path lists are read NUL-separated
 * (`-z`) so no file name is ever C-quoted. The output cap is 1 GiB rather than
 * the spawnSync default of 1 MiB.
 */

import { spawnSync } from "node:child_process";
import { minimalEnv } from "./child-env.mjs";

/** `-c` overrides placed before every control-plane git subcommand. */
export const SAFE_GIT_CONFIG = Object.freeze([
	"-c", "core.hooksPath=/dev/null",
	"-c", "core.fsmonitor=false",
	"-c", "core.untrackedCache=false",
	"-c", "core.quotePath=false",
	"-c", "core.pager=cat",
	"-c", "diff.external=",
	"-c", "protocol.allow=never",
]);

export const GIT_MAX_BUFFER = 1 << 30;

/** Environment for control-plane git: minimal, no system or global config. */
/** @param {Record<string, string>} [extra] */
export function safeGitEnv(extra = {}) {
	return minimalEnv({
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_TERMINAL_PROMPT: "0",
		...extra,
	});
}

/**
 * @param {string} repo
 * @param {string[]} args
 * @param {{ allowFailure?: boolean, env?: Record<string, string>, input?: string | Buffer, buffer?: boolean }} [opts]
 * @returns {{ status: number, stdout: string, stderr: string, raw: Buffer | null }}
 */
export function safeGit(repo, args, opts = {}) {
	const result = spawnSync("git", [...SAFE_GIT_CONFIG, ...args], {
		cwd: repo,
		encoding: opts.buffer ? "buffer" : "utf8",
		maxBuffer: GIT_MAX_BUFFER,
		env: safeGitEnv(opts.env ?? {}),
		...(opts.input !== undefined ? { input: opts.input } : {}),
	});
	if (result.error) {
		const code = /** @type {NodeJS.ErrnoException} */ (result.error).code;
		throw new Error(`git ${args[0]} failed${code === "ENOBUFS" ? ": output exceeds 1 GiB" : " to start"}`);
	}
	const stderr = opts.buffer ? String(result.stderr ?? "") : String(result.stderr ?? "");
	const stdout = opts.buffer ? "" : String(result.stdout ?? "");
	if ((result.status ?? 1) !== 0 && !opts.allowFailure) {
		const detail = (stderr || stdout).trim().split("\n")[0];
		throw new Error(`git ${args[0]} exited ${result.status}${detail ? `: ${detail}` : ""}`);
	}
	return { status: result.status ?? 1, stdout, stderr, raw: opts.buffer ? /** @type {Buffer} */ (result.stdout) : null };
}

/**
 * Split NUL-separated git output (`-z`) into entries.
 * @param {string} text
 * @returns {string[]}
 */
export function splitZ(text) {
	return text.split("\0").filter((entry) => entry !== "");
}

/**
 * Paths of `git status --porcelain=v1 -z --no-renames -uall`, unquoted. With
 * renames off every entry is one `XY path` record.
 * @param {string} status
 */
export function porcelainZPaths(status) {
	return splitZ(status).map((/** @type {string} */ entry) => entry.slice(3));
}

/**
 * `git diff-index --cached --raw -z --no-renames <tree>` as records.
 * @param {string} raw
 * @returns {Array<{ srcMode: string, dstMode: string, status: string, path: string }>}
 */
export function parseRawZ(raw) {
	const parts = raw.split("\0");
	/** @type {Array<{ srcMode: string, dstMode: string, status: string, path: string }>} */
	const out = [];
	for (let i = 0; i + 1 < parts.length; i += 2) {
		const meta = parts[i];
		if (!meta.startsWith(":")) break;
		const [srcMode, dstMode, , , status] = meta.slice(1).split(" ");
		out.push({ srcMode, dstMode, status, path: parts[i + 1] });
	}
	return out;
}

/** @type {Map<string, Map<string, string>>} */
const treeModes = new Map();

/**
 * Mode of `file` at `sha` ("100644", "100755", "120000", "160000"), or null
 * when the path does not exist there. One `ls-tree -r` per commit, cached
 * (a commit's tree never changes).
 * @param {string} repo
 * @param {string} sha
 * @param {string} file
 */
export function modeAt(repo, sha, file) {
	const key = `${repo}\0${sha}`;
	let modes = treeModes.get(key);
	if (!modes) {
		modes = new Map();
		for (const entry of splitZ(safeGit(repo, ["ls-tree", "-r", "-z", "--full-tree", sha]).stdout)) {
			const tab = entry.indexOf("\t");
			modes.set(entry.slice(tab + 1), entry.slice(0, entry.indexOf(" ")));
		}
		if (treeModes.size > 4096) treeModes.clear();
		treeModes.set(key, modes);
	}
	return modes.get(file) ?? null;
}
