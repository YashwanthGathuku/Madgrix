/**
 * The independent evaluator's run directory, tamper gate and tool-status
 * gates (spec 1 §6; spec 3 §4.3 evaluator locking;
 * specs/amendments/evidence-integrity-v1.md and tool-status-v1.md).
 *
 * Runs scripts/evaluate-candidate.ts as a child process against a local HTTP
 * mock of the Worker's two evaluation-domain routes and local bare Git
 * repositories (no network, no Cloudflare). The baseline is a small Node
 * project whose package.json "test" script runs test/sum.test.js against a
 * buggy src/sum.js. The hidden command runs that script the way `npm test`
 * does, from whatever directory the evaluator runs it in.
 *
 * node --test test/evaluator-isolation.test.ts
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256Hex } from "../src/lib/canonical.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TASK_ID = `task_${"e".repeat(24)}`;
const TASK_HASH = "a".repeat(64);
const EVAL_TOKEN = "fake-evaluation-zone-token-1e2f";

/** `npm test`, without npm: run package.json's "test" script under bash. */
const NPM_TEST =
	`node -e 'const r = require("node:child_process").spawnSync("bash", ["-c", require("./package.json").scripts.test], ` +
	`{ stdio: "inherit" }); process.exit(r.status ?? 1)'`;

const BASELINE_PACKAGE = { name: "sum", private: true, scripts: { test: "node test/sum.test.js" } };
const BASELINE_FILES: Record<string, string> = {
	"package.json": JSON.stringify(BASELINE_PACKAGE, null, 2) + "\n",
	"src/sum.js": "exports.sum = (a, b) => a - b;\n",
	"test/sum.test.js":
		'const assert = require("node:assert");\nconst { sum } = require("../src/sum.js");\nassert.strictEqual(sum(2, 3), 5);\n',
};
const FIXED_SUM = "exports.sum = (a, b) => a + b;\n";

const fx = {} as {
	root: string;
	home: string;
	tmp: string;
	seed: string;
	hidden: string;
	baselineSha: string;
	url: string;
	server: Server;
	contenders: Map<string, { bare: string; scope: string[]; agent: string }>;
	/** Requests the mock Worker received. */
	requests: number;
};

function git(cwd: string, ...args: string[]): string {
	return execFileSync(
		"git",
		["-c", "user.name=madgrix-test", "-c", "user.email=test@madgrix.invalid", "-c", "commit.gpgsign=false", ...args],
		{ cwd, env: { PATH: process.env.PATH ?? "", HOME: fx.home, GIT_CONFIG_NOSYSTEM: "1" }, encoding: "utf8" },
	).trim();
}

