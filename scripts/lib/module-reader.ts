/// <reference types="node" />
/**
 * Node side of module memory (docs/MODULE_MEMORY.md): reads files from git
 * at one commit and builds cards with src/lib/module-memory.ts, serially or
 * with N worker_threads (divide and conquer, one module per job).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";

import {
	buildModuleCard,
	type ModuleCard,
	type ModuleDef,
} from "../../src/lib/module-memory.ts";

export const sha256Hex = async (s: string) => createHash("sha256").update(s).digest("hex");

function git(repo: string, args: string[], input?: string): Buffer {
	const r = spawnSync("git", args, { cwd: repo, input, maxBuffer: 1 << 30, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } });
	if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.toString().trim()}`);
	return r.stdout;
}

export function resolveSha(repo: string, rev: string): string {
	return git(repo, ["rev-parse", "--verify", `${rev}^{commit}`]).toString().trim();
}

/** Every tracked blob at `sha`: path -> blob id. */
export function listTree(repo: string, sha: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const rec of git(repo, ["ls-tree", "-r", "-z", sha]).toString().split("\0")) {
		if (!rec) continue;
		const tab = rec.indexOf("\t");
		const [, type, blob] = rec.slice(0, tab).split(" ");
		if (type === "blob") out.set(rec.slice(tab + 1), blob);
	}
	return out;
}

/** `git diff --name-only` between two commits, with both sides of renames. */
export function changedPaths(repo: string, from: string, to: string): string[] {
	const raw = git(repo, ["diff", "--name-only", "--no-renames", "-z", from, to]).toString();
	return raw.split("\0").filter(Boolean).sort();
}

/** Read blobs in one `git cat-file --batch`. Binary blobs read as "". */
export function readBlobs(repo: string, blobs: string[]): Map<string, string> {
	const out = new Map<string, string>();
	if (blobs.length === 0) return out;
	const buf = git(repo, ["cat-file", "--batch"], blobs.join("\n") + "\n");
	let i = 0;
	while (i < buf.length) {
		const nl = buf.indexOf(10, i);
		const [id, , sizeStr] = buf.subarray(i, nl).toString().split(" ");
		const size = Number(sizeStr);
		const body = buf.subarray(nl + 1, nl + 1 + size);
		const binary = body.subarray(0, 8000).includes(0);
		out.set(id, binary ? "" : body.toString("utf8"));
		i = nl + 1 + size + 1;
	}
	return out;
}

export interface ReadJob {
	module: ModuleDef & { files: string[] };
	blobs: Record<string, string>;
	/** Benchmark only: simulated per-file "understanding" cost, CPU-bound, in ms. Default 0. */
	workMs?: number;
}

/** Spin the CPU for `ms` (a stand-in for per-file analysis work). */
function spin(ms: number): void {
	if (ms <= 0) return;
	const end = performance.now() + ms;
	while (performance.now() < end) {
		// busy: deliberately CPU-bound so threads, not I/O, decide the speedup
	}
}

/** Build one module's card: read its blobs, extract facts. */
export async function readModule(repo: string, sha: string, job: ReadJob): Promise<ModuleCard> {
	const texts = readBlobs(repo, job.module.files.map((f) => job.blobs[f]));
	for (let i = 0; i < job.module.files.length; i++) spin(job.workMs ?? 0);
	return buildModuleCard(
		{ id: job.module.id, paths: job.module.paths },
		sha,
		job.module.files.map((f) => ({ path: f, blob: job.blobs[f], text: texts.get(job.blobs[f]) ?? "" })),
		sha256Hex,
	);
}

/** Read every job, serially in this thread. */
export async function readSerial(repo: string, sha: string, jobs: ReadJob[]): Promise<ModuleCard[]> {
	const cards: ModuleCard[] = [];
	for (const job of jobs) cards.push(await readModule(repo, sha, job));
	return cards;
}

/**
 * Read every job with `workers` worker_threads. Jobs are handed out largest
 * first; each worker owns the modules it is given and returns their cards.
 * Output order is by module id, so it equals readSerial().
 */
