/**
 * Moving `main` in a shared repository with compare-and-swap.
 *
 * Every control-plane step works on a detached HEAD. `main` moves only through
 * publishMain, which runs `git update-ref refs/heads/main <new> <expected-old>`:
 * git refuses the update when main is no longer at the expected commit (for
 * example another crew published in the meantime), and the caller refuses the
 * result instead of overwriting the other run's commit.
 */
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { withRepoLock } from "./repo-lock.mjs";
import { safeGit } from "./safe-git.mjs";

const ZERO = "0".repeat(40);

export class MainMovedError extends Error {
	/** @param {string | null} expected @param {string | null} found */
	constructor(expected, found) {
		super(`main moved: expected ${expected ?? "no main"}, found ${found ?? "no main"}; refusing to overwrite another run's main`);
		this.name = "MainMovedError";
		this.expected = expected;
		this.found = found;
	}
}

/** @param {string} repo @returns {string | null} */
export function readMain(repo) {
	const r = safeGit(repo, ["rev-parse", "--verify", "--quiet", "refs/heads/main^{commit}"], { allowFailure: true });
	return r.status === 0 ? r.stdout.trim() : null;
}

/**
 * Check out `sha` detached (working tree and index), then attach HEAD to main
 * when main is at `sha`. Never moves main.
 * @param {string} repo
 * @param {string} sha
 */
export function restoreCheckout(repo, sha) {
	withRepoLock(repo, () => restoreUnlocked(repo, sha));
}

/** @param {string} repo @param {string} sha */
function restoreUnlocked(repo, sha) {
	safeGit(repo, ["checkout", "--quiet", "--detach", "-f", sha], { allowFailure: true });
	safeGit(repo, ["reset", "--quiet", "--hard", sha], { allowFailure: true });
	safeGit(repo, ["clean", "-fdq"], { allowFailure: true });
	if (readMain(repo) === sha) safeGit(repo, ["symbolic-ref", "HEAD", "refs/heads/main"], { allowFailure: true });
}

/**
 * Move main from `expected` to `sha` atomically and check it out. Throws
 * MainMovedError (and leaves main alone) when main is not at `expected`.
 * @param {string} repo
 * @param {string} sha
 * @param {string | null} expected  null: main must not exist yet
 */
export function publishMain(repo, sha, expected) {
	withRepoLock(repo, () => {
		const r = safeGit(repo, ["update-ref", "-m", "madgrix publish", "refs/heads/main", sha, expected ?? ZERO], { allowFailure: true });
		if (r.status !== 0) throw new MainMovedError(expected, readMain(repo));
		restoreUnlocked(repo, sha);
	});
}

/** Rebase attempts after a lost compare-and-swap; MADGRIX_MAIN_REBASE_RETRIES (0 refuses at once). */
export const DEFAULT_MAIN_REBASE_RETRIES = 3;

/** @param {NodeJS.ProcessEnv} [env] */
export function mainRebaseRetries(env = process.env) {
	const raw = env.MADGRIX_MAIN_REBASE_RETRIES;
	if (raw === undefined || raw === "") return DEFAULT_MAIN_REBASE_RETRIES;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < 0 || n > 20) throw new Error("MADGRIX_MAIN_REBASE_RETRIES must be an integer from 0 to 20");
	return n;
}

/** Control-plane record files under .madgrix/ are the candidate's own. */
const CANDIDATE_OWNED = ".madgrix/";

/**
 * Replay `candidate` (a commit whose first-class base is `oldBase`) onto
 * `newMain`: a three-way merge of the trees with `oldBase` as the merge base.
 * Files under .madgrix/ (this run's composition record and logs) are taken
 * from the candidate. The new commit's parents are `newMain` and the
 * candidate's other parents (the sub-agent commits), so it keeps the
 * baseline-plus-contributing shape the authority checks.
 * Nothing moves: no ref, no checkout.
 *
 * @param {string} repo
 * @param {string} candidate
 * @param {string} oldBase
 * @param {string} newMain
 * @returns {{ ok: true, sha: string } | { ok: false, reason: string }}
 */