function shq(s: string): string {
	return `'${s.replaceAll("'", `'\\''`)}'`;
}

async function writeFiles(dir: string, files: Record<string, string | null>): Promise<void> {
	for (const [name, content] of Object.entries(files)) {
		const file = path.join(dir, name);
		if (content === null) {
			await rm(file, { force: true });
			continue;
		}
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(file, content);
	}
}

/** A machine-readable tool log (specs/amendments/tool-status-v1.md) for `contenderId`. */
function toolLog(contenderId: string, agent: string): string {
	return (
		[
			{
				format: "madgrix-tool-status/v1",
				task_id: TASK_ID,
				contender_id: contenderId,
				agent_id: agent,
				baseline_commit: fx.baselineSha,
				model: "test-model-7",
				harness: "test-harness/1.0",
			},
			{ seq: 1, action: "edit_file", tool_status: "OK" },
			{ seq: 2, action: "run_tests", tool_status: "FAILED(nonzero_exit)" },
			{ seq: 3, action: "run_tests", tool_status: "OK" },
		]
			.map((record) => JSON.stringify(record))
			.join("\n") + "\n"
	);
}

/**
 * A contender fork holding the baseline plus one candidate commit that
 * applies `changes` (null deletes), registered with the mock under `scope`.
 */
async function makeCandidate(
	contenderId: string,
	changes: Record<string, string | null>,
	scope: string[],
): Promise<{ contenderId: string; sha: string }> {
	const agent = `agent-${contenderId}`;
	const bare = path.join(fx.root, "forks", `${contenderId}.git`);
	git(fx.root, "clone", "--quiet", "--bare", fx.seed, bare);
	const work = path.join(fx.root, "work", contenderId);
	git(fx.root, "clone", "--quiet", bare, work);
	await writeFiles(work, changes);
	git(work, "add", "-A");
	git(work, "commit", "--quiet", "-m", `candidate ${contenderId}`);
	git(work, "push", "--quiet", "origin", "HEAD:refs/heads/main");
	fx.contenders.set(contenderId, { bare, scope, agent });
	return { contenderId, sha: git(work, "rev-parse", "HEAD") };
}

interface Evaluation {
	code: number | null;
	stderr: string;
	result: any;
}

function runNode(script: string, env: Record<string, string>): Promise<{ code: number | null; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [script], { cwd: REPO_ROOT, env, stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		child.stderr.on("data", (b) => (stderr += b));
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stderr }));
	});
}

function evaluate(candidate: { contenderId: string; sha: string }, extra: Record<string, string> = {}): Promise<Evaluation> {
	const resultPath = path.join(fx.root, `result-${candidate.contenderId}.json`);
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: fx.home,
		LANG: "C.UTF-8",
		TMPDIR: fx.tmp,
		MADGRIX_BASE_URL: fx.url,
		MADGRIX_TASK_ID: TASK_ID,
		MADGRIX_CONTENDER_ID: candidate.contenderId,
		MADGRIX_CANDIDATE_SHA: candidate.sha,
		MADGRIX_EVALUATION_SERVICE_TOKEN: EVAL_TOKEN,
		// Not provenance: the model id must come from the agent's tool log.
		MADGRIX_MODEL_NAME: "env-model-is-not-provenance",
		MADGRIX_HIDDEN_TEST_COMMAND: NPM_TEST,
		MADGRIX_RESULT_PATH: resultPath,
		...extra,
	};
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["scripts/evaluate-candidate.ts"], {
			cwd: REPO_ROOT,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stderr = "";
		child.stdout.resume();
		child.stderr.on("data", (b) => (stderr += b));
		child.on("error", reject);
		child.on("close", async (code) => {
			const result = await readFile(resultPath, "utf8").then(JSON.parse, () => null);
			resolve({ code, stderr, result });
		});
	});
}

/** Evaluate once per candidate; several tests read the same run. */
function memo(make: () => Promise<Evaluation>): () => Promise<Evaluation> {
	let run: Promise<Evaluation> | null = null;
	return () => (run ??= make());
}

async function startMock(): Promise<Server> {
	const server = createServer(async (req, res) => {
		fx.requests++;
		const send = (status: number, data: unknown) => {
			res.writeHead(status, { "content-type": "application/json" });
			res.end(JSON.stringify(data));
		};
		const chunks: Buffer[] = [];
		for await (const chunk of req) chunks.push(chunk as Buffer);
		const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
		if (req.headers.authorization !== `Bearer ${EVAL_TOKEN}`) return send(401, { error: "evaluation_domain_auth_required" });
		const { pathname } = new URL(req.url ?? "/", "http://mock.invalid");
		if (req.method === "POST" && pathname === `/tasks/${TASK_ID}/evaluator-credentials`) {
			const c = fx.contenders.get(body.contender_id);
			if (!c) return send(404, { error: "contender_not_found" });
			return send(200, {
				contender_id: body.contender_id,
				fork_repo: `fork-${body.contender_id}`,
				remote: c.bare,
				token: "fake-fork-read-token",
				expires_at: new Date(Date.now() + 300_000).toISOString(),
				task_hash: TASK_HASH,
				baseline_commit: fx.baselineSha,
				claim: { agent: c.agent, scope: { paths: c.scope, symbols: [] } },
				latest_commit: git(c.bare, "rev-parse", "refs/heads/main"),
				agent_id: c.agent,
				fork_lineage: { parent_repo: "madgrix/sum", parent_commit: fx.baselineSha },
			});
		}
		if (req.method === "POST" && pathname === `/tasks/${TASK_ID}/evidence`) return send(200, { recorded: true });
		return send(404, { error: "no route" });
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return server;
}

before(async () => {
	fx.root = await mkdtemp(path.join(os.tmpdir(), "madgrix-evaluator-"));
	fx.home = path.join(fx.root, "home");
	fx.tmp = path.join(fx.root, "tmp");
	fx.seed = path.join(fx.root, "seed");
	fx.hidden = path.join(fx.root, "hidden-tests");
	for (const dir of [fx.home, fx.tmp, fx.seed, fx.hidden]) await mkdir(dir, { recursive: true });
	git(fx.seed, "init", "--quiet", "--initial-branch=main");
	await writeFiles(fx.seed, BASELINE_FILES);
	git(fx.seed, "add", "-A");
	git(fx.seed, "commit", "--quiet", "-m", "baseline");
	fx.baselineSha = git(fx.seed, "rev-parse", "HEAD");
	await writeFiles(fx.hidden, {
		"hidden/sum.hidden.test.js":
			'const assert = require("node:assert");\nconst { sum } = require("../src/sum.js");\nassert.strictEqual(sum(-2, 2), 0);\n',
	});
	fx.contenders = new Map();
	fx.requests = 0;
	fx.server = await startMock();
	fx.url = `http://127.0.0.1:${(fx.server.address() as AddressInfo).port}`;
});

