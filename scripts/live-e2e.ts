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
 *   MADGRIX_AGENT_COMMAND          must write the agent's tool-status log
 *                                  (specs/amendments/tool-status-v1.md)
 *   MADGRIX_HIDDEN_TEST_COMMAND
 *   MADGRIX_CLAIM_PATHS            the claim's scope.paths, passed to the
 *                                  contender runner (or MADGRIX_CLAIM_TEMPLATE)
 *
 * Optional:
 *   MADGRIX_DESTINATION_REPO       default baseline repo
 *   MADGRIX_QUEUE_ID               queue that receives per-repo `pushed` subscriptions
 *   MADGRIX_ARTIFACTS_NAMESPACE    default `default`
 *   MADGRIX_AGENT_IDS              overrides the Agentfleet roster; otherwise
 *                                  summary.agent_ids from fleet validate of
 *                                  configs/git4agents-contenders.yaml
 *   MADGRIX_FLEET_BIN              fleet executable (default: fleet on PATH)
 *   MADGRIX_FLEET_CONFIG           swarm manifest (default: that yaml)
 *   MADGRIX_EVENT_TIMEOUT_MS       default 60000
 *   MADGRIX_PROMOTION_TIMEOUT_MS   how long to poll the promotion's Workflow
 *                                  instance; default 900000 (15 minutes)
 *   MADGRIX_BUNDLE_PATH            default .madgrix-live/promotion.bundle
 *   MADGRIX_CLAIM_TEMPLATE         passed through to contender runner
 *   MADGRIX_AGENT_ENV_ALLOWLIST    variables passed through to the agent
 *                                  command (the agent's own model API key)
 *   MADGRIX_KEEP_WORKSPACES / MADGRIX_WORK_ROOT / GIT_AUTHOR_NAME /
 *   GIT_AUTHOR_EMAIL               passed through to contender runner
 *   MADGRIX_REGRESSION_COMMAND / SEMANTIC / STATIC / SECURITY commands
 *   MADGRIX_HIDDEN_TESTS_DIR / MADGRIX_TEST_GLOBS / MADGRIX_HARNESS_VERSION
 *                                  passed through to the evaluator
 *   MADGRIX_TRUST_KEY              authority public key file pinned when
 *                                  verifying the bundle (default
 *                                  keys/authority.pub)
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
	type KeyObject,
} from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import { sha256Hex } from "../src/lib/canonical.ts";
import { classifyPair } from "../src/lib/claims.ts";
import { createCommitment } from "../src/lib/verifiers.ts";
import { verifierReportPayload } from "../src/lib/verifier-keys.ts";
import { SELECTOR_POLICY_VERSION, type ReferenceReport } from "../src/lib/types.ts";
import { loadContenderIds } from "./lib/agentfleet-slots.mjs";
import { crewAgentIds, loadForkCrew } from "./lib/fork-crew.mjs";
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
const hiddenCommand = env.MADGRIX_HIDDEN_TEST_COMMAND;
const eventTimeoutMs = Number(env.MADGRIX_EVENT_TIMEOUT_MS ?? "60000");
const promotionTimeoutMs = Number(env.MADGRIX_PROMOTION_TIMEOUT_MS ?? "900000");
/** Between two polls of the promotion's status. */
const PROMOTION_POLL_MS = 2000;
const bundlePath = path.resolve(env.MADGRIX_BUNDLE_PATH ?? ".madgrix-live/promotion.bundle");

