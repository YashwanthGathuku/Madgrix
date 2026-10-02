#!/usr/bin/env node
/// <reference types="node" />
/**
 * MADGRIX live competition E2E.
 *
 * This is intentionally a real-infrastructure orchestrator. It does NOT use
 * FakeArtifacts. It fails if real Artifacts push events do not reach the
 * Worker/Queue/TaskAuthority path.
 *
 * Required environment:
 *   MADGRIX_BASE_URL
 *   MADGRIX_CONTROL_SERVICE_TOKEN
 *   MADGRIX_AGENT_SERVICE_TOKEN
 *   MADGRIX_EVALUATION_SERVICE_TOKEN
 *   MADGRIX_BASELINE_REPO
 *   MADGRIX_BASELINE_COMMIT
 *   MADGRIX_INTENT
 *   MADGRIX_BEHAVIOR_CONTRACT
 *   MADGRIX_AGENT_COMMAND
 *   MADGRIX_MODEL_NAME
 *   MADGRIX_HIDDEN_TEST_COMMAND
 *
 * Optional:
 *   MADGRIX_DESTINATION_REPO       default baseline repo
 *   MADGRIX_AGENT_IDS              default agent-a,agent-b,agent-c
 *   MADGRIX_EVENT_TIMEOUT_MS       default 60000
 *   MADGRIX_BUNDLE_PATH            default .madgrix-live/promotion.bundle
 *   MADGRIX_CLAIM_TEMPLATE         passed through to contender runner
 *   MADGRIX_AGENT_ENV_ALLOWLIST    variables passed through to the agent
 *                                  command (the agent's own model API key)
 *   MADGRIX_KEEP_WORKSPACES / MADGRIX_WORK_ROOT / GIT_AUTHOR_NAME /
 *   GIT_AUTHOR_EMAIL               passed through to contender runner
 *   MADGRIX_REGRESSION_COMMAND / SEMANTIC / STATIC / SECURITY commands
 *   MADGRIX_HARNESS_VERSION        passed through to the evaluator
 *
 * This process holds all three service tokens; no child inherits its
 * environment. The contender runner receives only the AGENT token, each
 * evaluator only the EVALUATION token, and the offline verifier none. See
 * docs/SECURITY.md "Process environment boundaries".
 */

import {
	createHash,
	generateKeyPairSync,
	randomBytes,
	sign as cryptoSign,
} from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { canonicalJson, sha256Hex } from "../src/lib/canonical.ts";
import { classifyPair } from "../src/lib/claims.ts";
import {
	buildLinkStatement,
	buildPromotionAuthority,
	buildTestResultStatement,
	buildVerificationResultStatement,
	signEnvelope,
	verifyBundle,
	type PromotionBundle,
} from "../src/lib/attestation.ts";
import { createEd25519Signer } from "../src/lib/signer-node.ts";
import { createCommitment } from "../src/lib/verifiers.ts";
import { verifierReportPayload } from "../src/lib/verifier-keys.ts";
import { SELECTOR_POLICY_INPUT } from "../src/do/TaskAuthority.ts";
import { SELECTOR_POLICY_VERSION, type ReferenceReport } from "../src/lib/types.ts";
import { minimalEnv, parseAgentEnvAllowlist, pickEnv } from "./lib/child-env.mjs";

const env = process.env;
const baseUrl = env.MADGRIX_BASE_URL?.replace(/\/$/, "");
const controlToken = env.MADGRIX_CONTROL_SERVICE_TOKEN;
const agentToken = env.MADGRIX_AGENT_SERVICE_TOKEN;
const evaluationToken = env.MADGRIX_EVALUATION_SERVICE_TOKEN;
const baselineRepo = env.MADGRIX_BASELINE_REPO;
const baselineCommit = env.MADGRIX_BASELINE_COMMIT;
const destinationRepo = env.MADGRIX_DESTINATION_REPO ?? baselineRepo;
const intent = env.MADGRIX_INTENT;
const behaviorContract = env.MADGRIX_BEHAVIOR_CONTRACT;
const agentCommand = env.MADGRIX_AGENT_COMMAND;
const modelName = env.MADGRIX_MODEL_NAME;
const hiddenCommand = env.MADGRIX_HIDDEN_TEST_COMMAND;
const eventTimeoutMs = Number(env.MADGRIX_EVENT_TIMEOUT_MS ?? "60000");
const bundlePath = path.resolve(env.MADGRIX_BUNDLE_PATH ?? ".madgrix-live/promotion.bundle");

