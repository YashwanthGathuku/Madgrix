/** Module memory: split, cards, reduce, refresh, routing, ModuleAgent DO, worker route. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

import {
	extractFacts,
	modulesFromSubagentIntents,
	planRefresh,
	routeChange,
	splitModules,
	type ModuleCard,
} from "../src/lib/module-memory.ts";
import { firstPass, refreshPass } from "../scripts/lib/module-reader.ts";
import { ModuleAgent } from "../src/do/ModuleAgent.ts";
import { memoryState } from "./helpers/memory-storage.ts";
import { makeHarness, TOKENS, worker } from "./helpers/worker-harness.ts";

function git(cwd: string, ...args: string[]) {
	const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
	assert.equal(r.status, 0, r.stderr);
	return r.stdout.trim();
}

function fixtureRepo(): string {
	const dir = mkdtempSync(path.join(os.tmpdir(), "mm-test-"));
	const files: Record<string, string> = {
		"src/api/handler.ts": 'import { view } from "../ui/view.ts";\nexport function handler() { return view(); }\n',
		"src/ui/view.ts": "export function view() { return 'ui'; }\nexport const NAME = 'v';\n",
		"src/ui/style.ts": "export type Style = { color: string };\n",
		"test/api.test.ts": 'import { handler } from "../src/api/handler.ts";\nhandler();\n',
		"lib/util.py": "def helper():\n    return 1\n\nclass Thing:\n    pass\n",
		"main.py": "from lib import util\n\nif __name__ == '__main__':\n    util.helper()\n",
	};
	for (const [f, t] of Object.entries(files)) {
		mkdirSync(path.join(dir, path.dirname(f)), { recursive: true });
		writeFileSync(path.join(dir, f), t);
	}
	git(dir, "init", "-q");
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "base");
	return dir;
}

const CONFIG = {
	modules: [
		{ id: "sub-api", paths: ["src/api/**"] },
		{ id: "sub-ui", paths: ["src/ui/**"] },
		{ id: "tests", paths: ["test/**"] },
		{ id: "py", paths: ["lib/**", "*.py"] },
	],
};

describe("module memory: map/read/reduce", () => {
	it("splits by top-level path without a config and by first matching glob with one", () => {
		const files = ["a.md", "src/x.ts", "src/y/z.ts", "test/t.ts"];
		assert.deepEqual(splitModules(files).map((m) => [m.id, m.files]), [
			["(root)", ["a.md"]],
			["src", ["src/x.ts", "src/y/z.ts"]],
			["test", ["test/t.ts"]],
		]);
		const split = splitModules(files, { modules: [{ id: "deep", paths: ["src/y/**"] }, { id: "src", paths: ["src/**"] }] });
		assert.deepEqual(split.map((m) => [m.id, m.files]), [
			["(root)", ["a.md", "test/t.ts"]],
			["deep", ["src/y/z.ts"]],
			["src", ["src/x.ts"]],
		]);
		assert.throws(() => splitModules(files, { modules: [{ id: "all", paths: ["**"] }] }), /non-"\*\*"/);
	});

	it("reads modules from a fork-crew subagent-intents record", () => {
		const cfg = modulesFromSubagentIntents({
			agents: [
				{ agent_id: "sub-api", paths: ["src/api/**"] },
				{ agent_id: "sub-ui", paths: ["src/ui/**"] },
				{ agent_id: "parent" },
			],
		});
		assert.deepEqual(cfg.modules, [
			{ id: "sub-api", paths: ["src/api/**"] },
			{ id: "sub-ui", paths: ["src/ui/**"] },
		]);
	});

	it("extracts exports, imports, entry points and line counts without a model", () => {
		const ts = extractFacts("src/a.ts", 'import x from "./b.ts";\nexport function f() {}\nexport { g as h };\nexport default { fetch() {} };\n');
		assert.deepEqual(ts.exports, ["default", "f", "h"]);
		assert.deepEqual(ts.imports, ["./b.ts"]);
		assert.equal(ts.entry, "worker-export-default");
		assert.equal(ts.lines, 4);
		const py = extractFacts("p/m.py", "from .q import r\nimport os\n\ndef run():\n    pass\nif __name__ == '__main__':\n    run()\n");
		assert.deepEqual(py.exports, ["run"]);
		assert.deepEqual(py.imports, [".q", "os"]);
		assert.equal(py.entry, "python-main");
	});

	it("parallel cards equal serial cards; the map has the cross-module graph and test coverage", async () => {
		const repo = fixtureRepo();
		try {
			const serial = await firstPass(repo, "HEAD", { config: CONFIG, workers: 1 });
			const parallel = await firstPass(repo, "HEAD", { config: CONFIG, workers: 3 });
			assert.deepEqual(parallel.cards, serial.cards);
			const byId = Object.fromEntries(serial.map.modules.map((m) => [m.module_id, m]));
			assert.deepEqual(byId["sub-api"].depends_on, ["sub-ui"]);
			assert.deepEqual(byId["sub-ui"].depended_on_by, ["sub-api"]);
			assert.deepEqual(byId["sub-api"].tests, ["test/api.test.ts"]);
			assert.deepEqual(byId["py"].entry_points, ["main.py"]);
			for (const c of serial.cards) assert.equal(c.built_from_sha, serial.sha);
			assert.equal(serial.cards.every((c) => c.summary === null), true, "no model summary by default");
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});
});

describe("module memory: incremental refresh", () => {
	it("re-reads only the touched module, re-pins the rest, and equals a full re-read", async () => {
		const repo = fixtureRepo();
		try {
			const first = await firstPass(repo, "HEAD", { config: CONFIG, workers: 2 });
			writeFileSync(path.join(repo, "src/ui/view.ts"), "export function view() { return 'ui2'; }\nexport const NAME = 'v';\nexport const EXTRA = 1;\n");
			git(repo, "commit", "-qam", "edit ui");
			const next = await refreshPass(repo, first, "HEAD", { config: CONFIG, workers: 2 });
			assert.deepEqual(next.plan.reread, ["sub-ui"]);
			assert.deepEqual(next.plan.reused, ["py", "sub-api", "tests"]);
			assert.equal(next.files_read, 2);
			assert.equal(next.files_total, 6);
			assert.ok(next.cards.every((c) => c.built_from_sha === next.sha), "every card is pinned to the new SHA");
			const full = await firstPass(repo, "HEAD", { config: CONFIG, workers: 1 });
			assert.deepEqual(next.map, full.map);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("a card built from a different SHA than the diff base is re-read, not trusted", () => {
		const card = { module_id: "m", built_from_sha: "old", files: [] } as unknown as ModuleCard;
		const plan = planRefresh([card], [{ id: "m", paths: ["m/**"], files: ["m/a.ts"] }], [], "base", "new");
		assert.deepEqual(plan.reread, ["m"]);
	});
});

describe("module memory: routing and ModuleAgent", () => {
	async function cards() {
		const repo = fixtureRepo();
		try {
			return await firstPass(repo, "HEAD", { config: CONFIG, workers: 1 });
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	}

	it("routes paths to their owner and request text by exact symbol; unowned paths are reported", async () => {
		const pass = await cards();
		const r = routeChange(pass.cards, { paths: ["src/ui/view.ts", "nowhere/x.ts"], request: "rename handler" }, pass.sha);
		assert.deepEqual(r.routes.map((x) => [x.module_id, x.reasons, x.matched]), [
			["sub-api", ["symbol"], ["handler"]],
			["sub-ui", ["path"], ["src/ui/view.ts"]],
		]);
		assert.deepEqual(r.unowned, ["nowhere/x.ts"], "no module owns it, so no agent wakes for it");
	});

	it("ModuleAgent keeps memory in storage only, refuses stale SHAs and foreign identities", async () => {
		const pass = await cards();
		const card = pass.cards.find((c) => c.module_id === "sub-ui")!;
		const state = memoryState();
		const call = async (agent: ModuleAgent, route: string, body: unknown) => {
			const res = await agent.fetch(new Request(`https://m${route}`, { method: "POST", body: JSON.stringify(body) }));
			return { status: res.status, body: (await res.json()) as any };
		};
		const id = { repo: "r", module: { id: "sub-ui", paths: card.paths } };
		assert.equal((await call(new ModuleAgent(state, {}), "/load", { ...id, card })).status, 200);
		// A brand-new instance over the same storage (the object was evicted) still has the memory.
		const woken = new ModuleAgent(state, {});
		const wake = await call(woken, "/wake", { ...id, sha: pass.sha });
		assert.equal(wake.body.fresh, true);
		assert.equal(wake.body.wake_count, 1);
		assert.equal((await call(woken, "/memory", { ...id, sha: pass.sha })).body.card.content_digest, card.content_digest);
		assert.equal((await call(woken, "/memory", { ...id, sha: "other" })).status, 409);
		assert.equal((await call(woken, "/memory", { repo: "r", module: { id: "sub-api", paths: ["src/api/**"] }, sha: pass.sha })).status, 409);
		const routing = routeChange(pass.cards, { paths: ["src/ui/view.ts"] }, pass.sha);
		const routed = await call(woken, "/route", { ...id, sha: pass.sha, routing });
		assert.equal(routed.status, 200);
		assert.deepEqual(routed.body.files.map((f: any) => f.path), ["src/ui/view.ts"]);
		const notMine = routeChange(pass.cards, { paths: ["src/api/handler.ts"] }, pass.sha);
		assert.equal((await call(woken, "/route", { ...id, sha: pass.sha, routing: notMine })).status, 409);
	});

	it("worker /module-agents routes are control-plane only and 503 without the binding", async () => {
		const h = await makeHarness();
		const req = (token?: string) =>
			new Request("https://madgrix.test/module-agents/wake", {
				method: "POST",
				headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
				body: JSON.stringify({ repo: "r", module: { id: "m", paths: ["m/**"] }, sha: "x" }),
			});
		assert.equal((await worker.fetch(req(), h.env as any)).status, 401);
		assert.equal((await worker.fetch(req(TOKENS.agent), h.env as any)).status, 401);
		assert.equal((await worker.fetch(req(TOKENS.control), h.env as any)).status, 503);
	});
});