export async function readParallel(repo: string, sha: string, jobs: ReadJob[], workers: number): Promise<ModuleCard[]> {
	const queue = [...jobs].sort((a, b) => b.module.files.length - a.module.files.length);
	const cards: ModuleCard[] = [];
	const url = new URL("./module-read-worker.ts", import.meta.url);
	const n = Math.max(1, Math.min(workers, queue.length));
	await Promise.all(
		Array.from({ length: n }, () =>
			new Promise<void>((resolve, reject) => {
				const w = new Worker(fileURLToPath(url), { workerData: { repo, sha } });
				const next = () => {
					const job = queue.shift();
					if (!job) {
						void w.terminate().then(() => resolve());
						return;
					}
					w.postMessage(job);
				};
				w.on("message", (msg: { card?: ModuleCard; error?: string }) => {
					if (msg.error) {
						void w.terminate();
						reject(new Error(msg.error));
						return;
					}
					cards.push(msg.card!);
					next();
				});
				w.on("error", reject);
				next();
			}),
		),
	);
	return cards.sort((a, b) => (a.module_id < b.module_id ? -1 : 1));
}

import { planRefresh, reduceRepoMap, repinCard, splitModules, type ModuleConfig, type RefreshPlan, type RepoMap } from "../../src/lib/module-memory.ts";

function jobsFor(modules: Array<ModuleDef & { files: string[] }>, tree: Map<string, string>, workMs = 0): ReadJob[] {
	return modules.map((module) => ({
		module,
		blobs: Object.fromEntries(module.files.map((f) => [f, tree.get(f)!])),
		workMs,
	}));
}

export interface PassResult {
	sha: string;
	cards: ModuleCard[];
	map: RepoMap;
	files_read: number;
	files_total: number;
	ms: number;
}

/** First pass: map, read every module (N workers, or serial when workers <= 1), reduce. */
export async function firstPass(
	repo: string,
	rev: string,
	opts: { config?: ModuleConfig; workers?: number; workMs?: number } = {},
): Promise<PassResult> {
	const t0 = performance.now();
	const sha = resolveSha(repo, rev);
	const tree = listTree(repo, sha);
	const modules = splitModules([...tree.keys()], opts.config);
	const jobs = jobsFor(modules, tree, opts.workMs ?? 0);
	const workers = opts.workers ?? 4;
	const cards = workers <= 1 ? await readSerial(repo, sha, jobs) : await readParallel(repo, sha, jobs, workers);
	return { sha, cards, map: reduceRepoMap(sha, cards), files_read: tree.size, files_total: tree.size, ms: performance.now() - t0 };
}

/** Incremental refresh: git diff, re-read only the touched modules, re-pin the rest. */
export async function refreshPass(
	repo: string,
	previous: PassResult,
	rev: string,
	opts: { config?: ModuleConfig; workers?: number } = {},
): Promise<PassResult & { plan: RefreshPlan; changed: string[] }> {
	const t0 = performance.now();
	const sha = resolveSha(repo, rev);
	const tree = listTree(repo, sha);
	const modules = splitModules([...tree.keys()], opts.config);
	const changed = changedPaths(repo, previous.sha, sha);
	const plan = planRefresh(previous.cards, modules, changed, previous.sha, sha);
	const reread = new Set(plan.reread);
	const jobs = jobsFor(modules.filter((m) => reread.has(m.id)), tree);
	const workers = opts.workers ?? 4;
	const fresh = workers <= 1 ? await readSerial(repo, sha, jobs) : await readParallel(repo, sha, jobs, workers);
	const prevById = new Map(previous.cards.map((c) => [c.module_id, c]));
	const cards = [...fresh, ...plan.reused.map((id) => repinCard(prevById.get(id)!, sha))].sort((a, b) =>
		a.module_id < b.module_id ? -1 : 1,
	);
	return {
		sha,
		cards,
		map: reduceRepoMap(sha, cards),
		files_read: plan.files_to_read,
		files_total: plan.files_total,
		ms: performance.now() - t0,
		plan,
		changed,
	};
}