const required: Record<string, unknown> = {
	MADGRIX_BASE_URL: baseUrl,
	MADGRIX_CONTROL_SERVICE_TOKEN: controlToken,
	MADGRIX_AGENT_SERVICE_TOKEN: agentToken,
	MADGRIX_EVALUATION_SERVICE_TOKEN: evaluationToken,
	MADGRIX_BASELINE_REPO: baselineRepo,
	MADGRIX_BASELINE_COMMIT: baselineCommit,
	MADGRIX_INTENT: intent,
	MADGRIX_BEHAVIOR_CONTRACT: behaviorContract,
	MADGRIX_AGENT_COMMAND: agentCommand,
	MADGRIX_MODEL_NAME: modelName,
	MADGRIX_HIDDEN_TEST_COMMAND: hiddenCommand,
};
const missing = Object.entries(required).filter(([, v]) => typeof v !== "string" || v.length === 0);
if (missing.length) {
	console.error("Missing required environment:", missing.map(([k]) => k).join(", "));
	process.exit(2);
}
let agentEnvAllowlist: string[];
try {
	agentEnvAllowlist = parseAgentEnvAllowlist(env.MADGRIX_AGENT_ENV_ALLOWLIST);
} catch (err) {
	console.error((err as Error).message);
	process.exit(2);
}

function bearer(token: string): Record<string, string> {
	return { authorization: `Bearer ${token}` };
}

async function requestJson(
	url: string,
	options: { method?: string; token?: string; body?: unknown } = {},
): Promise<any> {
	const headers: Record<string, string> = {};
	if (options.token) Object.assign(headers, bearer(options.token));
	if (options.body !== undefined) headers["content-type"] = "application/json";
	const res = await fetch(url, {
		method: options.method ?? (options.body === undefined ? "GET" : "POST"),
		headers,
		body: options.body === undefined ? undefined : JSON.stringify(options.body),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		throw new Error(`${options.method ?? "GET"} ${url} -> ${res.status}: ${JSON.stringify(data)}`);
	}
	return data;
}

function run(command: string, args: string[], options: { env?: NodeJS.ProcessEnv; stdio?: any } = {}): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			env: options.env ?? minimalEnv(),
			stdio: options.stdio ?? "inherit",
		});
		child.on("error", reject);
		child.on("exit", (code, signal) => {
			if (code === 0) resolve();
			else reject(new Error(`${command} exited ${code ?? signal}`));
		});
	});
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

interface VerifierIdentity {
	id: string;
	aspect: string;
	reference: ReferenceReport;
	nonce: string;
	publicKeyDerHex: string;
	keyid: string;
	privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"];
}

function makeVerifier(id: string, aspect: string): VerifierIdentity {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
	const publicKeyDerHex = publicKeyDer.toString("hex");
	const keyid = createHash("sha256").update(publicKeyDer).digest("hex");
	const reference: ReferenceReport = {
		expected_behavior: [behaviorContract as string],
		invariants: [
			"the candidate descends from the frozen baseline",
			"independent hidden and regression checks must pass",
			"integrity gates are non-compensatory",
		],
		likely_failure_modes:
			aspect === "security"
				? ["evaluation tampering", "credential boundary violation", "unsafe security regression"]
				: aspect === "minimality"
					? ["unnecessary change surface", "unrelated files changed", "behavioral overreach"]
					: ["boundary-condition failure", "regression", "specification mismatch"],
		evaluation_plan: [
			"inspect only anonymized evaluation evidence after commitment",
			"reject candidates failing mandatory gates",
			`judge the ${aspect} aspect independently`,
		],
		security_expectations: [
			"no canonical write authority in contender or evaluator zones",
			"no test/evaluator tampering",
		],
	};
	return {
		id,
		aspect,
		reference,
		nonce: randomBytes(32).toString("hex"),
		publicKeyDerHex,
		keyid,
		privateKey,
	};
}

const verifiers = [
	makeVerifier("verifier-correctness", "correctness"),
	makeVerifier("verifier-security", "security"),
	makeVerifier("verifier-minimality", "minimality"),
];

console.error("[madgrix-live] 1/9 freeze task and verifier identities");
const created = await requestJson(`${baseUrl}/tasks`, {
	token: controlToken,
	body: {
		intent,
		baseline_repo: baselineRepo,
		baseline_commit: baselineCommit,
		behavior_contract: behaviorContract,
		verifier_keys: verifiers.map((v) => ({
			verifier_id: v.id,
			public_key_der_hex: v.publicKeyDerHex,
		})),
	},
});
const taskId = created.task_id as string;
const taskHash = created.task_hash as string;
if (!taskId || !taskHash) throw new Error("task creation returned no task identity");

