/**
 * Governed resolution, runner side (specs/amendments/governed-resolution-v1.md):
 * hunk-level leases, frozen witnesses, the resolution ladder with dual-order
 * replay, the LLM replayer adapter, and what the control plane records.
 * node --test test/governed-resolution-runner.test.ts
 *
 * Every test drives real git repositories through the real fork-crew code.
 * TheUstad's frozen-baseline gate is stubbed; it is not under test here.
 * The Mergiraf test runs only where a mergiraf binary is installed.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { sha256Hex } from "../src/lib/canonical.ts";
import { createAuthority, recordComposition, type Ctx } from "../src/lib/task-state.ts";
import {
	conflictHunks,
	fillTemplate,
	loadForkCrew,
	matchTemplate,
	resolveComposition,
	runCrewOnFork,
} from "../scripts/lib/fork-crew.mjs";
import { governCrewResult } from "../scripts/lib/governed-resolution.mjs";
import { findMergiraf, resolveWithLadder } from "../scripts/lib/resolve-ladder.mjs";
import { freezeWitnesses, loadWitnesses, witnessReport } from "../scripts/lib/witness.mjs";
import { callModel, parseResolution, replayPrompt } from "../scripts/resolvers/llm-replayer.mjs";

const dirs: string[] = [];
const stubGate = () => ({ final: "FINAL VERIFIED", exit: 0 });
const MERGIRAF = findMergiraf();

after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(path.join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

function git(repo: string, args: string[]): string {
	const result = spawnSync("git", args, {
		cwd: repo,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Git4agents",
			GIT_AUTHOR_EMAIL: "git4agents@madgrix.invalid",
			GIT_COMMITTER_NAME: "Git4agents",
			GIT_COMMITTER_EMAIL: "git4agents@madgrix.invalid",
		},
	});
	assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
	return (result.stdout ?? "").trim();
}

function initRepo(files: Record<string, string>): string {
	const repo = tempDir("madgrix-gr-repo-");
	git(repo, ["init", "--quiet", "--initial-branch=main"]);
	for (const [name, body] of Object.entries(files)) {
		mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
		writeFileSync(path.join(repo, name), body);
	}
	git(repo, ["add", "-A"]);
	git(repo, ["commit", "--quiet", "-m", "baseline"]);
	return repo;
}

interface SubSpec {
	id: string;
	intent: string;
	paths: string[];
	/** Files this agent writes, relative to the repo. */
	writes: Record<string, string>;
	/** Witness id → node script body (run with the tree under test as cwd). */
	witnesses?: Record<string, string>;
}

/** A crew config on disk whose sub-agents copy prepared files into their worktree. */
function makeCrew(subs: SubSpec[], regressions: Record<string, string> = {}) {
	const dir = tempDir("madgrix-gr-crew-");
	const config = {
		parent: { id: "parent", role: "parent", intent: "Host the crew on one fork." },
		subs: subs.map((sub) => {
			const copies = Object.entries(sub.writes).map(([file, body], i) => {
				const src = path.join(dir, "payload", sub.id, `${i}`);
				mkdirSync(path.dirname(src), { recursive: true });
				writeFileSync(src, body);
				return `mkdir -p ${JSON.stringify(path.dirname(file))} && cp ${JSON.stringify(src)} ${JSON.stringify(file)}`;
			});
			const witnesses = Object.entries(sub.witnesses ?? {}).map(([id, body]) => {
				const script = path.join("witness", sub.id, `${id}.mjs`);
				mkdirSync(path.join(dir, path.dirname(script)), { recursive: true });
				writeFileSync(path.join(dir, script), body);
				return { id, script };
			});
			return {
				id: sub.id,
				role: sub.id,
				intent: sub.intent,
				paths: sub.paths,
				command: copies.join(" && "),
				...(witnesses.length > 0 ? { witnesses } : {}),
			};
		}),
		...(Object.keys(regressions).length > 0
			? {
					regressions: Object.entries(regressions).map(([id, body]) => {
						const script = path.join("witness", "regression", `${id}.mjs`);
						mkdirSync(path.join(dir, path.dirname(script)), { recursive: true });
						writeFileSync(path.join(dir, script), body);
						return { id, script };
					}),
				}
			: {}),
	};
	const configPath = path.join(dir, "crew.json");
	writeFileSync(configPath, JSON.stringify(config, null, 2));
	const crew = loadForkCrew(configPath);
	return { configPath, crew, witnesses: loadWitnesses(configPath, crew) };
}

