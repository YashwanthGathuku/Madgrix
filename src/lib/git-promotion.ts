/**
 * The promotion container's two scripts, seen from the control plane
 * (specs/amendments/rebase-ancestry-v1.md).
 *
 * - promotionHttpResult / rebaseHttpResult: how src/do/PromotionContainer.ts
 *   turns a script's exit status and `KEY=value` output into the answer the
 *   Worker receives. 200 is success; 409 is terminal for that request (the
 *   PromotionWorkflow does not retry it, and the permit stays unconsumed);
 *   502 is a git failure, which a retry may get past.
 * - runPromoteModel / runRebaseModel: container/promote.sh and
 *   container/rebase.sh restated step for step over an abstract git, so the
 *   in-memory harnesses (src/harness/fake-container.ts) promote and rebase
 *   exactly as the container would. test/fixtures/promotion-cases.json runs
 *   every case through both the real scripts and these models.
 *
 * Model limits: conflicts are found per path, not per line (git merges two
 * edits to different lines of one file; the model reports a conflict), and
 * candidate histories must be linear. Every fixture case is one both agree on.
 *
 * Pure: no I/O beyond the injected git.
 */

import { unresolvedMergeArtifacts } from "./merge-artifacts.ts";
import { treeDigestV1, type TreeDigestEntry } from "./tree-digest.ts";

/** A script run: what the container's exec reports. */
export interface ScriptRun {
	exit: number;
	stdout: string;
	stderr: string;
}

/** promote.sh's exit statuses. */
export const PROMOTE_EXIT = {
	OK: 0,
	EXPIRED_HEAD_MOVED: 42,
	TREE_MISMATCH: 43,
	PUSH_REJECTED: 44,
	CANDIDATE_MISMATCH: 45,
	UNSUPPORTED_TREE_ENTRY: 46,
	BASELINE_MISMATCH: 47,
	/** Blob conflict-marker pair. Not a semantic-conflict detector. Checked before any fast-forward, including ALREADY_WRITTEN. */
	UNRESOLVED_CONFLICT: 48,
} as const;

/** rebase.sh's exit statuses. */
export const REBASE_EXIT = {
	OK: 0,
	FORK_MOVED: 42,
	PUSH_REJECTED: 44,
	ONTO_MISMATCH: 45,
	ALREADY_IN_DESTINATION: 48,
	CONFLICT: 49,
} as const;

/** git's exit status for a fatal error (a failed fetch, an unknown object). */
export const GIT_FATAL = 128;

/** The tool-status log a rebase resolves to the candidate's version. */
export const TOOL_STATUS_LOG = ".madgrix/tool-status.jsonl";

/** Conflict paths kept in a result; the total is reported beside them. */
export const MAX_CONFLICT_PATHS = 1000;

/* ------------------------------------------------------------------ */
/* Output parsing and the HTTP mapping                                 */
/* ------------------------------------------------------------------ */

/** `KEY=value` lines; a later line wins. Values may contain "=". */
export function parseScriptOutput(stdout: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of stdout.split(/\r?\n/)) {
		const i = line.indexOf("=");
		if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
	}
	return out;
}

/** rebase.sh's CONFLICT_PATHS: base64 of NUL-terminated paths (raw bytes,
 *  so a path holding a newline or "=" survives). Decoded as UTF-8. */
export function decodeConflictPaths(b64: string): string[] {
	let binary: string;
	try {
		binary = atob(b64);
	} catch {
		return [];
	}
	const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
	const decoder = new TextDecoder("utf-8");
	const paths: string[] = [];
	let start = 0;
	for (let i = 0; i < bytes.length; i++) {
		if (bytes[i] === 0) {
			if (i > start) paths.push(decoder.decode(bytes.subarray(start, i)));
			start = i + 1;
		}
	}
	return paths;
}

export type PromotionResultOutcome =
	| "PROMOTED"
	| "ALREADY_WRITTEN"
	| "EXPIRED_HEAD_MOVED"
	| "TREE_MISMATCH"
	| "PUSH_REJECTED"
	| "UNSUPPORTED_TREE_ENTRY"
	| "BASELINE_MISMATCH"
	| "UNRESOLVED_CONFLICT"
	| "GIT_ERROR";