if (!env.MADGRIX_CLAIM_PATHS && !env.MADGRIX_CLAIM_TEMPLATE) {
	console.error("Missing required environment: MADGRIX_CLAIM_PATHS (or MADGRIX_CLAIM_TEMPLATE)");
	process.exit(2);
}
let agentEnvAllowlist: string[];
try {
	agentEnvAllowlist = parseAgentEnvAllowlist(env.MADGRIX_AGENT_ENV_ALLOWLIST);
} catch (err) {
	console.error((err as Error).message);
	process.exit(2);
}
// Unset MADGRIX_AGENT_IDS is the fork-crew demo: one parent fork, sub-agents
// on that repo. An explicit roster keeps the sibling race the isolation tests
// drive.
const forkCrew = !env.MADGRIX_AGENT_IDS?.trim();
const required: Record<string, unknown> = {
	MADGRIX_BASE_URL: baseUrl,
	MADGRIX_CONTROL_SERVICE_TOKEN: controlToken,
	MADGRIX_AGENT_SERVICE_TOKEN: agentToken,
	MADGRIX_EVALUATION_SERVICE_TOKEN: evaluationToken,
	MADGRIX_BASELINE_REPO: baselineRepo,
	MADGRIX_BASELINE_COMMIT: baselineCommit,
	MADGRIX_INTENT: intent,
	MADGRIX_BEHAVIOR_CONTRACT: behaviorContract,
	MADGRIX_HIDDEN_TEST_COMMAND: hiddenCommand,
	...(forkCrew ? {} : { MADGRIX_AGENT_COMMAND: agentCommand }),
};
const missing = Object.entries(required).filter(([, v]) => typeof v !== "string" || v.length === 0);
if (missing.length) {
	console.error("Missing required environment:", missing.map(([k]) => k).join(", "));
	process.exit(2);
}
let agentIds: string[];
try {
	agentIds = forkCrew ? crewAgentIds(loadForkCrew(env.MADGRIX_FORK_CREW_CONFIG)) : loadContenderIds();
} catch (err) {
	console.error((err as Error).message);
	process.exit(2);
}

function bearer(token: string): Record<string, string> {
	return { authorization: `Bearer ${token}` };
}

/** Posts the runner's composition with the control token. The runner never sees that token. */
async function recordForkComposition(run: { composition?: unknown }): Promise<void> {
	if (!run.composition || typeof run.composition !== "object") {
		throw new Error("fork crew result has no composition record for the control plane");
	}
	await requestJson(`${baseUrl}/tasks/${encodeURIComponent(taskId)}/composition`, {
		token: controlToken,
		body: { composition: run.composition },
	});
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
	privateKey: KeyObject;
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

console.error("[Git4agents] 1/9 freeze task and verifier identities");
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
		// One secret per agent, issued to the control plane only
		// (specs/amendments/agent-enrollment-v1.md).
		agent_ids: agentIds,
	},
});
const taskId = created.task_id as string;
const taskHash = created.task_hash as string;
const agentSecrets = created.agent_secrets as Record<string, string> | undefined;
if (!agentSecrets || !agentIds.every((id) => typeof agentSecrets[id] === "string")) {
	throw new Error("task creation returned no secret for some enrolled agent");
}
if (!taskId || !taskHash) throw new Error("task creation returned no task identity");