/** A node witness that imports one module from the tree under test and checks it. */
function witness(file: string, check: string): string {
	return [
		'import path from "node:path";',
		'import { pathToFileURL } from "node:url";',
		`const m = await import(pathToFileURL(path.join(process.cwd(), ${JSON.stringify(file)})).href);`,
		`if (!(${check})) process.exit(1);`,
	].join("\n");
}

/** The shared-object scenario: two agents add different keys at the same place. */
function configScenario() {
	const base = "export const config = {\n\tretries: 2,\n};\n";
	return {
		repo: initRepo({ "src/config.js": base, "README.md": "baseline\n" }),
		...makeCrew([
			{
				id: "sub-a",
				intent: "Add a 10 second timeout to the config.",
				paths: ["src/config.js"],
				writes: { "src/config.js": "export const config = {\n\tretries: 2,\n\ttimeout: 10,\n};\n" },
				witnesses: { timeout: witness("src/config.js", "m.config.timeout === 10") },
			},
			{
				id: "sub-b",
				intent: "Turn on retry jitter in the config.",
				paths: ["src/config.js"],
				writes: { "src/config.js": "export const config = {\n\tretries: 2,\n\tjitter: true,\n};\n" },
				witnesses: { jitter: witness("src/config.js", "m.config.jitter === true") },
			},
		]),
	};
}

/** The label scenario: both agents rewrite the same line with different values. */
function labelScenario(withWitnesses = true) {
	return {
		repo: initRepo({ "src/label.js": 'export const label = "base";\n', "README.md": "baseline\n" }),
		...makeCrew([
			{
				id: "sub-a",
				intent: "The label must include api.",
				paths: ["src/label.js"],
				writes: { "src/label.js": 'export const label = "api";\n' },
				witnesses: withWitnesses ? { api: witness("src/label.js", 'String(m.label).split("+").includes("api")') } : undefined,
			},
			{
				id: "sub-b",
				intent: "The label must include ui.",
				paths: ["src/label.js"],
				writes: { "src/label.js": 'export const label = "ui";\n' },
				witnesses: withWitnesses ? { ui: witness("src/label.js", 'String(m.label).split("+").includes("ui")') } : undefined,
			},
		]),
	};
}

/** A replayer script (node) that answers from the request; written to disk and run as a command. */
function replayer(body: string): string {
	const file = path.join(tempDir("madgrix-gr-replayer-"), "replayer.mjs");
	writeFileSync(
		file,
		[
			'import { readFileSync } from "node:fs";',
			'const req = JSON.parse(readFileSync(0, "utf8"));',
			'const value = (text) => (text.match(/"([^"]*)"/) ?? [])[1];',
			body,
		].join("\n"),
	);
	return `node ${JSON.stringify(file)}`;
}

/** Writes both values, sorted, whatever the order: the conflict commutes. */
const COMMUTING = replayer(
	'process.stdout.write(`export const label = "${[value(req.target.text), value(req.source.text)].sort().join("+")}";\\n`);',
);
/** Keeps the target untouched: loses the source's intent in both orders. */
const KEEP_TARGET = replayer("process.stdout.write(req.target.text);");
/** Merges correctly in AB only; in BA it keeps the target. */
const ORDER_BIASED = replayer(
	'process.stdout.write(req.order === "AB" ? `export const label = "${value(req.target.text)}+${value(req.source.text)}";\\n` : req.target.text);',
);
/** Both orders admitted, but the text differs: "api+ui" vs "ui+api". */
const ORDER_TEXT = replayer('process.stdout.write(`export const label = "${value(req.target.text)}+${value(req.source.text)}";\\n`);');

