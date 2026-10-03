#!/usr/bin/env node
/// <reference types="node" />
/**
 * External MADGRIX evaluation domain.
 *
 * Run this on a disposable evaluator host/CI runner that is separate from
 * contender workspaces. It receives only a short-lived READ token for one
 * contender repo and never receives canonical write authority.
 *
 * Required:
 *   MADGRIX_BASE_URL
 *   MADGRIX_TASK_ID
 *   MADGRIX_CONTENDER_ID
 *   MADGRIX_CANDIDATE_SHA
 *   MADGRIX_EVALUATION_SERVICE_TOKEN
 *
 * Evaluation commands:
 *   MADGRIX_HIDDEN_TEST_COMMAND      required
 *   MADGRIX_REGRESSION_COMMAND       default = hidden command
 *   MADGRIX_SEMANTIC_COMMAND         optional (pass when absent)
 *   MADGRIX_STATIC_COMMAND           optional (pass when absent)
 *   MADGRIX_SECURITY_COMMAND         optional (pass when absent)
 *
 * Optional:
 *   MADGRIX_HIDDEN_TESTS_DIR   directory on this host whose files are copied
 *                              into the run directory
 *   MADGRIX_TEST_GLOBS         comma-separated globs added to the default test
 *                              globs (src/lib/eval-gates.ts)
 *   MADGRIX_HARNESS_VERSION    this evaluator's version, for the result
 *
 * Run directory (specs/amendments/evidence-integrity-v1.md): every command
 * runs in a fresh directory outside the candidate checkout that holds the
 * BASELINE's runner configuration and test material, the candidate's other
 * files, and the hidden tests. A candidate change to runner configuration,
 * to a path matched by a test glob, or to a path outside its claim scope
 * fails no_eval_tampering.
 *
 * Configuration digest (specs/amendments/evaluation-config-digest-v1.md):
 * before any candidate is fetched, the commands, test globs, a digest of the
 * hidden tests, the evaluator version and the runtime are hashed into the
 * bundle as evaluation_config_sha256.
 *
 * Tool-status log (specs/amendments/tool-status-v1.md): valid_tool_states
 * and provenance_complete come from the agent's .madgrix/tool-status.jsonl
 * in the candidate tree. The model id is the log's; no environment variable
 * supplies it.
 *
 * White-box caveat: candidate code and test processes share this disposable
 * evaluator host. This protects evaluator credentials/authority and destroys
 * persistence after the run; it does NOT claim hidden test contents are secret
 * from arbitrary malicious candidate code executing on the same host.
 *
 * Every child (git and the evaluation commands) runs with minimalEnv() only;
 * the evaluation commands run under `bash -c`, not a login shell. See
 * docs/SECURITY.md "Process environment boundaries".
 */

import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { canonicalJson, sha256Hex } from "../src/lib/canonical.ts";
import {
	DEFAULT_TEST_GLOBS,
	TOOL_STATUS_LOG_MAX_BYTES,
	TOOL_STATUS_LOG_PATH,
	changedPaths,
	checkToolStatusLog,
	composeRunTree,
	evaluatorGates,
	type RunFile,
	type TreeEntry,
} from "../src/lib/eval-gates.ts";
import { gitAuthEnv, minimalEnv } from "./lib/child-env.mjs";

