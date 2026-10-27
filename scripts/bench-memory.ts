#!/usr/bin/env node
/// <reference types="node" />
/**
 * npm run bench:memory -- --repo <git repo> [--split <dirA,dirB>|--top] [--work-ms N] [--workers 1,2,4] [--runs 3]
 *
 * First-pass timing of module memory, serial vs N worker_threads, on any git
 * repository at HEAD. --split "a/**,b/**" makes a two-module frontend/backend
 * config (everything else goes to "(root)"); --top uses top-level dirs.
 * --work-ms adds a simulated, CPU-bound per-file "understanding" cost.
 * Prints the median of --runs for each worker count and checks every run
 * produced identical cards.
 */
import { firstPass } from "./lib/module-reader.ts";
import type { ModuleConfig } from "../src/lib/module-memory.ts";

const args = process.argv.slice(2);
const opt = (name: string, def?: string) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : def;
};
const repo = opt("repo");
if (!repo) {
	console.error("usage: bench-memory --repo <path> [--split a/**;b/**] [--work-ms N] [--workers 1,2,4] [--runs 3]");
	process.exit(2);
}
const workMs = Number(opt("work-ms", "0"));
const workerCounts = opt("workers", "1,2,4")!.split(",").map(Number);
const runs = Number(opt("runs", "3"));
const split = opt("split");
const config: ModuleConfig | undefined = split
	? {
			modules: split.split(";").map((group, i) => ({ id: i === 0 ? "frontend" : i === 1 ? "backend" : `part${i}`, paths: group.split(",") })),
		}
	: undefined;

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
let reference: string | null = null;
const rows: Array<{ workers: number; ms: number }> = [];
let info = "";
for (const w of workerCounts) {
	const times: number[] = [];
	for (let r = 0; r < runs; r++) {
		const pass = await firstPass(repo, "HEAD", { config, workers: w, workMs });
		const digest = JSON.stringify(pass.cards.map((c) => c.content_digest + c.files.length));
		if (reference === null) reference = digest;
		else if (digest !== reference) throw new Error("cards differ between runs");
		times.push(pass.ms);
		info = `${pass.files_total} files, ${pass.cards.length} modules [${pass.cards.map((c) => `${c.module_id}:${c.files.length}`).join(", ")}]`;
	}
	rows.push({ workers: w, ms: median(times) });
}
console.log(`repo=${repo} ${info} work-ms=${workMs} runs=${runs}`);
const base = rows.find((r) => r.workers === 1)?.ms ?? rows[0].ms;
for (const r of rows) console.log(`  workers=${r.workers}  median ${r.ms.toFixed(0)} ms  speedup x${(base / r.ms).toFixed(2)}`);