function ctx(): Ctx {
	return {
		now: () => "2026-10-18T12:00:00.000Z",
		randomHex: (n: number) => "c".repeat(n * 2),
		sha256Hex,
		selectorPolicyHash: "policyhash",
		// Unit tests of other authority rules over synthetic SHAs: the admission
		// proof itself is covered in resolution-hardening-v3/v4 with a real key.
		insecureUnpinnedWitnessRunner: true,
		policyVersion: "seam-policy/0.1.0",
	};
}

function authorityFor(baseline: string) {
	const state = createAuthority({
		task_id: "task-gr",
		task_hash: "task-gr-hash",
		intent: "governed resolution",
		baseline_repo: "acme/app",
		baseline_commit: baseline,
		behavior_contract: "both intents hold",
		policy_version: "seam-policy/0.1.0",
		frozen_at: "2026-10-18T11:00:00Z",
	});
	state.contenders["contender-gr"] = {
		contender_id: "contender-gr",
		agent_id: "parent",
		fork_repo: "fork-gr",
		fork_lineage: { parent_repo: "acme/app", parent_commit: baseline },
		fork_base: baseline,
		token_id: "tok-gr",
		status: "forked",
		claim_work_id: null,
		latest_commit: baseline,
	};
	return state;
}

describe("conflict hunks", () => {
	it("splits a two-sided conflict into clean segments and hunks that rebuild every side", () => {
		const base = "one\ntwo\nthree\nfour\nfive\nsix\nseven\n";
		const ours = "ONE-a\ntwo\nthree\nFOUR-a\nfive\nsix\nseven\n";
		const theirs = "one\ntwo\nthree\nFOUR-b\nfive\nsix\nSEVEN-b\n";
		const split = conflictHunks(base, ours, theirs);
		assert.ok(split);
		assert.equal(split.hunks.length, 1);
		assert.deepEqual(split.hunks[0], { base: "four\n", ours: "FOUR-a\n", theirs: "FOUR-b\n" });
		assert.equal(split.segments.length, 2);
		assert.equal(fillTemplate(split.segments, ["four\n"]), "ONE-a\ntwo\nthree\nfour\nfive\nsix\nSEVEN-b\n");
		assert.deepEqual(matchTemplate(split.segments, "ONE-a\ntwo\nthree\nFOUR-ab\nfive\nsix\nSEVEN-b\n"), ["FOUR-ab\n"]);
		assert.equal(matchTemplate(split.segments, "one\ntwo\nthree\nFOUR-ab\nfive\nsix\nSEVEN-b\n"), null);
		assert.equal(matchTemplate(split.segments, "ONE-a\ntwo\nthree\nFOUR-ab\nfive\nsix\nseven\n"), null);
	});

	it("falls back to a whole-file lease when the split would not be exact", () => {
		assert.equal(conflictHunks("a\n", "b", "c\n"), null, "missing final newline");
		const marker = `${"<".repeat(32)} looks like a marker\n`;
		assert.equal(conflictHunks(marker, "b\n", "c\n"), null, "marker-like input line");
	});
});