const baseUrl = process.env.MADGRIX_BASE_URL?.replace(/\/$/, "");
const taskId = process.env.MADGRIX_TASK_ID;
const contenderId = process.env.MADGRIX_CONTENDER_ID;
const candidateSha = process.env.MADGRIX_CANDIDATE_SHA;
const serviceToken = process.env.MADGRIX_EVALUATION_SERVICE_TOKEN;
const hiddenCommand = process.env.MADGRIX_HIDDEN_TEST_COMMAND;
const regressionCommand = process.env.MADGRIX_REGRESSION_COMMAND ?? hiddenCommand;
const semanticCommand = process.env.MADGRIX_SEMANTIC_COMMAND;
const staticCommand = process.env.MADGRIX_STATIC_COMMAND;
const securityCommand = process.env.MADGRIX_SECURITY_COMMAND;
const harnessVersion = process.env.MADGRIX_HARNESS_VERSION ?? "madgrix-evaluator/0.1.0";
const hiddenTestsDir = process.env.MADGRIX_HIDDEN_TESTS_DIR ? path.resolve(process.env.MADGRIX_HIDDEN_TESTS_DIR) : undefined;
const testGlobs = [
	...DEFAULT_TEST_GLOBS,
	...(process.env.MADGRIX_TEST_GLOBS ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean),
];

if (!baseUrl || !taskId || !contenderId || !candidateSha || !serviceToken || !hiddenCommand) {
	console.error(
		"Missing required MADGRIX_* variables. Need BASE_URL, TASK_ID, CONTENDER_ID, " +
			"CANDIDATE_SHA, EVALUATION_SERVICE_TOKEN, HIDDEN_TEST_COMMAND.",
	);
	process.exit(2);
}
if (hiddenTestsDir !== undefined && !(await stat(hiddenTestsDir).then((s) => s.isDirectory(), () => false))) {
	console.error(`MADGRIX_HIDDEN_TESTS_DIR is not a directory: ${hiddenTestsDir}`);
	process.exit(2);
}

function capture(cmd: string, args: string[], cwd: string): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { cwd, env: minimalEnv(), stdio: ["ignore", "pipe", "pipe"] });
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		child.stdout.on("data", (b: Buffer) => out.push(b));
		child.stderr.on("data", (b: Buffer) => err.push(b));
		child.on("error", reject);
		// "close", not "exit": stdout may still hold unread output at "exit",
		// which would truncate the changed-file list and the tree digest.
		child.on("close", (code) => {
			if (code === 0) resolve(Buffer.concat(out));
			else reject(new Error(`${cmd} exited ${code}: ${Buffer.concat(err).toString("utf8").trim()}`));
		});
	});
}