console.error("[Git4agents] 2/9 commit blind-verifier references before candidates exist");
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
	console.error(
		forkCrew
			? "[Git4agents] 3/9 parent forks once; sub-agents commit on that fork"
			: "[Git4agents] 3/9 launch real coding agents concurrently",
	);
	const contenderResultPath = path.join(temp, "contenders.json");
	// Agent zone: the AGENT token only. The runner forwards the allowlisted
	// variables, and nothing else, to the agent command.
	const childEnv = {
		...pickEnv(agentEnvAllowlist),
		MADGRIX_BASE_URL: baseUrl,
		MADGRIX_TASK_ID: taskId,
		MADGRIX_AGENT_SERVICE_TOKEN: agentToken,
		MADGRIX_AGENT_SECRETS: JSON.stringify(agentSecrets),
		MADGRIX_AGENT_ENV_ALLOWLIST: env.MADGRIX_AGENT_ENV_ALLOWLIST,
		MADGRIX_CLAIM_PATHS: env.MADGRIX_CLAIM_PATHS,
		MADGRIX_CLAIM_TEMPLATE: env.MADGRIX_CLAIM_TEMPLATE,
		MADGRIX_KEEP_WORKSPACES: env.MADGRIX_KEEP_WORKSPACES,
		MADGRIX_WORK_ROOT: env.MADGRIX_WORK_ROOT,
		GIT_AUTHOR_NAME: env.GIT_AUTHOR_NAME,
		GIT_AUTHOR_EMAIL: env.GIT_AUTHOR_EMAIL,
		MADGRIX_RESULT_PATH: contenderResultPath,
		MADGRIX_QUEUE_ID: env.MADGRIX_QUEUE_ID,
		MADGRIX_ARTIFACTS_NAMESPACE: env.MADGRIX_ARTIFACTS_NAMESPACE,
		MADGRIX_FLEET_BIN: env.MADGRIX_FLEET_BIN,
		MADGRIX_FLEET_CONFIG: env.MADGRIX_FLEET_CONFIG,
		MADGRIX_FORK_CREW_CONFIG: env.MADGRIX_FORK_CREW_CONFIG,
		MADGRIX_RESOLVER_COMMAND: env.MADGRIX_RESOLVER_COMMAND,
	};
	try {
		await run("node", [forkCrew ? "scripts/run-fork-crew.mjs" : "scripts/run-contenders.mjs"], {
			env: minimalEnv(
				forkCrew
					? childEnv
					: {
							...childEnv,
							MADGRIX_AGENT_COMMAND: agentCommand,
							MADGRIX_AGENT_IDS: agentIds.join(","),
						},
			),
		});
	} catch (err) {
		if (forkCrew) {
			const blocked = await readFile(contenderResultPath, "utf8").catch(() => "");
			let parsed: { status?: string; composition?: unknown } | null = null;
			try {
				parsed = JSON.parse(blocked);
			} catch {
				parsed = null;
			}
			if (parsed?.status === "CONFLICTED") {
				await recordForkComposition(parsed);
				throw new Error(
					`fork crew is CONFLICTED and was not pushed. The control plane recorded the conflict. Refusing evaluation and promotion. ${err instanceof Error ? err.message : ""}`,
				);
			}
		}
		throw err;
	}
	const contenderRun = JSON.parse(await readFile(contenderResultPath, "utf8"));
	if (forkCrew) {
		if (contenderRun.status === "CONFLICTED") {
			await recordForkComposition(contenderRun);
			throw new Error("fork crew is CONFLICTED. The control plane recorded the conflict. Refusing evaluation and promotion.");
		}
		await recordForkComposition(contenderRun);
	}
	const candidates = contenderRun.candidates as Array<{
		agent_id: string;
		contender_id: string;
		claim_work_id: string;
		conflicts: any[];
		fork_repo: string;
		candidate_sha: string;
		baseline_sha: string;
	}>;
	if (forkCrew) {
		const subs = contenderRun.subagent_commits as unknown[];
		if (candidates.length !== 1 || !Array.isArray(subs) || subs.length < 2) {
			throw new Error("fork crew did not produce one combined SHA from at least two sub-agent commits");
		}
	} else if (!Array.isArray(candidates) || candidates.length < 2) {
		throw new Error("real contender run produced fewer than two candidates");
	}

	console.error("[Git4agents] 4/9 wait for real Artifacts push events through Queue → TaskAuthority");
	const deadline = Date.now() + eventTimeoutMs;
	for (;;) {
		const context = await requestJson(`${baseUrl}/tasks/${encodeURIComponent(taskId)}/context`, {
			token: agentToken,
		});
		const byId = new Map<string, { latest_commit?: string | null }>(
			(context.contenders ?? []).map((x: { contender_id: string; latest_commit?: string | null }) => [x.contender_id, x]),
		);
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

	console.error("[Git4agents] 5/9 evaluate immutable candidates in the independent evaluation domain");
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
					MADGRIX_HIDDEN_TEST_COMMAND: hiddenCommand,
					MADGRIX_REGRESSION_COMMAND: env.MADGRIX_REGRESSION_COMMAND,
					MADGRIX_SEMANTIC_COMMAND: env.MADGRIX_SEMANTIC_COMMAND,
					MADGRIX_STATIC_COMMAND: env.MADGRIX_STATIC_COMMAND,
					MADGRIX_SECURITY_COMMAND: env.MADGRIX_SECURITY_COMMAND,
					MADGRIX_HIDDEN_TESTS_DIR: env.MADGRIX_HIDDEN_TESTS_DIR,
					MADGRIX_TEST_GLOBS: env.MADGRIX_TEST_GLOBS,
					MADGRIX_HARNESS_VERSION: env.MADGRIX_HARNESS_VERSION,
					MADGRIX_RESULT_PATH: resultPath,
				}),
			});
			return JSON.parse(await readFile(resultPath, "utf8"));
		}),
	);

	console.error("[Git4agents] 6/9 reveal blind references and submit signed independent verdicts");
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

	console.error("[Git4agents] 7/9 execute Verdict Seam and issue exact-state permit");
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

	console.error("[Git4agents] 8/9 promote the exact reviewed commit to canonical Artifacts state");
	// POST /promote starts the permit's PromotionWorkflow instance (202); the
	// promotion's answer is the instance's result once it is complete.
	const started = await requestJson(`${baseUrl}/tasks/${encodeURIComponent(taskId)}/promote`, {
		token: controlToken,
		body: { permit_id: permit.permit_id },
	});
	if (started.instance_id !== permit.permit_id || typeof started.status_url !== "string") {
		throw new Error(`POST /promote did not start the permit's promotion: ${JSON.stringify(started)}`);
	}
	const promotionDeadline = Date.now() + promotionTimeoutMs;
	let instance = started;
	for (;;) {
		instance = await requestJson(`${baseUrl}${started.status_url}`, { token: controlToken });
		if (instance.status !== "queued" && instance.status !== "running" && instance.status !== "waiting") break;
		if (Date.now() >= promotionDeadline) {
			throw new Error(`promotion still ${instance.status} after ${promotionTimeoutMs} ms: ${JSON.stringify(instance)}`);
		}
		await sleep(PROMOTION_POLL_MS);
	}
	const promotion = instance.result?.body ?? {};
	if (
		instance.status !== "complete" ||
		instance.result?.status !== 200 ||
		promotion.outcome !== "PROMOTED" ||
		promotion.promoted_sha !== winner.candidate_sha
	) {
		throw new Error(`exact-state promotion failed: ${JSON.stringify(instance)}`);
	}

	console.error("[Git4agents] 9/9 fetch the authority-signed bundle and verify it offline");
	// The TaskAuthority signed the ship record at /promotion/finalize from its
	// own state (amendment authority-signing-v1); nothing is built locally.
	const bundle = await requestJson(
		`${baseUrl}/tasks/${encodeURIComponent(taskId)}/bundle?permit_id=${encodeURIComponent(permit.permit_id)}`,
		{ token: controlToken },
	);
	if (bundle?.ship?.permit_id !== permit.permit_id || bundle?.ship?.commit !== promotion.promoted_sha) {
		throw new Error("the Worker's promotion bundle does not describe this promotion");
	}
	await mkdir(path.dirname(bundlePath), { recursive: true });
	await writeFile(bundlePath, JSON.stringify(bundle, null, 2) + "\n", "utf8");
	// Offline verification needs no credential. Trust comes from the pinned
	// authority key (MADGRIX_TRUST_KEY, else keys/authority.pub), never from
	// the key embedded in the bundle.
	const trustKeyArgs = env.MADGRIX_TRUST_KEY ? ["--trust-key", path.resolve(env.MADGRIX_TRUST_KEY)] : [];
	await run("node", ["src/cli/verify.ts", ...trustKeyArgs, bundlePath], { env: minimalEnv() });

	console.log(
		JSON.stringify(
			{
				name: "Git4agents",
				status: "MADGRIX_LIVE_E2E_OK",
				public_url: baseUrl,
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