describe("hunk-level lease", () => {
	function sharedFile() {
		const base = "one\ntwo\nthree\nfour\nfive\nsix\nseven\n";
		return {
			repo: initRepo({ "src/s.txt": base, "README.md": "baseline\n" }),
			...makeCrew([
				{ id: "sub-a", intent: "a", paths: ["src/s.txt"], writes: { "src/s.txt": "ONE-a\ntwo\nthree\nFOUR-a\nfive\nsix\nseven\n" } },
				{ id: "sub-b", intent: "b", paths: ["src/s.txt"], writes: { "src/s.txt": "one\ntwo\nthree\nFOUR-b\nfive\nsix\nSEVEN-b\n" } },
			]),
		};
	}

	it("pre-composes the clean lines of a conflicted file, so a resolver that writes only the hunk keeps both agents' other edits", async () => {
		const { repo, crew } = sharedFile();
		const conflicted = await runCrewOnFork(repo, crew, undefined, stubGate);
		assert.equal(conflicted.status, "CONFLICTED");
		const resolved = resolveComposition(repo, conflicted, "sed -i 's/^four$/FOUR-ab/' src/s.txt");
		assert.equal(git(repo, ["show", `${resolved.sha}:src/s.txt`]), "ONE-a\ntwo\nthree\nFOUR-ab\nfive\nsix\nSEVEN-b");
		assert.deepEqual(resolved.lease.hunked_paths, ["src/s.txt"]);
		assert.equal(resolved.lease.hunks.length, 1);
		assert.equal(resolved.lease.hunks[0].path, "src/s.txt");
	});

	it("refuses a resolver that changes a clean line inside the conflicted file", async () => {
		const { repo, crew } = sharedFile();
		const conflicted = await runCrewOnFork(repo, crew, undefined, stubGate);
		assert.throws(
			() => resolveComposition(repo, conflicted, "sed -i 's/^ONE-a$/one/; s/^four$/FOUR-ab/' src/s.txt"),
			/resolver changed clean lines of src\/s\.txt outside its leased hunks/,
		);
		assert.equal(git(repo, ["rev-parse", "HEAD"]), conflicted.baseline);
	});

	it("refuses resolver environment names that look like credentials or override the lease", async () => {
		const { repo, crew } = sharedFile();
		const conflicted = await runCrewOnFork(repo, crew, undefined, stubGate);
		assert.throws(() => resolveComposition(repo, conflicted, "true", { env: { CONTROL_SERVICE_TOKEN: "x" } }), /may not set CONTROL_SERVICE_TOKEN/);
		assert.throws(() => resolveComposition(repo, conflicted, "true", { env: { CLOUDFLARE_API_TOKEN: "x" } }), /may not set CLOUDFLARE_API_TOKEN/);
		assert.throws(() => resolveComposition(repo, conflicted, "true", { env: { MADGRIX_LEASED_PATHS: "x" } }), /may not set MADGRIX_LEASED_PATHS/);
	});
});