export interface PromotionResult {
	outcome: PromotionResultOutcome;
	promoted_sha?: string;
	tree_sha256?: string;
	/** The permit-bound destination head the promotion fast-forwarded from. */
	base?: string;
	/** The promoted commit's own first parent, read from git ("" for a root commit). */
	parent?: string;
	current_head?: string;
	detail?: string;
}

const HEX_SHA = /^[0-9a-f]{40,64}$/;

function gitError(exit: number, stderr: string, what: string): { status: number; body: PromotionResult & RebaseResult } {
	return { status: 502, body: { outcome: "GIT_ERROR", detail: stderr.trim() || `${what} failed with exit ${exit}` } };
}

/** promote.sh's exit status and output → the PromotionContainer's answer. */
export function promotionHttpResult(exit: number, stdout: string, stderr: string): { status: number; body: PromotionResult } {
	const f = parseScriptOutput(stdout);
	switch (exit) {
		case PROMOTE_EXIT.OK: {
			if (
				(f.OUTCOME !== "PROMOTED" && f.OUTCOME !== "ALREADY_WRITTEN") ||
				!HEX_SHA.test(f.PROMOTED_SHA ?? "") ||
				!/^[0-9a-f]{64}$/.test(f.TREE_DIGEST ?? "") ||
				!HEX_SHA.test(f.BASE ?? "") ||
				(f.PARENT !== "" && !HEX_SHA.test(f.PARENT ?? ""))
			) {
				return { status: 502, body: { outcome: "GIT_ERROR", detail: "promotion container returned no valid outcome" } };
			}
			return {
				status: 200,
				body: { outcome: f.OUTCOME, promoted_sha: f.PROMOTED_SHA, tree_sha256: f.TREE_DIGEST, base: f.BASE, parent: f.PARENT },
			};
		}
		case PROMOTE_EXIT.EXPIRED_HEAD_MOVED:
			return { status: 409, body: { outcome: "EXPIRED_HEAD_MOVED", current_head: f.CURRENT_HEAD } };
		case PROMOTE_EXIT.TREE_MISMATCH:
			return {
				status: 409,
				body: { outcome: "TREE_MISMATCH", tree_sha256: f.TREE_DIGEST, detail: "candidate tree digest does not match the permit" },
			};
		case PROMOTE_EXIT.PUSH_REJECTED:
			return {
				status: 409,
				body: { outcome: "PUSH_REJECTED", detail: "the destination refused the fast-forward; its head may have moved during promotion" },
			};
		case PROMOTE_EXIT.UNSUPPORTED_TREE_ENTRY:
			return {
				status: 409,
				body: { outcome: "UNSUPPORTED_TREE_ENTRY", detail: "the candidate tree holds a non-blob entry, which tree-digest/v1 cannot bind" },
			};
		case PROMOTE_EXIT.BASELINE_MISMATCH:
			return {
				status: 409,
				body: { outcome: "BASELINE_MISMATCH", detail: "reviewed candidate is not a descendant of the permit-bound destination head" },
			};
		case PROMOTE_EXIT.UNRESOLVED_CONFLICT:
			return {
				status: 409,
				body: {
					outcome: "UNRESOLVED_CONFLICT",
					detail: f.PATHS
						? `unresolved merge artifacts: ${f.PATHS}`
						: "unresolved merge artifacts in the candidate tree",
				},
			};
		default:
			return gitError(exit, stderr, "git promotion");
	}
}

export type RebaseResultOutcome =
	| "REBASED"
	| "UP_TO_DATE"
	| "FORK_MOVED"
	| "PUSH_REJECTED"
	| "ALREADY_IN_DESTINATION"
	| "CONFLICT"
	| "GIT_ERROR";

export interface RebaseResult {
	outcome: RebaseResultOutcome;
	/** REBASED: the new commit on the fork's main; UP_TO_DATE: the candidate. */
	rebased_sha?: string;
	onto?: string;
	fork_head?: string;
	/** CONFLICT: the conflicting paths (at most MAX_CONFLICT_PATHS). */
	paths?: string[];
	paths_total?: number;
	detail?: string;
}