after(async () => {
	fx.server?.closeAllConnections();
	await new Promise<void>((resolve) => (fx.server ? fx.server.close(() => resolve()) : resolve()));
	if (fx.root) await rm(fx.root, { recursive: true, force: true });
});

describe("evaluate-candidate.ts: tamper gate and baseline runner configuration", () => {
	const exitZero = memo(async () => {
		const pkg = { ...BASELINE_PACKAGE, scripts: { test: "exit 0" } };
		// The claim covers package.json, so only the runner-configuration rule can flag it.
		const candidate = await makeCandidate(
			"exit-zero",
			{ "package.json": JSON.stringify(pkg, null, 2) + "\n" },
			["src/**", "package.json"],
		);
		return evaluate(candidate);
	});

	it('(c) a candidate whose only change sets package.json "test" to "exit 0" fails no_eval_tampering', async () => {
		const { code, stderr, result } = await exitZero();
		assert.equal(code, 0, `evaluate-candidate failed:\n${stderr}`);
		assert.deepEqual(result.changed_files, ["package.json"]);
		assert.equal(result.bundle.admission.no_eval_tampering, false);
		assert.ok(
			result.bundle.security_policy.findings.includes("runner configuration changed: package.json"),
			`findings: ${JSON.stringify(result.bundle.security_policy.findings)}`,
		);
		assert.equal(result.bundle.security_policy.passed, false);
		assert.deepEqual(result.bundle.eval_file_changes, ["package.json"], "the authority quarantines on this list");
	});

	it("the hidden and regression commands run the BASELINE's package.json, not the candidate's", async () => {
		const { result } = await exitZero();
		assert.equal(result.bundle.hidden_oracle.passed, false, "baseline test/sum.test.js still fails on the unfixed sum");
		assert.equal(result.bundle.regressions.passed, false);
	});

	it("hidden tests are copied in and every command runs outside the candidate checkout", async () => {
		const pwdFile = path.join(fx.root, "hidden-command.pwd");
		const candidate = await makeCandidate(
			"sabotage",
			{ "src/sum.js": FIXED_SUM, "test/sum.test.js": "process.exit(1);\n" },
			["src/**", "test/**"],
		);
		const { code, stderr, result } = await evaluate(candidate, {
			MADGRIX_HIDDEN_TESTS_DIR: fx.hidden,
			MADGRIX_HIDDEN_TEST_COMMAND:
				`pwd > ${shq(pwdFile)} && test ! -e .git && test -f hidden/sum.hidden.test.js && ` +
				`node hidden/sum.hidden.test.js && ${NPM_TEST}`,
		});
		assert.equal(code, 0, `evaluate-candidate failed:\n${stderr}`);
		assert.equal(
			result.bundle.hidden_oracle.passed,
			true,
			`the baseline test file and the hidden test ran against the fixed sum: ${JSON.stringify(result.bundle.hidden_oracle)}`,
		);
		assert.equal(result.bundle.admission.no_eval_tampering, false);
		assert.ok(result.bundle.security_policy.findings.includes("test material changed: test/sum.test.js"));
		assert.deepEqual(result.bundle.eval_file_changes, ["test/sum.test.js"]);
		const runDir = (await readFile(pwdFile, "utf8")).trim();
		await assert.rejects(stat(runDir), "the run directory is removed after the evaluation");
	});
});