describe("frozen witnesses", () => {
	it("count only witnesses that tell a side apart from the baseline, and refuse a resolution that drops a side", async () => {
		const { repo, crew, witnesses } = labelScenario();
		assert.ok(witnesses);
		const conflicted = await runCrewOnFork(repo, crew, undefined, stubGate);
		const frozen = freezeWitnesses(repo, conflicted.baseline, conflicted.commits, witnesses);
		assert.deepEqual(frozen.outcomes["sub-a/api"], { baseline: "fail", own: "pass" });
		assert.deepEqual(frozen.outcomes["sub-b/ui"], { baseline: "fail", own: "pass" });

		const lazy = resolveComposition(repo, conflicted, "printf '%s\\n' 'export const label = \"ui\";' > src/label.js");
		const refused = witnessReport(repo, lazy.sha, witnesses, frozen, { requiredSides: ["sub-a", "sub-b"] });
		assert.equal(refused.verdict, "REFUSE");
		assert.deepEqual(
			refused.report.sides.map((s: { agent_id: string; status: string }) => [s.agent_id, s.status]),
			[["sub-a", "LOST"], ["sub-b", "PRESERVED"]],
		);
		assert.match(refused.report.reasons.join("\n"), /sub-a: witness api fails on the candidate/);

		const both = resolveComposition(repo, conflicted, "printf '%s\\n' 'export const label = \"api+ui\";' > src/label.js");
		const admitted = witnessReport(repo, both.sha, witnesses, frozen, { requiredSides: ["sub-a", "sub-b"] });
		assert.equal(admitted.verdict, "ADMIT");
		assert.match(admitted.sha256, /^[0-9a-f]{64}$/);
	});

	it("run the bytes frozen at load time, not whatever the script file says later", async () => {
		const { repo, crew, witnesses, configPath } = labelScenario();
		assert.ok(witnesses);
		const conflicted = await runCrewOnFork(repo, crew, undefined, stubGate);
		const frozen = freezeWitnesses(repo, conflicted.baseline, conflicted.commits, witnesses);
		// Someone rewrites sub-a's witness on disk to always pass.
		writeFileSync(path.join(path.dirname(configPath), "witness", "sub-a", "api.mjs"), "process.exit(0);\n");
		const lazy = resolveComposition(repo, conflicted, "printf '%s\\n' 'export const label = \"ui\";' > src/label.js");
		assert.equal(witnessReport(repo, lazy.sha, witnesses, frozen, { requiredSides: ["sub-a", "sub-b"] }).verdict, "REFUSE");
		// A fresh load sees a different manifest, so its outcomes cannot be mixed with the frozen ones.
		const reloaded = loadWitnesses(configPath, crew);
		assert.ok(reloaded);
		assert.notEqual(reloaded.sha256, witnesses.sha256);
		assert.throws(() => witnessReport(repo, lazy.sha, reloaded, frozen, { requiredSides: [] }), /frozen for another manifest/);
	});

	it("send a resolution to REVIEW when a conflicting side has no discriminating witness", async () => {
		const { repo, crew, witnesses } = makeCrewWithWeakWitness();
		assert.ok(witnesses);
		const conflicted = await runCrewOnFork(repo, crew, undefined, stubGate);
		const frozen = freezeWitnesses(repo, conflicted.baseline, conflicted.commits, witnesses);
		const both = resolveComposition(repo, conflicted, "printf '%s\\n' 'export const label = \"api+ui\";' > src/label.js");
		const report = witnessReport(repo, both.sha, witnesses, frozen, { requiredSides: ["sub-a", "sub-b"] });
		assert.equal(report.verdict, "REVIEW");
		assert.equal(report.report.sides.find((s: { agent_id: string }) => s.agent_id === "sub-b")?.status, "UNWITNESSED");
		assert.match(report.report.reasons.join("\n"), /sub-b: no witness tells its work apart from the baseline/);
	});

	function makeCrewWithWeakWitness() {
		return {
			repo: initRepo({ "src/label.js": 'export const label = "base";\n', "README.md": "baseline\n" }),
			...makeCrew([
				{
					id: "sub-a",
					intent: "The label must include api.",
					paths: ["src/label.js"],
					writes: { "src/label.js": 'export const label = "api";\n' },
					witnesses: { api: witness("src/label.js", 'String(m.label).split("+").includes("api")') },
				},
				{
					id: "sub-b",
					intent: "The label must include ui.",
					paths: ["src/label.js"],
					writes: { "src/label.js": 'export const label = "ui";\n' },
					// Passes on the baseline too, so it says nothing about sub-b's change.
					witnesses: { exists: witness("src/label.js", "typeof m.label === 'string'") },
				},
			]),
		};
	}
});