function exitCode(command: string, cwd: string): Promise<{ passed: boolean; detail: string }> {
	return new Promise((resolve, reject) => {
		// Candidate code runs here: no service token, no Artifacts token, no
		// other operator credential, and no login profile re-imported.
		const child = spawn("bash", ["-c", command], {
			cwd,
			env: minimalEnv(),
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		let err = "";
		child.stdout.on("data", (b) => (out += b));
		child.stderr.on("data", (b) => (err += b));
		child.on("error", reject);
		child.on("close", (code) =>
			resolve({
				passed: code === 0,
				detail: [out.trim(), err.trim()].filter(Boolean).join("\n").slice(0, 4000),
			}),
		);
	});
}

async function postJson(url: string, body: unknown, auth = true): Promise<any> {
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (auth) headers.authorization = `Bearer ${serviceToken}`;
	const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(`POST ${url} -> ${res.status}: ${JSON.stringify(data)}`);
	return data;
}

async function treeDigestV1(repoDir: string, sha: string): Promise<string> {
	const raw = await capture("git", ["ls-tree", "-rz", "--full-tree", sha], repoDir);
	const records: Buffer[] = [];
	let start = 0;
	for (let i = 0; i <= raw.length; i++) {
		if (i !== raw.length && raw[i] !== 0) continue;
		if (i === start) {
			start = i + 1;
			continue;
		}
		const entry = raw.subarray(start, i);
		start = i + 1;
		const tab = entry.indexOf(0x09);
		if (tab < 0) throw new Error("tree-digest/v1: malformed ls-tree entry");
		const meta = entry.subarray(0, tab).toString("ascii").split(" ");
		if (meta.length !== 3) throw new Error("tree-digest/v1: malformed ls-tree metadata");
		const [mode, type, objectId] = meta;
		if (type !== "blob") throw new Error(`tree-digest/v1: unsupported non-blob entry ${type}`);
		const pathBytes = entry.subarray(tab + 1);
		const blob = await capture("git", ["cat-file", "blob", objectId], repoDir);
		const blobHash = createHash("sha256").update(blob).digest("hex");
		records.push(
			Buffer.from(mode, "ascii"),
			Buffer.from([0]),
			pathBytes,
			Buffer.from([0]),
			Buffer.from(blobHash, "ascii"),
			Buffer.from([0]),
		);
	}
	return createHash("sha256").update(Buffer.concat(records)).digest("hex");
}

/** Every blob and submodule entry of `sha`'s tree (`git ls-tree -r`). */
async function lsTree(repoDir: string, sha: string): Promise<TreeEntry[]> {
	const raw = (await capture("git", ["ls-tree", "-r", "-z", "--full-tree", sha], repoDir)).toString("utf8");
	return raw
		.split("\0")
		.filter(Boolean)
		.map((record) => {
			const tab = record.indexOf("\t");
			const [mode, type, oid] = record.slice(0, tab).split(" ");
			return { mode, type, oid, path: record.slice(tab + 1) };
		});
}

function gitSucceeds(args: string[], repoDir: string): Promise<boolean> {
	return new Promise((resolve) => {
		const child = spawn("git", args, { cwd: repoDir, env: minimalEnv(), stdio: "ignore" });
		child.on("error", () => resolve(false));
		child.on("exit", (code) => resolve(code === 0));
	});
}

/** The candidate's tool-status log, or why there is none to read. */
async function readToolStatusLog(repoDir: string, tree: TreeEntry[]): Promise<{ text: string } | { absent: string }> {
	const entry = tree.find((e) => e.path === TOOL_STATUS_LOG_PATH);
	if (!entry) return { absent: `no tool-status log at ${TOOL_STATUS_LOG_PATH}` };
	if (entry.type !== "blob" || entry.mode === "120000") {
		return { absent: `${TOOL_STATUS_LOG_PATH} is not a regular file` };
	}
	const size = Number((await capture("git", ["cat-file", "-s", entry.oid], repoDir)).toString("utf8").trim());
	if (!(size <= TOOL_STATUS_LOG_MAX_BYTES)) {
		return { absent: `${TOOL_STATUS_LOG_PATH} exceeds ${TOOL_STATUS_LOG_MAX_BYTES} bytes` };
	}
	return { text: (await capture("git", ["cat-file", "blob", entry.oid], repoDir)).toString("utf8") };
}

/** Refuse to create anything under `rel` whose existing parent inside `root` is a symlink. */
async function refuseSymlinkParents(root: string, rel: string): Promise<void> {
	let dir = root;
	for (const part of rel.split("/").slice(0, -1)) {
		dir = path.join(dir, part);
		const st = await lstat(dir).catch(() => null);
		if (st?.isSymbolicLink()) throw new Error(`run directory: ${rel} would be written through a symlink`);
	}
}

/**
 * Write the run directory: the composed tree's regular files, then the
 * hidden tests, then the tree's symlinks, so no file is written through a
 * symlink the candidate supplied.
 */
async function materialize(repoDir: string, runDir: string, files: RunFile[]): Promise<void> {
	for (const file of files) {
		if (file.mode === "120000") continue;
		const target = path.join(runDir, file.path);
		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(target, await capture("git", ["cat-file", "blob", file.oid], repoDir), {
			flag: "wx",
			mode: file.mode === "100755" ? 0o755 : 0o644,
		});
	}
	if (hiddenTestsDir !== undefined) {
		await cp(hiddenTestsDir, runDir, { recursive: true, force: true, dereference: true });
	}
	for (const file of files) {
		if (file.mode !== "120000") continue;
		await refuseSymlinkParents(runDir, file.path);
		const target = path.join(runDir, file.path);
		await mkdir(path.dirname(target), { recursive: true });
		await symlink((await capture("git", ["cat-file", "blob", file.oid], repoDir)).toString("utf8"), target);
	}
}

/**
 * Relative paths of the files under the hidden-tests directory, sorted,
 * following symlinks as the copy into the run directory does.
 */
async function hiddenTestPaths(): Promise<string[]> {
	if (hiddenTestsDir === undefined) return [];
	const root = hiddenTestsDir;
	const files: string[] = [];
	const walk = async (rel: string): Promise<void> => {
		for (const name of await readdir(path.join(root, rel))) {
			const child = rel === "" ? name : `${rel}/${name}`;
			if ((await stat(path.join(root, child))).isDirectory()) await walk(child);
			else files.push(child);
		}
	};
	await walk("");
	return files.sort();
}

/** SHA-256 over the hidden tests: each file's relative path with its content digest. */
async function hiddenTestsDigest(): Promise<string | null> {
	if (hiddenTestsDir === undefined) return null;
	const entries: Array<[string, string]> = [];
	for (const rel of await hiddenTestPaths()) {
		const content = await readFile(path.join(hiddenTestsDir, rel));
		entries.push([rel, createHash("sha256").update(content).digest("hex")]);
	}
	return sha256Hex(canonicalJson(entries));
}

function suiteResult(command: string, result: { passed: boolean; detail: string }) {
	return {
		passed: result.passed,
		total: 1,
		failed: result.passed ? [] : [`${command}: ${result.detail || "failed"}`],
	};
}

// Everything this evaluation runs under, fixed before any candidate is
// fetched (spec 3 §4.3). Its digest goes into the bundle (spec 1 §7).
const evaluationConfig = {
	format: "madgrix-evaluation-config/v1",
	commands: {
		hidden: hiddenCommand,
		regression: regressionCommand ?? null,
		semantic: semanticCommand ?? null,
		static: staticCommand ?? null,
		security: securityCommand ?? null,
	},
	test_globs: testGlobs,
	hidden_tests_sha256: await hiddenTestsDigest(),
	evaluator: harnessVersion,
	runtime: { node: process.version, platform: process.platform, arch: process.arch },
};
const evaluationConfigSha256 = await sha256Hex(canonicalJson(evaluationConfig));

const creds = await postJson(
	`${baseUrl}/tasks/${encodeURIComponent(taskId)}/evaluator-credentials`,
	{ contender_id: contenderId },
);
// The authority admits evidence only for the contender's latest observed
// commit (specs/amendments/evidence-integrity-v1.md): fail before evaluating.
if (creds.latest_commit !== candidateSha) {
	throw new Error(
		`candidate SHA is not the contender's latest observed commit: authority observed ` +
			`${creds.latest_commit ?? "no push"}, evaluator was given ${candidateSha}`,
	);
}
if (!creds.claim) throw new Error("candidate has no bound WorkClaim; scope gate must fail closed");

const dir = await mkdtemp(path.join(os.tmpdir(), "madgrix-eval-"));
// Outside the candidate checkout: the commands run here, never in `dir`.
const runDir = await mkdtemp(path.join(os.tmpdir(), "madgrix-run-"));
try {
	await new Promise<void>((resolve, reject) => {
		const child = spawn("git", ["clone", "--quiet", "--no-checkout", creds.remote, dir], {
			env: gitAuthEnv(creds.token),
			stdio: "inherit",
		});
		child.on("error", reject);
		child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`git clone failed: ${code}`))));
	});
	if (!(await gitSucceeds(["cat-file", "-e", `${candidateSha}^{commit}`], dir))) {
		throw new Error(`candidate commit ${candidateSha} is not in the contender repository`);
	}

	const baselineCommit: string = creds.baseline_commit;
	const baselineAvailable = await gitSucceeds(["cat-file", "-e", `${baselineCommit}^{commit}`], dir);
	const descendsFromBaseline =
		baselineAvailable && (await gitSucceeds(["merge-base", "--is-ancestor", baselineCommit, candidateSha], dir));
	// Everything read from the clone is read before any candidate code runs.
	const tree_sha256 = await treeDigestV1(dir, candidateSha);
	const candidateTree = await lsTree(dir, candidateSha);
	const baselineTree = baselineAvailable ? await lsTree(dir, baselineCommit) : [];
	const changed = changedPaths(baselineTree, candidateTree);
	const toolStatus = checkToolStatusLog(await readToolStatusLog(dir, candidateTree), {
		task_id: taskId,
		contender_id: contenderId,
		agent_id: typeof creds.agent_id === "string" ? creds.agent_id : null,
		baseline_commit: baselineCommit,
	});
	const gates = evaluatorGates({
		baselineAvailable,
		descendsFromBaseline,
		baselineCommit,
		changed,
		scope: Array.isArray(creds.claim.scope?.paths) ? creds.claim.scope.paths : null,
		testGlobs,
		toolStatus,
		forkLineage: creds.fork_lineage,
	});

	// Without the baseline there is no runner configuration or test material
	// to run the candidate against: nothing runs and every suite fails.
	const notRun = { passed: false, detail: `not run: baseline commit ${baselineCommit} is unavailable` };
	const run = (command: string) => (baselineAvailable ? exitCode(command, runDir) : Promise.resolve(notRun));
	const optional = (command: string | undefined) =>
		command ? run(command) : Promise.resolve({ passed: true, detail: "" });
	if (baselineAvailable) {
		const files = composeRunTree(baselineTree, candidateTree, testGlobs, await hiddenTestPaths());
		await materialize(dir, runDir, files);
	}
	const [hidden, regressions, semantic, staticCheck, security] = await Promise.all([
		run(hiddenCommand),
		run(regressionCommand!),
		optional(semanticCommand),
		optional(staticCommand),
		optional(securityCommand),
	]);

	const evaluated_at = new Date().toISOString();
	const withoutHash = {
		candidate_sha: candidateSha,
		tree_sha256,
		contender_id: contenderId,
		task_hash: creds.task_hash,
		admission: gates.admission,
		hidden_oracle: suiteResult(hiddenCommand, hidden),
		regressions: suiteResult(regressionCommand!, regressions),
		static_analysis: {
			passed: staticCheck.passed,
			findings: staticCheck.passed ? [] : [staticCheck.detail || "static analysis failed"],
		},
		semantic_checks: suiteResult(semanticCommand ?? "not-configured", semantic),
		security_policy: {
			passed: security.passed && gates.findings.length === 0,
			findings: [...(security.passed ? [] : [security.detail || "security command failed"]), ...gates.findings],
		},
		evaluated_at,
		tainted: false,
		evaluation_config_sha256: evaluationConfigSha256,
	};
	const bundle_hash = await sha256Hex(canonicalJson(withoutHash));
	const bundle = { ...withoutHash, bundle_hash };

	await postJson(`${baseUrl}/tasks/${encodeURIComponent(taskId)}/evidence`, { bundle });
	const result = {
		task_id: taskId,
		contender_id: contenderId,
		candidate_sha: candidateSha,
		tree_sha256,
		bundle_hash,
		changed_files: changed,
		bundle,
		evaluation_config: evaluationConfig,
		tool_status: { actions: toolStatus.actions, errors: toolStatus.errors },
		provenance: {
			agent_id: toolStatus.session?.agent_id ?? null,
			model: toolStatus.session?.model ?? null,
			harness: toolStatus.session?.harness ?? null,
			evaluator_harness_version: harnessVersion,
		},
	};
	if (process.env.MADGRIX_RESULT_PATH) {
		await writeFile(process.env.MADGRIX_RESULT_PATH, JSON.stringify(result, null, 2) + "\n", "utf8");
	}
	console.log(JSON.stringify(result, null, 2));
} finally {
	await rm(dir, { recursive: true, force: true });
	await rm(runDir, { recursive: true, force: true });
}