/** rebase.sh's exit status and output → the PromotionContainer's answer. */
export function rebaseHttpResult(exit: number, stdout: string, stderr: string): { status: number; body: RebaseResult } {
	const f = parseScriptOutput(stdout);
	switch (exit) {
		case REBASE_EXIT.OK: {
			if ((f.OUTCOME !== "REBASED" && f.OUTCOME !== "UP_TO_DATE") || !HEX_SHA.test(f.REBASED_SHA ?? "") || !HEX_SHA.test(f.ONTO ?? "")) {
				return { status: 502, body: { outcome: "GIT_ERROR", detail: "rebase container returned no valid outcome" } };
			}
			return { status: 200, body: { outcome: f.OUTCOME, rebased_sha: f.REBASED_SHA, onto: f.ONTO } };
		}
		case REBASE_EXIT.FORK_MOVED:
			return { status: 409, body: { outcome: "FORK_MOVED", fork_head: f.FORK_HEAD } };
		case REBASE_EXIT.PUSH_REJECTED:
			return { status: 409, body: { outcome: "PUSH_REJECTED", detail: "the fork refused the rebased commit; it may have moved during the rebase" } };
		case REBASE_EXIT.ALREADY_IN_DESTINATION:
			return { status: 409, body: { outcome: "ALREADY_IN_DESTINATION", onto: f.ONTO } };
		case REBASE_EXIT.CONFLICT: {
			const paths = decodeConflictPaths(f.CONFLICT_PATHS ?? "");
			if (paths.length === 0 || !HEX_SHA.test(f.ONTO ?? "")) {
				return { status: 502, body: { outcome: "GIT_ERROR", detail: "rebase container reported a conflict without its paths" } };
			}
			return {
				status: 409,
				body: { outcome: "CONFLICT", onto: f.ONTO, paths: paths.slice(0, MAX_CONFLICT_PATHS), paths_total: paths.length },
			};
		}
		default:
			return gitError(exit, stderr, "git rebase");
	}
}

/* ------------------------------------------------------------------ */
/* promote.sh, modeled                                                  */
/* ------------------------------------------------------------------ */

/** The git operations promote.sh performs, over whatever stores the commits. */
export interface PromoteGit {
	/** `git fetch destination main` → FETCH_HEAD; null when the fetch fails. */
	fetchDestinationMain(): Promise<string | null>;
	/** `git fetch source <sha>` → FETCH_HEAD; null when the fetch fails. */
	fetchSource(sha: string): Promise<string | null>;
	/** `git ls-tree -rz --full-tree <sha>`, each blob with its bytes. */
	treeEntries(sha: string): Promise<TreeDigestEntry[]>;
	/** `git merge-base --is-ancestor a b`: false when either is unknown. */
	isAncestor(a: string, b: string): Promise<boolean>;
	/** `git rev-parse -q --verify <sha>^`: null for a root commit. */
	parentOf(sha: string): Promise<string | null>;
	/** `git push destination <sha>:refs/heads/main` (no force): true when accepted. */
	pushDestinationMain(sha: string): Promise<boolean>;
}

export interface PromoteInput {
	candidate_sha: string;
	expected_head: string;
	winning_tree_sha256: string;
}

const run = (exit: number, stdout = "", stderr = ""): ScriptRun => ({ exit, stdout, stderr });