describe("evaluate-candidate.ts: tool-status log gates", () => {
	it("an in-scope fix with a tool log passes every admission gate; provenance names the log's model", async () => {
		const id = "honest";
		const candidate = await makeCandidate(
			id,
			{ "src/sum.js": FIXED_SUM, ".madgrix/tool-status.jsonl": toolLog(id, `agent-${id}`) },
			["src/**"],
		);
		const { code, stderr, result } = await evaluate(candidate);
		assert.equal(code, 0, `evaluate-candidate failed:\n${stderr}`);
		assert.deepEqual(result.bundle.admission, {
			exact_baseline: true,
			scope_compliance: true,
			valid_tool_states: true,
			no_eval_tampering: true,
			provenance_complete: true,
		});
		assert.equal(result.bundle.hidden_oracle.passed, true);
		assert.deepEqual(result.bundle.security_policy.findings, []);
		assert.deepEqual(result.bundle.eval_file_changes, []);
		assert.equal(result.provenance.model, "test-model-7");
		assert.equal(result.provenance.harness, "test-harness/1.0");
		assert.equal(result.provenance.agent_id, `agent-${id}`);
	});

	it("without a tool log, valid_tool_states and provenance_complete are false (MADGRIX_MODEL_NAME does not count)", async () => {
		const candidate = await makeCandidate("no-log", { "src/sum.js": FIXED_SUM }, ["src/**"]);
		const { code, stderr, result } = await evaluate(candidate);
		assert.equal(code, 0, `evaluate-candidate failed:\n${stderr}`);
		assert.equal(result.bundle.admission.valid_tool_states, false);
		assert.equal(result.bundle.admission.provenance_complete, false);
		assert.equal(result.bundle.admission.exact_baseline, true);
		assert.equal(result.bundle.admission.scope_compliance, true);
		assert.equal(result.bundle.admission.no_eval_tampering, true);
	});
});