export function rebaseCandidate(repo, candidate, oldBase, newMain) {
	if (safeGit(repo, ["merge-base", "--is-ancestor", oldBase, newMain], { allowFailure: true }).status !== 0) {
		return { ok: false, reason: `main (${newMain.slice(0, 12)}) does not descend from ${oldBase.slice(0, 12)}; not rebasing` };
	}
	const owned = safeGit(repo, ["ls-tree", "-r", "-z", "--full-tree", candidate, "--", CANDIDATE_OWNED]).stdout.split("\0").filter(Boolean);
	const index = path.join(os.tmpdir(), `madgrix-rebase-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	let ours;
	try {
		const env = { GIT_INDEX_FILE: index };
		safeGit(repo, ["read-tree", newMain], { env });
		safeGit(repo, ["rm", "-r", "-q", "-f", "--cached", "--ignore-unmatch", "--", CANDIDATE_OWNED], { env });
		if (owned.length > 0) {
			const info = owned.map((line) => {
				const [meta, file] = line.split("\t");
				const [mode, , oid] = meta.split(" ");
				return `${mode} ${oid}\t${file}`;
			});
			safeGit(repo, ["update-index", "-z", "--index-info"], { env, input: `${info.join("\0")}\0` });
		}
		ours = safeGit(repo, ["write-tree"], { env }).stdout.trim();
	} finally {
		rmSync(index, { force: true });
	}
	const merged = safeGit(repo, ["merge-tree", "--write-tree", "--name-only", "--no-messages", `--merge-base=${oldBase}`, ours, candidate], { allowFailure: true });
	if (merged.status !== 0) {
		const paths = merged.stdout.split("\n").slice(1).filter(Boolean);
		return { ok: false, reason: `the candidate does not rebase cleanly onto main ${newMain.slice(0, 12)} (${paths.join(", ") || "merge failed"})` };
	}
	const tree = merged.stdout.split("\n")[0].trim();
	const parents = safeGit(repo, ["rev-list", "--parents", "-n", "1", candidate]).stdout.trim().split(" ").slice(1);
	const rest = parents.filter((p) => p !== oldBase);
	const message = safeGit(repo, ["log", "-1", "--format=%B", candidate]).stdout;
	const [an, ae, cn, ce] = safeGit(repo, ["log", "-1", "--format=%an%x00%ae%x00%cn%x00%ce", candidate]).stdout.trim().split("\0");
	const ident = { GIT_AUTHOR_NAME: an, GIT_AUTHOR_EMAIL: ae, GIT_COMMITTER_NAME: cn, GIT_COMMITTER_EMAIL: ce };
	const sha = safeGit(repo, ["commit-tree", tree, "-p", newMain, ...rest.flatMap((p) => ["-p", p]), "-F", "-"], { input: message, env: ident }).stdout.trim();
	return { ok: true, sha };
}

/**
 * Publish with compare-and-swap; when another run moved main, rebase the
 * candidate onto the new main, re-verify it with `reverify`, and try again,
 * at most `retries` times. A candidate is never published on a new base
 * without passing `reverify` there.
 *
 * @template W
 * @param {string} repo
 * @param {string} sha
 * @param {string | null} expected
 * @param {{ retries?: number, reverify: ((sha: string, base: string) => { ok: boolean, reason?: string, witness?: W }) | null }} opts
 * @returns {{ ok: true, sha: string, base: string | null, rebases: Array<{ onto: string, sha: string }>, witness: W | null }
 *         | { ok: false, reason: string, rebases: Array<{ onto: string, sha: string }> }}
 */
export function publishWithRebase(repo, sha, expected, opts) {
	const retries = opts.retries ?? mainRebaseRetries();
	/** @type {Array<{ onto: string, sha: string }>} */
	const rebases = [];
	/** @type {W | null} */
	let witness = null;
	let current = sha;
	let base = expected;
	for (let attempt = 0; ; attempt += 1) {
		try {
			publishMain(repo, current, base);
			return { ok: true, sha: current, base, rebases, witness };
		} catch (error) {
			if (!(error instanceof MainMovedError)) throw error;
			const tail = rebases.length > 0 ? ` (after ${rebases.length} rebase${rebases.length === 1 ? "" : "s"})` : "";
			if (attempt >= retries) return { ok: false, reason: `${error.message}${tail}`, rebases };
			if (error.found === null || base === null) return { ok: false, reason: error.message, rebases };
			const rebased = rebaseCandidate(repo, current, base, error.found);
			if (!rebased.ok) return { ok: false, reason: `${error.message}; ${rebased.reason}`, rebases };
			if (opts.reverify) {
				const check = opts.reverify(rebased.sha, error.found);
				if (!check.ok) {
					return { ok: false, reason: `${error.message}; the candidate rebased onto it failed re-verification: ${check.reason ?? "not admitted"}`, rebases };
				}
				witness = check.witness ?? null;
			}
			rebases.push({ onto: error.found, sha: rebased.sha });
			current = rebased.sha;
			base = error.found;
		}
	}
}