/** container/promote.sh, step for step. */
export async function runPromoteModel(input: PromoteInput, git: PromoteGit): Promise<ScriptRun> {
	const current = await git.fetchDestinationMain();
	if (current === null) return run(GIT_FATAL, "", "fatal: could not fetch destination main\n");
	const fetched = await git.fetchSource(input.candidate_sha);
	if (fetched === null) return run(GIT_FATAL, "", `fatal: remote error: upload-pack: not our ref ${input.candidate_sha}\n`);
	if (fetched !== input.candidate_sha) return run(PROMOTE_EXIT.CANDIDATE_MISMATCH, "", "candidate SHA mismatch\n");

	const entries = await git.treeEntries(input.candidate_sha);
	const digest = await treeDigestV1(entries);
	if (!digest.ok) {
		return run(
			PROMOTE_EXIT.UNSUPPORTED_TREE_ENTRY,
			"OUTCOME=UNSUPPORTED_TREE_ENTRY\n",
			`unsupported non-blob tree entry: ${digest.unsupported.type} ${digest.unsupported.path}\n`,
		);
	}
	// A fetched commit has no unmerged index. The blob scan is the check,
	// and it runs before ALREADY_WRITTEN and before the fast-forward.
	const artifacts = unresolvedMergeArtifacts({
		blobs: entries.filter((entry) => entry.type === "blob" && entry.bytes !== undefined).map((entry) => ({
			path: entry.path,
			bytes: entry.bytes as Uint8Array,
		})),
	});
	if (artifacts.length > 0) {
		return run(PROMOTE_EXIT.UNRESOLVED_CONFLICT, `OUTCOME=UNRESOLVED_CONFLICT\nPATHS=${artifacts.join(",")}\n`);
	}
	if (digest.digest !== input.winning_tree_sha256) {
		return run(PROMOTE_EXIT.TREE_MISMATCH, `OUTCOME=TREE_MISMATCH\nTREE_DIGEST=${digest.digest}\n`);
	}

	const parent = (await git.parentOf(input.candidate_sha)) ?? "";
	const shipped = (outcome: "PROMOTED" | "ALREADY_WRITTEN") =>
		`OUTCOME=${outcome}\nPROMOTED_SHA=${input.candidate_sha}\nTREE_DIGEST=${digest.digest}\nBASE=${input.expected_head}\nPARENT=${parent}\n`;

	if ((await git.isAncestor(input.candidate_sha, current)) && (await git.isAncestor(input.expected_head, input.candidate_sha))) {
		return run(PROMOTE_EXIT.OK, shipped("ALREADY_WRITTEN"));
	}
	if (current !== input.expected_head) {
		return run(PROMOTE_EXIT.EXPIRED_HEAD_MOVED, `OUTCOME=EXPIRED_HEAD_MOVED\nCURRENT_HEAD=${current}\n`);
	}
	if (!(await git.isAncestor(input.expected_head, input.candidate_sha))) {
		return run(PROMOTE_EXIT.BASELINE_MISMATCH, "OUTCOME=BASELINE_MISMATCH\n");
	}
	if (!(await git.pushDestinationMain(input.candidate_sha))) {
		return run(PROMOTE_EXIT.PUSH_REJECTED, "OUTCOME=PUSH_REJECTED\n");
	}
	return run(PROMOTE_EXIT.OK, shipped("PROMOTED"));
}

/* ------------------------------------------------------------------ */
/* rebase.sh, modeled                                                   */
/* ------------------------------------------------------------------ */

/** A commit as the rebase model reads it: path → content (opaque; equal
 *  strings are equal blobs). */
export interface ModelCommit {
	parents: string[];
	tree: Record<string, string>;
	message: string;
}

/** The git operations rebase.sh performs. */
export interface RebaseGit {
	/** `git fetch fork main` → FETCH_HEAD; null when the fetch fails. */
	fetchForkMain(): Promise<string | null>;
	/** `git fetch destination <sha>` → FETCH_HEAD; null when the fetch fails. */
	fetchDestination(sha: string): Promise<string | null>;
	isAncestor(a: string, b: string): Promise<boolean>;
	readCommit(sha: string): Promise<ModelCommit | null>;
	/** Create a commit locally (no ref moves); returns its SHA. */
	writeCommit(commit: ModelCommit): Promise<string>;
	/** `git push --force-with-lease=refs/heads/main:<expected> fork <sha>:refs/heads/main`. */
	pushForkMainWithLease(sha: string, expected: string): Promise<boolean>;
}

export interface RebaseInput {
	candidate_sha: string;
	onto: string;
}

function sameTree(a: Record<string, string>, b: Record<string, string>): boolean {
	const ka = Object.keys(a);
	return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && a[k] === b[k]);
}

function compareUtf8(a: string, b: string): number {
	const x = new TextEncoder().encode(a);
	const y = new TextEncoder().encode(b);
	const n = Math.min(x.length, y.length);
	for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i] - y[i];
	return x.length - y.length;
}

/** Three-way merge per path: base = the replayed commit's parent, ours =
 *  the rebased line so far, theirs = the replayed commit. */
function mergeTrees(
	base: Record<string, string>,
	ours: Record<string, string>,
	theirs: Record<string, string>,
): { merged: Record<string, string>; conflicts: string[] } {
	const merged: Record<string, string> = {};
	const conflicts: string[] = [];
	const get = (t: Record<string, string>, p: string) => (Object.hasOwn(t, p) ? t[p] : undefined);
	for (const p of new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)])) {
		const b = get(base, p);
		const o = get(ours, p);
		const t = get(theirs, p);
		let result: string | undefined;
		if (t === b) result = o;
		else if (o === b || o === t) result = t;
		else {
			conflicts.push(p);
			result = o;
		}
		if (result !== undefined) merged[p] = result;
	}
	return { merged, conflicts: conflicts.sort(compareUtf8) };
}