describe("evaluate-candidate.ts: the bundle commits to the evaluation configuration (spec 1 §7)", () => {
	it("evaluation_config_sha256 is the digest of the commands, test globs, hidden tests and evaluator, and tracks the hidden tests", async () => {
		const id = "config";
		const candidate = await makeCandidate(
			id,
			{ "src/sum.js": FIXED_SUM, ".madgrix/tool-status.jsonl": toolLog(id, `agent-${id}`) },
			["src/**"],
		);
		const hiddenA = await mkdtemp(path.join(fx.root, "hidden-a-"));
		const hiddenB = await mkdtemp(path.join(fx.root, "hidden-b-"));
		await writeFiles(hiddenA, { "hidden/h.test.js": "require('node:assert').strictEqual(1, 1);\n" });
		await writeFiles(hiddenB, { "hidden/h.test.js": "require('node:assert').strictEqual(2, 2);\n" });
		const env = { MADGRIX_TEST_GLOBS: "**/*.check.js", MADGRIX_STATIC_COMMAND: "true" };
		const a = await evaluate(candidate, { ...env, MADGRIX_HIDDEN_TESTS_DIR: hiddenA });
		const b = await evaluate(candidate, { ...env, MADGRIX_HIDDEN_TESTS_DIR: hiddenB });
		for (const run of [a, b]) assert.equal(run.code, 0, `evaluate-candidate failed:\n${run.stderr}`);

		const config = a.result.evaluation_config;
		assert.match(a.result.bundle.evaluation_config_sha256, /^[0-9a-f]{64}$/);
		assert.equal(a.result.bundle.evaluation_config_sha256, await sha256Hex(canonicalJson(config)));
		assert.equal(config.commands.hidden, NPM_TEST);
		assert.equal(config.commands.regression, NPM_TEST);
		assert.equal(config.commands.static, "true");
		assert.equal(config.commands.semantic, null);
		assert.ok(config.test_globs.includes("**/*.check.js") && config.test_globs.includes("**/test/**"));
		assert.match(config.hidden_tests_sha256, /^[0-9a-f]{64}$/);
		assert.notEqual(
			b.result.bundle.evaluation_config_sha256,
			a.result.bundle.evaluation_config_sha256,
			"different hidden tests, different configuration digest",
		);
	});
});

describe("claim scope: no default \"**\" claim", () => {
	const base = () => ({
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: fx.home,
		TMPDIR: fx.tmp,
		MADGRIX_BASE_URL: fx.url,
		MADGRIX_TASK_ID: TASK_ID,
		MADGRIX_AGENT_SERVICE_TOKEN: "fake-agent-zone-token-77aa",
		MADGRIX_AGENT_COMMAND: "touch AGENT_RAN",
	});

	it("run-contenders.mjs refuses a missing or unbounded claim scope before any Worker call", async () => {
		const scopes: Array<Record<string, string>> = [
			{},
			{ MADGRIX_CLAIM_PATHS: "**" },
			{ MADGRIX_CLAIM_PATHS: "src/**, **" },
			{ MADGRIX_CLAIM_TEMPLATE: JSON.stringify({ scope: { paths: ["**"], symbols: [] } }) },
			{ MADGRIX_CLAIM_TEMPLATE: JSON.stringify({ scope: { paths: [], symbols: [] } }) },
		];
		for (const scope of scopes) {
			const before = fx.requests;
			const run = await runNode("scripts/run-contenders.mjs", { ...base(), ...scope });
			assert.equal(run.code, 2, `${JSON.stringify(scope)}: ${run.stderr}`);
			assert.match(run.stderr, /scope/);
			assert.equal(fx.requests, before, `${JSON.stringify(scope)}: refused before any Worker call`);
		}
	});

	it("live-e2e.ts requires MADGRIX_CLAIM_PATHS (or a template) and no longer requires MADGRIX_MODEL_NAME", async () => {
		const before = fx.requests;
		const live = await runNode("scripts/live-e2e.ts", {
			...base(),
			MADGRIX_CONTROL_SERVICE_TOKEN: "fake-control-zone-token-88bb",
			MADGRIX_EVALUATION_SERVICE_TOKEN: EVAL_TOKEN,
			MADGRIX_BASELINE_REPO: "madgrix/sum",
			MADGRIX_BASELINE_COMMIT: fx.baselineSha,
			MADGRIX_INTENT: "fix sum",
			MADGRIX_BEHAVIOR_CONTRACT: "sum adds",
			MADGRIX_HIDDEN_TEST_COMMAND: "true",
		});
		assert.equal(live.code, 2);
		assert.match(live.stderr, /^Missing required environment: MADGRIX_CLAIM_PATHS \(or MADGRIX_CLAIM_TEMPLATE\)$/m);
		assert.equal(fx.requests, before, "refused before creating a task");
	});
});