describe("resolution ladder", () => {
	it("structured rung: Mergiraf merges two keys added at the same place, and the witnesses admit it", { skip: MERGIRAF === null ? "mergiraf is not installed" : false }, async () => {
		const { repo, crew, witnesses } = configScenario();
		assert.ok(witnesses);
		const conflicted = await runCrewOnFork(repo, crew, undefined, stubGate);
		assert.equal(conflicted.status, "CONFLICTED", "line merge cannot place both keys");
		const frozen = freezeWitnesses(repo, conflicted.baseline, conflicted.commits, witnesses);
		const result = resolveWithLadder(repo, conflicted, { witnesses, frozen, mergiraf: MERGIRAF, replayer: null });
		assert.equal(result.status, "RESOLVED");
		if (result.status !== "RESOLVED") return;
		assert.equal(result.rung, "structured");
		assert.equal(result.witness.verdict, "ADMIT");
		const text = git(repo, ["show", `${result.sha}:src/config.js`]);
		assert.match(text, /timeout: 10/);
		assert.match(text, /jitter: true/);
	});

	it("replay rung: a commuting replayer gives the same text in both orders and is admitted as identical", async () => {
		const { repo, crew, witnesses } = labelScenario();
		assert.ok(witnesses);
		const conflicted = await runCrewOnFork(repo, crew, undefined, stubGate);
		const frozen = freezeWitnesses(repo, conflicted.baseline, conflicted.commits, witnesses);
		const result = resolveWithLadder(repo, conflicted, { witnesses, frozen, mergiraf: MERGIRAF, replayer: COMMUTING, replayerId: "sorted" });
		assert.equal(result.status, "RESOLVED");
		if (result.status !== "RESOLVED") return;
		assert.equal(result.rung, "replay");
		assert.equal(result.order, "AB");
		assert.equal(result.order_agreement, "identical");
		assert.equal(git(repo, ["show", `${result.sha}:src/label.js`]), 'export const label = "api+ui";');
		assert.equal(git(repo, ["rev-parse", "HEAD"]), result.sha);
	});

	it("replay rung: both orders admitted with different text is recorded as behavioral agreement", async () => {
		const { repo, crew, witnesses } = labelScenario();
		assert.ok(witnesses);
		const conflicted = await runCrewOnFork(repo, crew, undefined, stubGate);
		const frozen = freezeWitnesses(repo, conflicted.baseline, conflicted.commits, witnesses);
		const result = resolveWithLadder(repo, conflicted, { witnesses, frozen, mergiraf: null, replayer: ORDER_TEXT });
		assert.equal(result.status, "RESOLVED");
		if (result.status !== "RESOLVED") return;
		assert.equal(result.order_agreement, "behavioral");
		assert.equal(git(repo, ["show", `${result.sha}:src/label.js`]), 'export const label = "api+ui";', "R_AB is kept");
	});

	it("replay rung: when only one order is admitted the result depends on order, so it escalates instead of picking a winner", async () => {
		const { repo, crew, witnesses } = labelScenario();
		assert.ok(witnesses);
		const conflicted = await runCrewOnFork(repo, crew, undefined, stubGate);
		const frozen = freezeWitnesses(repo, conflicted.baseline, conflicted.commits, witnesses);
		const result = resolveWithLadder(repo, conflicted, { witnesses, frozen, mergiraf: null, replayer: ORDER_BIASED });
		assert.equal(result.status, "REVIEW");
		if (result.status !== "REVIEW") return;
		assert.match(result.reason, /the two replay orders disagree/);
		assert.deepEqual(
			result.candidates.map((c: { order: string | null; witness: { verdict: string } }) => [c.order, c.witness.verdict]),
			[["AB", "ADMIT"], ["BA", "REFUSE"]],
		);
		assert.equal(git(repo, ["rev-parse", "HEAD"]), conflicted.baseline, "nothing is left checked out");
	});

	it("replay rung: a replayer that keeps one side loses the other side's witness in both orders", async () => {
		const { repo, crew, witnesses } = labelScenario();
		assert.ok(witnesses);
		const conflicted = await runCrewOnFork(repo, crew, undefined, stubGate);
		const frozen = freezeWitnesses(repo, conflicted.baseline, conflicted.commits, witnesses);
		const result = resolveWithLadder(repo, conflicted, { witnesses, frozen, mergiraf: null, replayer: KEEP_TARGET });
		assert.equal(result.status, "REVIEW");
		if (result.status !== "REVIEW") return;
		assert.match(result.reason, /neither replay order produced an admissible candidate/);
	});
});