function utf8Base64(paths: string[]): string {
	const bytes = new TextEncoder().encode(paths.map((p) => `${p}\0`).join(""));
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary);
}

/** container/rebase.sh, step for step. */
export async function runRebaseModel(input: RebaseInput, git: RebaseGit): Promise<ScriptRun> {
	const forkHead = await git.fetchForkMain();
	if (forkHead === null) return run(GIT_FATAL, "", "fatal: could not fetch fork main\n");
	if (forkHead !== input.candidate_sha) return run(REBASE_EXIT.FORK_MOVED, `OUTCOME=FORK_MOVED\nFORK_HEAD=${forkHead}\n`);
	const onto = await git.fetchDestination(input.onto);
	if (onto === null) return run(GIT_FATAL, "", `fatal: remote error: upload-pack: not our ref ${input.onto}\n`);
	if (onto !== input.onto) return run(REBASE_EXIT.ONTO_MISMATCH, "", "onto SHA mismatch\n");

	const alreadyIn = run(REBASE_EXIT.ALREADY_IN_DESTINATION, `OUTCOME=ALREADY_IN_DESTINATION\nONTO=${input.onto}\n`);
	if (await git.isAncestor(input.candidate_sha, input.onto)) return alreadyIn;
	if (await git.isAncestor(input.onto, input.candidate_sha)) {
		return run(REBASE_EXIT.OK, `OUTCOME=UP_TO_DATE\nREBASED_SHA=${input.candidate_sha}\nONTO=${input.onto}\n`);
	}

	// The commits `git rebase <onto>` replays: the candidate's line back to
	// the first commit <onto> already has, oldest first.
	const replay: string[] = [];
	for (let sha = input.candidate_sha; !(await git.isAncestor(sha, input.onto)); ) {
		const commit = await git.readCommit(sha);
		if (commit === null) return run(GIT_FATAL, "", `fatal: bad object ${sha}\n`);
		if (commit.parents.length !== 1) return run(1, "", "the rebase model supports linear candidate histories only\n");
		replay.unshift(sha);
		sha = commit.parents[0];
	}

	const ontoCommit = await git.readCommit(input.onto);
	if (ontoCommit === null) return run(GIT_FATAL, "", `fatal: bad object ${input.onto}\n`);
	let head = input.onto;
	let tree = ontoCommit.tree;
	for (const sha of replay) {
		const commit = (await git.readCommit(sha))!;
		const parent = await git.readCommit(commit.parents[0]);
		if (parent === null) return run(GIT_FATAL, "", `fatal: bad object ${commit.parents[0]}\n`);
		const startsEmpty = sameTree(parent.tree, commit.tree);
		const { merged, conflicts } = mergeTrees(parent.tree, tree, commit.tree);
		if (conflicts.length > 0) {
			if (conflicts.length !== 1 || conflicts[0] !== TOOL_STATUS_LOG) {
				return run(REBASE_EXIT.CONFLICT, `OUTCOME=CONFLICT\nONTO=${input.onto}\nCONFLICT_PATHS=${utf8Base64(conflicts)}\n`);
			}
			// Only the tool-status log conflicts: keep the candidate's version, or its deletion.
			if (Object.hasOwn(commit.tree, TOOL_STATUS_LOG)) merged[TOOL_STATUS_LOG] = commit.tree[TOOL_STATUS_LOG];
			else delete merged[TOOL_STATUS_LOG];
		}
		// git drops a commit that becomes empty, and keeps one that started empty.
		if (!startsEmpty && sameTree(merged, tree)) continue;
		head = await git.writeCommit({ parents: [head], tree: merged, message: commit.message });
		tree = merged;
	}
	if (head === input.onto) return alreadyIn;
	if (!(await git.pushForkMainWithLease(head, input.candidate_sha))) {
		return run(REBASE_EXIT.PUSH_REJECTED, "OUTCOME=PUSH_REJECTED\n");
	}
	return run(REBASE_EXIT.OK, `OUTCOME=REBASED\nREBASED_SHA=${head}\nONTO=${input.onto}\n`);
}
