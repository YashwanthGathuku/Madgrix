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
 *   MADGRIX_MODEL_NAME
 *
 * Evaluation commands:
 *   MADGRIX_HIDDEN_TEST_COMMAND      required
 *   MADGRIX_REGRESSION_COMMAND       default = hidden command
 *   MADGRIX_SEMANTIC_COMMAND         optional (pass when absent)
 *   MADGRIX_STATIC_COMMAND           optional (pass when absent)
 *   MADGRIX_SECURITY_COMMAND         optional (pass when absent)
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
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { canonicalJson, sha256Hex } from "../src/lib/canonical.ts";
import { globMatchesPath } from "../src/lib/claims.ts";
import { minimalEnv } from "./lib/child-env.mjs";

const baseUrl = process.env.MADGRIX_BASE_URL?.replace(/\/$/, "");
const taskId = process.env.MADGRIX_TASK_ID;
const contenderId = process.env.MADGRIX_CONTENDER_ID;
const candidateSha = process.env.MADGRIX_CANDIDATE_SHA;
const serviceToken = process.env.MADGRIX_EVALUATION_SERVICE_TOKEN;
const modelName = process.env.MADGRIX_MODEL_NAME;
const hiddenCommand = process.env.MADGRIX_HIDDEN_TEST_COMMAND;
const regressionCommand = process.env.MADGRIX_REGRESSION_COMMAND ?? hiddenCommand;
const semanticCommand = process.env.MADGRIX_SEMANTIC_COMMAND;
const staticCommand = process.env.MADGRIX_STATIC_COMMAND;
const securityCommand = process.env.MADGRIX_SECURITY_COMMAND;
const harnessVersion = process.env.MADGRIX_HARNESS_VERSION ?? "madgrix-evaluator/0.1.0";

if (!baseUrl || !taskId || !contenderId || !candidateSha || !serviceToken || !modelName || !hiddenCommand) {
	console.error(
		"Missing required MADGRIX_* variables. Need BASE_URL, TASK_ID, CONTENDER_ID, " +
			"CANDIDATE_SHA, EVALUATION_SERVICE_TOKEN, MODEL_NAME, HIDDEN_TEST_COMMAND.",
	);
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

async function changedFiles(repoDir: string, baseline: string, candidate: string): Promise<string[]> {
	const raw = await capture("git", ["diff", "--name-only", "-z", baseline, candidate], repoDir);
	return raw
		.toString("utf8")
		.split("\0")
		.filter(Boolean);
}

async function isAncestor(repoDir: string, baseline: string, candidate: string): Promise<boolean> {
	return new Promise((resolve) => {
		const child = spawn("git", ["merge-base", "--is-ancestor", baseline, candidate], {
			cwd: repoDir,
			env: minimalEnv(),
			stdio: "ignore",
		});
		child.on("error", () => resolve(false));
		child.on("exit", (code) => resolve(code === 0));
	});
}

function suiteResult(command: string, result: { passed: boolean; detail: string }) {
	return {
		passed: result.passed,
		total: 1,
		failed: result.passed ? [] : [`${command}: ${result.detail || "failed"}`],
	};
}

const creds = await postJson(
	`${baseUrl}/tasks/${encodeURIComponent(taskId)}/evaluator-credentials`,
	{ contender_id: contenderId },
);
if (creds.latest_commit && creds.latest_commit !== candidateSha) {
	throw new Error(
		`candidate SHA is stale: authority observed ${creds.latest_commit}, evaluator was given ${candidateSha}`,
	);
}
if (!creds.claim) throw new Error("candidate has no bound WorkClaim; scope gate must fail closed");

const dir = await mkdtemp(path.join(os.tmpdir(), "madgrix-eval-"));
try {
	const authHeader = `Authorization: Bearer ${creds.token}`;
	await new Promise<void>((resolve, reject) => {
		const child = spawn(
			"git",
			["-c", `http.extraHeader=${authHeader}`, "clone", "--quiet", "--no-checkout", creds.remote, dir],
			{ env: minimalEnv(), stdio: "inherit" },
		);
		child.on("error", reject);
		child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`git clone failed: ${code}`))));
	});
	await capture("git", ["checkout", "--detach", candidateSha], dir);

	const exactBaseline = await isAncestor(dir, creds.baseline_commit, candidateSha);
	const files = await changedFiles(dir, creds.baseline_commit, candidateSha);
	const scopeCompliance = files.every((file) =>
		(creds.claim.scope?.paths ?? []).some((glob: string) => globMatchesPath(glob, file)),
	);
	const testTamper = files.some((file) => /(^|\/)(__tests__|tests?|spec)(\/|$)/i.test(file));

	const [hidden, regressions, semantic, staticCheck, security] = await Promise.all([
		exitCode(hiddenCommand, dir),
		exitCode(regressionCommand!, dir),
		semanticCommand ? exitCode(semanticCommand, dir) : Promise.resolve({ passed: true, detail: "" }),
		staticCommand ? exitCode(staticCommand, dir) : Promise.resolve({ passed: true, detail: "" }),
		securityCommand ? exitCode(securityCommand, dir) : Promise.resolve({ passed: true, detail: "" }),
	]);

	const tree_sha256 = await treeDigestV1(dir, candidateSha);
	const evaluated_at = new Date().toISOString();
	const withoutHash = {
		candidate_sha: candidateSha,
		tree_sha256,
		contender_id: contenderId,
		task_hash: creds.task_hash,
		admission: {
			exact_baseline: exactBaseline,
			scope_compliance: scopeCompliance,
			// This receipt is mechanical: the evaluator fetched the exact immutable
			// candidate through an authenticated read-only repo credential.
			valid_tool_states: true,
			no_eval_tampering: !testTamper,
			provenance_complete: Boolean(modelName && harnessVersion),
		},
		hidden_oracle: suiteResult(hiddenCommand, hidden),
		regressions: suiteResult(regressionCommand!, regressions),
		static_analysis: {
			passed: staticCheck.passed,
			findings: staticCheck.passed ? [] : [staticCheck.detail || "static analysis failed"],
		},
		semantic_checks: suiteResult(semanticCommand ?? "not-configured", semantic),
		security_policy: {
			passed: security.passed && !testTamper,
			findings: [
				...(security.passed ? [] : [security.detail || "security command failed"]),
				...(testTamper ? ["candidate modified test/spec material relative to the frozen baseline"] : []),
			],
		},
		evaluated_at,
		tainted: false,
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
		changed_files: files,
		bundle,
		provenance: { model: modelName, harness_version: harnessVersion },
	};
	if (process.env.MADGRIX_RESULT_PATH) {
		const { writeFile } = await import("node:fs/promises");
		await writeFile(process.env.MADGRIX_RESULT_PATH, JSON.stringify(result, null, 2) + "\n", "utf8");
	}
	console.log(JSON.stringify(result, null, 2));
} finally {
	await rm(dir, { recursive: true, force: true });
}