console.error("[madgrix-live] 2/9 commit blind-verifier references before candidates exist");
for (const v of verifiers) {
	const commitment = await createCommitment(
		v.reference,
		v.nonce,
		taskHash,
		v.id,
		SELECTOR_POLICY_VERSION,
		sha256Hex,
	);
	await requestJson(`${baseUrl}/tasks/${encodeURIComponent(taskId)}/verifiers/commit`, {
		token: controlToken,
		body: {
			commitment: {
				verifier_id: v.id,
				task_hash: taskHash,
				policy_version: SELECTOR_POLICY_VERSION,
				commitment,
				committed_at: new Date().toISOString(),
			},
		},
	});
}

const temp = await mkdtemp(path.join(os.tmpdir(), "madgrix-live-"));
try {
	console.error("[madgrix-live] 3/9 launch real coding agents concurrently");
	const contenderResultPath = path.join(temp, "contenders.json");
	// Agent zone: the AGENT token only. The runner forwards the allowlisted
	// variables, and nothing else, to the agent command.
	await run("node", ["scripts/run-contenders.mjs"], {
		env: minimalEnv({
			...pickEnv(agentEnvAllowlist),
			MADGRIX_BASE_URL: baseUrl,
			MADGRIX_TASK_ID: taskId,
			MADGRIX_AGENT_SERVICE_TOKEN: agentToken,
			MADGRIX_AGENT_COMMAND: agentCommand,
			MADGRIX_AGENT_IDS: env.MADGRIX_AGENT_IDS,
			MADGRIX_AGENT_ENV_ALLOWLIST: env.MADGRIX_AGENT_ENV_ALLOWLIST,
			MADGRIX_CLAIM_TEMPLATE: env.MADGRIX_CLAIM_TEMPLATE,
			MADGRIX_KEEP_WORKSPACES: env.MADGRIX_KEEP_WORKSPACES,
			MADGRIX_WORK_ROOT: env.MADGRIX_WORK_ROOT,
			GIT_AUTHOR_NAME: env.GIT_AUTHOR_NAME,
			GIT_AUTHOR_EMAIL: env.GIT_AUTHOR_EMAIL,
			MADGRIX_RESULT_PATH: contenderResultPath,
		}),
	});
	const contenderRun = JSON.parse(await readFile(contenderResultPath, "utf8"));
	const candidates = contenderRun.candidates as Array<{
		agent_id: string;
		contender_id: string;
		claim_work_id: string;
		conflicts: any[];
		fork_repo: string;
		candidate_sha: string;
		baseline_sha: string;
	}>;
	if (!Array.isArray(candidates) || candidates.length < 2) {
		throw new Error("real contender run produced fewer than two candidates");
	}

	console.error("[madgrix-live] 4/9 wait for real Artifacts push events through Queue → TaskAuthority");
	const deadline = Date.now() + eventTimeoutMs;
	for (;;) {
		const context = await requestJson(`${baseUrl}/tasks/${encodeURIComponent(taskId)}/context`, {
			token: agentToken,
		});
		const byId = new Map((context.contenders ?? []).map((x: any) => [x.contender_id, x]));
		const allObserved = candidates.every((c) => byId.get(c.contender_id)?.latest_commit === c.candidate_sha);
		if (allObserved) break;
		if (Date.now() >= deadline) {
			throw new Error(
				"timed out waiting for Artifact push events. Configure a cf.artifacts.repo.pushed " +
					"subscription for the MADGRIX namespace/queue before running the live demo.",
			);
		}
		await sleep(1000);
	}

	console.error("[madgrix-live] 5/9 evaluate immutable candidates in the independent evaluation domain");
	const evalResults = await Promise.all(
		candidates.map(async (candidate, i) => {
			const resultPath = path.join(temp, `evaluation-${i}.json`);
			// Evaluation domain: the EVALUATION token only.
			await run("node", ["scripts/evaluate-candidate.ts"], {
				env: minimalEnv({
					MADGRIX_BASE_URL: baseUrl,
					MADGRIX_TASK_ID: taskId,
					MADGRIX_CONTENDER_ID: candidate.contender_id,
					MADGRIX_CANDIDATE_SHA: candidate.candidate_sha,
					MADGRIX_EVALUATION_SERVICE_TOKEN: evaluationToken,
					MADGRIX_MODEL_NAME: modelName,
					MADGRIX_HIDDEN_TEST_COMMAND: hiddenCommand,
					MADGRIX_REGRESSION_COMMAND: env.MADGRIX_REGRESSION_COMMAND,
					MADGRIX_SEMANTIC_COMMAND: env.MADGRIX_SEMANTIC_COMMAND,
					MADGRIX_STATIC_COMMAND: env.MADGRIX_STATIC_COMMAND,
					MADGRIX_SECURITY_COMMAND: env.MADGRIX_SECURITY_COMMAND,
					MADGRIX_HARNESS_VERSION: env.MADGRIX_HARNESS_VERSION,
					MADGRIX_RESULT_PATH: resultPath,
				}),
			});
			return JSON.parse(await readFile(resultPath, "utf8"));
		}),
	);

	console.error("[madgrix-live] 6/9 reveal blind references and submit signed independent verdicts");
	await requestJson(`${baseUrl}/tasks/${encodeURIComponent(taskId)}/verifiers/labels`, {
		token: controlToken,
		body: { candidate_shas: candidates.map((c) => c.candidate_sha) },
	});
	for (const v of verifiers) {
		await requestJson(`${baseUrl}/tasks/${encodeURIComponent(taskId)}/verifiers/reveal`, {
			token: controlToken,
			body: { verifier_id: v.id, report: v.reference, nonce: v.nonce },
		});
	}

	// Verifiers see anonymized evidence. Choose the candidate with all mandatory
	// measured gates passing, then minimal observed change surface. This is a
	// deterministic demo verifier policy, not an LLM authority.
	const eligible = evalResults
		.map((r, i) => ({ r, i }))
		.filter(({ r }) => {
			const b = r.bundle;
			return (
				Object.values(b.admission).every(Boolean) &&
				b.hidden_oracle.passed &&
				b.regressions.passed &&
				b.static_analysis.passed &&
				b.security_policy.passed
			);
		})
		.sort((a, b) => a.r.changed_files.length - b.r.changed_files.length);
	if (eligible.length === 0) throw new Error("no candidate passed the independent mandatory evaluation gates");
	const verifierChoiceIndex = eligible[0].i;
	const chosenLabel = `candidate-${verifierChoiceIndex}`;

	for (const v of verifiers) {
		const unsigned = {
			verifier_id: v.id,
			candidate_label: chosenLabel,
			verdict: "accept" as const,
			reasons: [
				`${v.aspect}: mandatory independent evidence passed`,
				"reference report was committed before any candidate was exposed",
			],
			keyid: v.keyid,
		};
		const payload = Buffer.from(verifierReportPayload(unsigned), "utf8");
		const signature = cryptoSign(null, payload, v.privateKey).toString("base64");
		await requestJson(`${baseUrl}/tasks/${encodeURIComponent(taskId)}/verifiers/report`, {
			token: controlToken,
			body: { report: { ...unsigned, signature } },
		});
	}

	const finalContext = await requestJson(`${baseUrl}/tasks/${encodeURIComponent(taskId)}/context`, {
		token: controlToken,
	});
	const claimsById = new Map((finalContext.claims ?? []).map((x: any) => [x.work_id, x]));
	const riskWeight: Record<string, number> = { GREEN: 0, AMBER: 1, RED: 2, BLOCKED: 100 };
	const ranked = candidates.map((candidate, i) => {
		const claim = claimsById.get(candidate.claim_work_id) as any;
		const others = (finalContext.claims ?? []).filter((x: any) => x.work_id !== candidate.claim_work_id);
		const blast_radius = claim
			? Math.max(0, ...others.map((x: any) => riskWeight[classifyPair(claim, x).risk] ?? 0))
			: 100;
		return {
			contender_id: candidate.contender_id,
			candidate_sha: candidate.candidate_sha,
			tree_sha256: evalResults[i].bundle.tree_sha256,
			bundle: evalResults[i].bundle,
			blast_radius,
			change_surface: evalResults[i].changed_files.length,
		};
	});

	console.error("[madgrix-live] 7/9 execute Verdict Seam and issue exact-state permit");
	const verdictResponse = await requestJson(`${baseUrl}/tasks/${encodeURIComponent(taskId)}/verdict`, {
		token: controlToken,
		body: { candidates: ranked, destination_repo: destinationRepo },
	});
	if (verdictResponse.verdict?.state !== "ACCEPT" || !verdictResponse.permit) {
		throw new Error(`Verdict Seam did not ACCEPT: ${JSON.stringify(verdictResponse.verdict)}`);
	}
	const permit = verdictResponse.permit;
	const winnerIndex = candidates.findIndex((c) => c.candidate_sha === verdictResponse.verdict.winner_sha);
	if (winnerIndex < 0) throw new Error("verdict winner is not in the contender set");
	const winner = candidates[winnerIndex];
	const winnerEval = evalResults[winnerIndex];

	console.error("[madgrix-live] 8/9 promote the exact reviewed commit to canonical Artifacts state");
	const promotion = await requestJson(`${baseUrl}/tasks/${encodeURIComponent(taskId)}/promote`, {
		token: controlToken,
		body: { permit_id: permit.permit_id },
	});
	if (promotion.outcome !== "PROMOTED" || promotion.promoted_sha !== winner.candidate_sha) {
		throw new Error(`exact-state promotion failed: ${JSON.stringify(promotion)}`);
	}

	console.error("[madgrix-live] 9/9 build signed evidence bundle and verify it offline");
	const policyHash = await sha256Hex(SELECTOR_POLICY_INPUT);
	const testConfigDigest = await sha256Hex(
		canonicalJson({
			hidden: hiddenCommand,
			regression: env.MADGRIX_REGRESSION_COMMAND ?? hiddenCommand,
			semantic: env.MADGRIX_SEMANTIC_COMMAND ?? null,
			static: env.MADGRIX_STATIC_COMMAND ?? null,
			security: env.MADGRIX_SECURITY_COMMAND ?? null,
		}),
	);
	const link = await buildLinkStatement({
		baselineCommit: baselineCommit as string,
		candidateCommit: winner.candidate_sha,
		treeSha256: winnerEval.bundle.tree_sha256,
	});
	const testResult = await buildTestResultStatement({
		treeSha256: winnerEval.bundle.tree_sha256,
		candidateCommit: winner.candidate_sha,
		testConfigDigest,
		result:
			winnerEval.bundle.hidden_oracle.passed && winnerEval.bundle.regressions.passed ? "PASS" : "FAIL",
	});
	const verificationResult = await buildVerificationResultStatement({
		treeSha256: winnerEval.bundle.tree_sha256,
		candidateCommit: winner.candidate_sha,
		policySha256: policyHash,
		result: "PASSED",
	});
	const authority = await buildPromotionAuthority({
		taskHash,
		baselineCommit: baselineCommit as string,
		candidateRepo: winner.fork_repo,
		candidateCommit: winner.candidate_sha,
		treeSha256: winnerEval.bundle.tree_sha256,
		evaluationBundleHash: winnerEval.bundle.bundle_hash,
		verificationResult: "PASSED",
		policySha256: policyHash,
		destinationRepo: destinationRepo as string,
		expectedParent: permit.expected_destination_head,
		nonce: permit.nonce,
		permitId: permit.permit_id,
		issuedAt: permit.issued_at,
	});
	const authoritySigner = createEd25519Signer();
	const statements = [];
	for (const statement of [link, testResult, verificationResult, authority]) {
		statements.push(await signEnvelope(statement, authoritySigner));
	}
	const bundle: PromotionBundle = {
		version: 1,
		statements,
		ship: {
			repo: destinationRepo as string,
			commit: winner.candidate_sha,
			tree_sha256: winnerEval.bundle.tree_sha256,
			parent: permit.expected_destination_head,
			permit_id: permit.permit_id,
		},
		ledger_hashes: [permit.permit_id],
		authority_pubkey_der_hex: authoritySigner.publicKeyDerHex,
	};
	const verified = await verifyBundle(bundle, authoritySigner, { policyHash });
	if (!verified.verified) throw new Error(`new promotion bundle failed self-verification: ${JSON.stringify(verified.lines)}`);
	await mkdir(path.dirname(bundlePath), { recursive: true });
	await writeFile(bundlePath, JSON.stringify(bundle, null, 2) + "\n", "utf8");
	// Offline verification needs no credential.
	await run("node", ["src/cli/verify.ts", bundlePath], { env: minimalEnv() });

	console.log(
		JSON.stringify(
			{
				status: "MADGRIX_LIVE_E2E_OK",
				task_id: taskId,
				concurrent_agents: candidates.length,
				winner: winner.candidate_sha,
				promoted_sha: promotion.promoted_sha,
				permit_id: permit.permit_id,
				bundle: bundlePath,
			},
			null,
			2,
		),
	);
} finally {
	await rm(temp, { recursive: true, force: true });
}
