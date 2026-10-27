/**
 * Per-repository control-plane lock (see withRepoLock).
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { safeGit } from "./safe-git.mjs";

/** @param {string} repo @param {string[]} args */
const git = (repo, args) => safeGit(repo, args);

/** @type {Map<string, number>} */
const heldLocks = new Map();

/**
 * Serialize control-plane work that moves `main` or writes the working tree
 * of `repo`, across processes. The lock is a directory in the repository's
 * git dir holding the owner's pid; a lock whose owner is gone is stale and is
 * taken over. Re-entrant within one process.
 *
 * @template T
 * @param {string} repo
 * @param {() => T} fn
 * @returns {T}
 */
export function withRepoLock(repo, fn) {
	const gitDir = path.resolve(repo, git(repo, ["rev-parse", "--git-common-dir"]).stdout.trim());
	const lock = path.join(gitDir, "madgrix-control.lock");
	const held = heldLocks.get(lock) ?? 0;
	if (held > 0) {
		heldLocks.set(lock, held + 1);
		try {
			return fn();
		} finally {
			heldLocks.set(lock, (heldLocks.get(lock) ?? 1) - 1);
		}
	}
	const deadline = Date.now() + Number(process.env.MADGRIX_LOCK_TIMEOUT_MS ?? 30 * 60_000);
	const sleeper = new Int32Array(new SharedArrayBuffer(4));
	for (;;) {
		try {
			mkdirSync(lock);
			writeFileSync(path.join(lock, "pid"), String(process.pid));
			break;
		} catch (error) {
			if (/** @type {NodeJS.ErrnoException} */ (error).code !== "EEXIST") throw error;
			let owner = NaN;
			try {
				owner = Number(readFileSync(path.join(lock, "pid"), "utf8"));
			} catch {}
			let alive = true;
			if (Number.isInteger(owner) && owner > 0) {
				try {
					process.kill(owner, 0);
				} catch (e) {
					alive = /** @type {NodeJS.ErrnoException} */ (e).code === "EPERM";
				}
			}
			if (!alive) {
				rmSync(lock, { recursive: true, force: true });
				continue;
			}
			if (Date.now() > deadline) throw new Error(`another control-plane run holds ${lock}`);
			Atomics.wait(sleeper, 0, 0, 25);
		}
	}
	heldLocks.set(lock, 1);
	try {
		return fn();
	} finally {
		heldLocks.delete(lock);
		rmSync(lock, { recursive: true, force: true });
	}
}

