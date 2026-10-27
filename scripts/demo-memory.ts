#!/usr/bin/env node
/// <reference types="node" />
/**
 * npm run demo:memory — module memory, locally (docs/MODULE_MEMORY.md).
 *
 * For each target (this repository at HEAD, then third_party/theustad) it
 * works in a throwaway git repo under the OS temp dir:
 *   1. first pass, serial and with N worker_threads (cards must be identical)
 *   2. the repo map and cross-module dependency edges
 *   3. a simulated edit committed to one module
 *   4. an incremental refresh that re-reads only the touched module(s)
 *   5. change routing: only the owning ModuleAgent(s) wake
 * No network, no Cloudflare, no model. ModuleAgent runs on in-memory storage.
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { firstPass, refreshPass } from "./lib/module-reader.ts";
import { moduleAgentName, routeChange, type ModuleCard, type ModuleConfig } from "../src/lib/module-memory.ts";
import { ModuleAgent } from "../src/do/ModuleAgent.ts";
import { buildWorkGraph, withModuleRouting } from "../src/lib/work-graph.ts";
import { createAuthority } from "../src/lib/task-state.ts";
import { memoryState } from "../test/helpers/memory-storage.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKERS = Number(process.env.MADGRIX_MEMORY_WORKERS ?? "4");

function git(cwd: string, ...args: string[]): string {
	const r = spawnSync("git", ["-c", "user.name=demo", "-c", "user.email=demo@madgrix.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
	if (r.status !== 0) throw new Error(`git ${args[0]}: ${r.stderr}`);
	return r.stdout.trim();
}

const ms = (n: number) => `${n.toFixed(0)} ms`;
const pct = (a: number, b: number) => `${((100 * a) / b).toFixed(1)}%`;

async function agentCall(agent: ModuleAgent, route: string, body: unknown) {
	const res = await agent.fetch(new Request(`https://module-agent${route}`, { method: "POST", body: JSON.stringify(body) }));
	return { status: res.status, body: (await res.json()) as any };
}

async function demo(label: string, repo: string, config: ModuleConfig | undefined, edit: { file: string; append: string; request: string }) {
	console.log(`\n=== ${label} ===`);
	const serial = await firstPass(repo, "HEAD", { config, workers: 1 });
	const parallel = await firstPass(repo, "HEAD", { config, workers: WORKERS });
	const same = JSON.stringify(serial.cards) === JSON.stringify(parallel.cards);
	console.log(`first pass @ ${serial.sha.slice(0, 12)}: ${serial.files_total} files, ${serial.cards.length} modules`);
	console.log(`  serial   (1 thread)        ${ms(serial.ms)}`);
	console.log(`  parallel (${WORKERS} worker_threads) ${ms(parallel.ms)}   cards identical: ${same}`);
	if (!same) throw new Error("parallel and serial cards differ");

	console.log("repo map:");
	for (const m of parallel.map.modules) {
		console.log(
			`  ${m.module_id.padEnd(16)} files=${String(m.files).padStart(3)} lines=${String(m.lines).padStart(6)} exports=${String(m.exports).padStart(4)}` +
				` entry=${m.entry_points.length} tests=${m.tests.length} -> [${m.depends_on.join(", ")}]`,
		);
	}
	console.log(`  edges=${parallel.map.edges.length} unresolved relative imports=${parallel.map.unresolved_imports}`);

	// One ModuleAgent per module, loaded with its card (the DO class, in-memory storage).
	const agents = new Map<string, { agent: ModuleAgent; state: ReturnType<typeof memoryState>; card: ModuleCard }>();
	const repoName = label;
	for (const card of parallel.cards) {
		const state = memoryState();
		const agent = new ModuleAgent(state, {});
		const r = await agentCall(agent, "/load", { repo: repoName, module: { id: card.module_id, paths: card.paths }, card });
		if (r.status !== 200) throw new Error(`load ${card.module_id}: ${JSON.stringify(r.body)}`);
		agents.set(card.module_id, { agent, state, card });
	}

	// Simulated edit, committed.
	appendFileSync(path.join(repo, edit.file), edit.append);
	git(repo, "add", "-A");
	git(repo, "commit", "-q", "-m", `demo: edit ${edit.file}`);
	console.log(`simulated edit: ${edit.file} (+${edit.append.split("\n").length - 1} lines), committed`);

	const refreshed = await refreshPass(repo, parallel, "HEAD", { config, workers: WORKERS });
	const p = refreshed.plan;
	console.log(`incremental refresh @ ${refreshed.sha.slice(0, 12)}: git diff = [${refreshed.changed.join(", ")}]`);
	console.log(`  re-read modules: ${p.reread.length} [${p.reread.join(", ")}]   reused: ${p.reused.length}   removed: ${p.removed.length}`);
	console.log(`  second pass reads ${p.files_to_read}/${p.files_total} files = ${pct(p.files_to_read, p.files_total)}  (${ms(refreshed.ms)})`);
	const full = await firstPass(repo, "HEAD", { config, workers: 1 });
	const equal = JSON.stringify(full.map) === JSON.stringify(refreshed.map);
	console.log(`  refreshed map equals a full re-read at the new SHA: ${equal}`);
	if (!equal) throw new Error("incremental map differs from full re-read");

	// Load the refreshed cards (re-read ones are new; reused ones are re-pinned).
	for (const card of refreshed.cards) {
		const a = agents.get(card.module_id)!;
		await agentCall(a.agent, "/load", { repo: repoName, module: { id: card.module_id, paths: card.paths }, card });
	}

	const routing = routeChange(refreshed.cards, { paths: [edit.file], request: edit.request }, refreshed.sha);
	console.log(`change routing: paths=[${routing.paths.join(", ")}] request=${JSON.stringify(edit.request)}`);
	for (const r of routing.routes) {
		const a = agents.get(r.module_id)!;
		const woke = await agentCall(a.agent, "/wake", { repo: repoName, module: { id: r.module_id, paths: a.card.paths }, sha: refreshed.sha });
		const routed = await agentCall(a.agent, "/route", { repo: repoName, module: { id: r.module_id, paths: a.card.paths }, sha: refreshed.sha, routing });
		console.log(
			`  woke ${r.module_id} (${r.reasons.join("+")}: ${r.matched.join(", ")}) wake_count=${woke.body.wake_count} fresh=${woke.body.fresh}` +
				` -> route ${routed.status} with ${routed.body.files?.length ?? 0} file card(s) from memory`,
		);
	}
	const asleep = [...agents.keys()].filter((id) => !routing.routes.some((r) => r.module_id === id));
	console.log(`  still asleep (not woken): ${asleep.length}/${agents.size}`);
	console.log(`  DO name of first woken agent: ${JSON.stringify(moduleAgentName(repoName, { id: routing.routes[0]?.module_id ?? "-", paths: agents.get(routing.routes[0]?.module_id ?? "")?.card.paths ?? [] }))}`);

	const graph = withModuleRouting(
		buildWorkGraph(
			createAuthority({
				task_id: "demo-memory",
				task_hash: "demo",
				intent: edit.request,
				baseline_repo: repoName,
				baseline_commit: refreshed.sha,
				behavior_contract: "",
				policy_version: "seam-policy/0.1.0",
				frozen_at: "2026-10-13T00:00:00Z",
			}),
		),
		routing,
	);
	console.log(`  work graph module_routing: ${JSON.stringify(graph.module_routing.map((r) => r.routes.map((x) => x.module_id)))}`);
}

const tmp = mkdtempSync(path.join(os.tmpdir(), "madgrix-memory-"));
try {
	const self = path.join(tmp, "madgrix");
	git(tmp, "clone", "-q", "--local", "--no-hardlinks", ROOT, self);
	const config = JSON.parse(readFileSync(path.join(ROOT, "configs/module-memory.json"), "utf8")) as ModuleConfig;
	await demo("madgrix", self, config, {
		file: "src/lib/permit.ts",
		append: "\n/** demo edit */\nexport function permitDemoMarker(): string {\n\treturn \"demo\";\n}\n",
		request: "change checkPromotion to report the permit id",
	});

	const ustad = path.join(tmp, "theustad");
	cpSync(path.join(ROOT, "third_party/theustad"), ustad, { recursive: true });
	git(ustad, "init", "-q");
	git(ustad, "add", "-A");
	git(ustad, "commit", "-q", "-m", "theustad snapshot");
	await demo("theustad", ustad, undefined, {
		file: "theustadlib/claims.py",
		append: "\n\ndef demo_marker():\n    return 'demo'\n",
		request: "claims.py overlap check",
	});
} finally {
	rmSync(tmp, { recursive: true, force: true });
}