describe("LLM replayer adapter", () => {
	const request = {
		format: "madgrix-replay-request/v1",
		path: "src/label.js",
		hunk_index: 0,
		order: "AB",
		base: 'export const label = "base";\n',
		target: { agent_id: "sub-a", intent: "include api", text: 'export const label = "api";\n' },
		source: { agent_id: "sub-b", intent: "include ui", text: 'export const label = "ui";\n' },
		context: { before: "", after: "" },
	};

	it("asks for the target rewritten with the source's intent, and parses the tagged answer", () => {
		const prompt = replayPrompt(request);
		assert.match(prompt, /TARGET \(agent sub-a\)/);
		assert.match(prompt, /SOURCE \(agent sub-b\)/);
		assert.match(prompt, /include ui/);
		assert.equal(parseResolution('<resolution>\nexport const label = "api+ui";</resolution>', request), 'export const label = "api+ui";\n');
		assert.throws(() => parseResolution("no tags", request), /no <resolution> block/);
	});

	it("calls the Anthropic Messages API and Workers AI with the expected shape (local mock server)", async () => {
		const seen: Array<{ url: string; headers: Record<string, unknown>; body: any }> = [];
		const server = createServer((req, res) => {
			let raw = "";
			req.on("data", (chunk) => (raw += chunk));
			req.on("end", () => {
				seen.push({ url: req.url ?? "", headers: req.headers, body: JSON.parse(raw) });
				res.setHeader("content-type", "application/json");
				res.end(
					req.url?.startsWith("/v1/messages")
						? JSON.stringify({ content: [{ type: "text", text: "<resolution>A</resolution>" }] })
						: JSON.stringify({ result: { response: "<resolution>B</resolution>" } }),
				);
			});
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as { port: number }).port;
		try {
			const base = `http://127.0.0.1:${port}`;
			const a = await callModel("hello", { LLM_PROVIDER: "anthropic", LLM_MODEL: "test-model", ANTHROPIC_API_KEY: "test-key", LLM_BASE_URL: base });
			assert.equal(a, "<resolution>A</resolution>");
			assert.equal(seen[0].url, "/v1/messages");
			assert.equal(seen[0].headers["x-api-key"], "test-key");
			assert.equal(seen[0].headers["anthropic-version"], "2023-06-01");
			assert.equal(seen[0].body.model, "test-model");
			assert.equal(seen[0].body.temperature, 0);
			assert.equal(seen[0].body.messages[0].content, "hello");

			const b = await callModel("hello", {
				LLM_PROVIDER: "workers-ai",
				LLM_MODEL: "@cf/test/model",
				WORKERS_AI_ACCOUNT_ID: "acct",
				WORKERS_AI_API_TOKEN: "wai-token",
				LLM_BASE_URL: base,
			});
			assert.equal(b, "<resolution>B</resolution>");
			assert.equal(seen[1].url, "/client/v4/accounts/acct/ai/run/@cf/test/model");
			assert.equal(seen[1].headers.authorization, "Bearer wai-token");
		} finally {
			server.close();
		}
		await assert.rejects(callModel("x", { LLM_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "k" }), /LLM_MODEL is required/);
		await assert.rejects(callModel("x", { LLM_PROVIDER: "other", LLM_MODEL: "m" }), /LLM_PROVIDER must be/);
	});
});

describe("what the control plane records", () => {
	it("a resolved conflict is recorded as CONFLICTED then RESOLVED, and the authority accepts both with the same capsule", async () => {
		const { repo, crew, witnesses } = labelScenario();
		assert.ok(witnesses);
		const conflicted = await runCrewOnFork(repo, crew, undefined, stubGate);
		const frozen = freezeWitnesses(repo, conflicted.baseline, conflicted.commits, witnesses);
		const governed = await governCrewResult(repo, conflicted, {
			taskHash: "task-gr-hash",
			contenderId: "contender-gr",
			witnesses,
			frozen,
			mode: "ladder",
			mergiraf: null,
			replayer: COMMUTING,
			replayerId: "sorted",
		});
		assert.equal(governed.status, "RESOLVED");
		assert.deepEqual(governed.compositions.map((c: { status: string }) => c.status), ["CONFLICTED", "RESOLVED"]);
		let state = authorityFor(conflicted.baseline);
		for (const composition of governed.compositions) state = await recordComposition(state, composition, ctx());
		assert.equal(state.composition?.status, "RESOLVED");
		assert.equal(state.composition?.candidate_sha, governed.candidateSha);
		assert.equal(state.composition?.capsule_id, "capsule" in governed ? governed.capsule?.capsule_id : undefined);
		assert.equal(state.composition?.resolution?.rung, "replay");
		assert.equal(state.composition?.resolution?.order_agreement, "identical");
		assert.equal(state.composition?.resolution?.witness.verdict, "ADMIT");
		assert.equal(state.ledger.filter((e) => e.kind === "resolution_recorded").length, 1);
	});

	it("a clean text merge that breaks a side's witnessed intent is a semantic conflict and is not recorded", async () => {
		const repo = initRepo({
			"src/units.js": "export const TIMEOUT = 30; // seconds\n",
			"src/client.js": "export const timeoutMs = () => 5000;\n",
			"README.md": "baseline\n",
		});
		const { crew, witnesses } = makeCrew([
			{
				id: "sub-units",
				intent: "Store TIMEOUT in milliseconds.",
				paths: ["src/units.js"],
				writes: { "src/units.js": "export const TIMEOUT = 30000; // milliseconds\n" },
				witnesses: { ms: witness("src/units.js", "m.TIMEOUT === 30000") },
			},
			{
				id: "sub-client",
				intent: "Derive the client timeout from TIMEOUT: 30 s.",
				paths: ["src/client.js"],
				writes: { "src/client.js": 'import { TIMEOUT } from "./units.js";\nexport const timeoutMs = () => TIMEOUT * 1000;\n' },
				witnesses: { thirty: witness("src/client.js", "m.timeoutMs() === 30000") },
			},
		]);
		assert.ok(witnesses);
		const composed = await runCrewOnFork(repo, crew, undefined, stubGate);
		assert.equal(composed.status, "COMPOSED", "the edits touch different files, so git merges them");
		const frozen = freezeWitnesses(repo, composed.baseline, composed.commits, witnesses);
		const governed = await governCrewResult(repo, composed, {
			taskHash: "task-gr-hash",
			contenderId: "contender-gr",
			witnesses,
			frozen,
			mode: "none",
		});
		assert.equal(governed.status, "SEMANTIC_CONFLICT");
		assert.deepEqual(governed.compositions, []);
		assert.match("detail" in governed ? String(governed.detail) : "", /sub-client: witness thirty fails on the candidate/);
		assert.equal(git(repo, ["rev-parse", "HEAD"]), composed.baseline);
	});

	it("an unwitnessed resolution stays in REVIEW until a person clears it, and the authority records who did", async () => {
		const { repo, crew } = labelScenario(false);
		const conflicted = await runCrewOnFork(repo, crew, undefined, stubGate);
		const command = "printf '%s\\n' 'export const label = \"api+ui\";' > src/label.js";
		const blocked = await governCrewResult(repo, conflicted, {
			taskHash: "task-gr-hash",
			contenderId: "contender-gr",
			witnesses: null,
			frozen: null,
			mode: "command",
			command,
		});
		assert.equal(blocked.status, "REVIEW");
		assert.deepEqual(blocked.compositions.map((c: { status: string }) => c.status), ["CONFLICTED"]);

		const cleared = await governCrewResult(repo, conflicted, {
			taskHash: "task-gr-hash",
			contenderId: "contender-gr",
			witnesses: null,
			frozen: null,
			mode: "command",
			command,
			reviewClearedBy: "ash: read both sides, label keeps api and ui",
		});
		assert.equal(cleared.status, "RESOLVED");
		let state = authorityFor(conflicted.baseline);
		for (const composition of cleared.compositions) state = await recordComposition(state, composition, ctx());
		assert.equal(state.composition?.resolution?.witness.verdict, "REVIEW");
		assert.equal(state.composition?.resolution?.witness.review_cleared_by, "ash: read both sides, label keeps api and ui");
	});

	it("a refused resolution cannot be cleared by review", async () => {
		const { repo, crew, witnesses } = labelScenario();
		assert.ok(witnesses);
		const conflicted = await runCrewOnFork(repo, crew, undefined, stubGate);
		const frozen = freezeWitnesses(repo, conflicted.baseline, conflicted.commits, witnesses);
		const governed = await governCrewResult(repo, conflicted, {
			taskHash: "task-gr-hash",
			contenderId: "contender-gr",
			witnesses,
			frozen,
			mode: "command",
			command: "printf '%s\\n' 'export const label = \"ui\";' > src/label.js",
			reviewClearedBy: "someone in a hurry",
		});
		assert.equal(governed.status, "REVIEW");
		assert.equal(governed.candidateSha, null);
	});
});
