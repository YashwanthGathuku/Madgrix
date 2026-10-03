/**
 * Process-environment boundaries of the live-run scripts (spec 3 §2.1 zone
 * table and §5 credential matrix; specs/amendments/process-env-boundaries.md).
 *
 * The operator shell that drives a live run typically holds every MADGRIX
 * zone credential at once (control, agent and evaluation service tokens)
 * plus Cloudflare and other operator secrets. These tests run the real
 * scripts as child processes against a local HTTP mock of the Worker and
 * local bare Git repos (no network, no Cloudflare) with all of those in the
 * parent environment. Every untrusted command (the coding-agent command and
 * the hidden/regression/semantic/static/security commands) writes `env` to
 * a file, and no dump may carry a credential.
 *
 * The operator HOME used here has a login profile that exports a secret, so
 * a login shell (`bash -l`) re-importing the profile also counts as a leak.
 * The mock admits each route only with its own zone's service token, so a
 * script calling the Worker with another zone's token fails the run, and
 * admits /contenders only with the agent secret its /claim returned, as the
 * Worker does (specs/amendments/contender-agent-binding.md).
 *
 * node --test test/env-isolation.test.ts
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadAuthoritySigner, type AuthoritySigner } from "../src/lib/authority-key.ts";
import { sha256Hex } from "../src/lib/canonical.ts";
import { buildPermitId } from "../src/lib/permit.ts";
import { appendLedger, createAuthority, recordPromotionBundle, type Ctx } from "../src/lib/task-state.ts";
import { SELECTOR_POLICY_VERSION } from "../src/lib/types.ts";
import { SELECTOR_POLICY_INPUT } from "../src/do/TaskAuthority.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** No variable whose NAME matches this may reach an untrusted command. */
const CREDENTIAL_NAME = /SERVICE_TOKEN|CLOUDFLARE|API_TOKEN|SECRET/;

type Zone = "control" | "agent" | "evaluation";

const ZONE_TOKEN_VARS: Record<Zone, string> = {
	control: "MADGRIX_CONTROL_SERVICE_TOKEN",
	agent: "MADGRIX_AGENT_SERVICE_TOKEN",
	evaluation: "MADGRIX_EVALUATION_SERVICE_TOKEN",
};

/** Fake credentials of the kind an operator shell holds. None is real. */
const OPERATOR_SECRETS: Record<string, string> = {
	MADGRIX_CONTROL_SERVICE_TOKEN: "fake-control-zone-token-6d1c",
	MADGRIX_AGENT_SERVICE_TOKEN: "fake-agent-zone-token-2b7e",
	MADGRIX_EVALUATION_SERVICE_TOKEN: "fake-evaluation-zone-token-9f40",
	CLOUDFLARE_API_TOKEN: "fake-cloudflare-api-token-51aa",
	CLOUDFLARE_ACCOUNT_ID: "fake-cloudflare-account-0c3e",
	GITHUB_API_TOKEN: "fake-github-api-token-77d2",
	OPERATOR_SIGNING_SECRET: "fake-operator-signing-secret-e83f",
};
/** Exported by the operator's login profile rather than the parent env. */
const PROFILE_SECRET = { name: "PROFILE_EXPORTED_SECRET", value: "fake-profile-secret-3a9b" };
/** The agent's own model credential: reaches the agent only via the allowlist. */
const MODEL_KEY = { name: "MODEL_PROVIDER_API_KEY", value: "fake-model-provider-key-c4d1" };

/** minimalEnv() base: the only inherited variables any child may see. */
const BASE_VARS = ["PATH", "HOME", "LANG", "TMPDIR", "TERM"];
/** Set by bash/sh for themselves when they run `env`; not inherited. */
const SHELL_VARS = ["PWD", "OLDPWD", "SHLVL", "_"];
const AGENT_VARS = [
	"MADGRIX_AGENT_ID",
	"MADGRIX_CONTENDER_ID",
	"MADGRIX_TASK_ID",
	"MADGRIX_BASELINE_SHA",
	"MADGRIX_WORKSPACE",
];
const EVAL_COMMAND_VARS: Record<string, string> = {
	hidden: "MADGRIX_HIDDEN_TEST_COMMAND",
	regression: "MADGRIX_REGRESSION_COMMAND",
	semantic: "MADGRIX_SEMANTIC_COMMAND",
	static: "MADGRIX_STATIC_COMMAND",
	security: "MADGRIX_SECURITY_COMMAND",
};

const fx = {} as {
	root: string;
	home: string;
	tmp: string;
	dumps: string;
	forks: string;
	seed: string;
	baselineSha: string;
	mock: Mock;
	/** The mock Worker's AUTHORITY_SIGNING_KEY signer, and its public key file. */
	authority: AuthoritySigner;
	trustKeyPath: string;
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

/** tree-digest/v1 (specs/amendments/tree-digest-v1.md) of top-level 100644 files. */
function treeDigestV1(files: Record<string, string>): string {
	const sha256 = (data: string) => createHash("sha256").update(data).digest("hex");
	return sha256(
		Object.keys(files)
			.sort()
			.map((name) => `100644\0${name}\0${sha256(files[name])}\0`)
			.join(""),
	);
}

/** The parent environment of a live run: every credential at once. */
function operatorEnv(extra: Record<string, string> = {}): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: fx.home,
		LANG: "C.UTF-8",
		TERM: "dumb",
		TMPDIR: fx.tmp,
		OPERATOR_SHELL_NOISE: "not-a-credential-and-not-allowlisted",
		[MODEL_KEY.name]: MODEL_KEY.value,
		...OPERATOR_SECRETS,
		...extra,
	};
}

/** printf format of the agent's tool-status log (specs/amendments/tool-status-v1.md). */
const TOOL_LOG_FORMAT =
	'{"format":"madgrix-tool-status/v1","task_id":"%s","contender_id":"%s","agent_id":"%s","baseline_commit":"%s",' +
	'"model":"test-model","harness":"env-isolation-agent/1"}\\n{"seq":1,"action":"write_file","tool_status":"OK"}\\n';

/** The claim scope every contender run here registers. */
const CLAIM_PATHS = "CANDIDATE.txt";

/** Agent command: dump the environment, make the change the runner commits, and log that one action. */
function agentCommand(dumpDir: string): string {
	return (
		`env > ${shq(dumpDir)}/agent-"$MADGRIX_AGENT_ID".env && echo "candidate from $MADGRIX_AGENT_ID" > CANDIDATE.txt && ` +
		`mkdir -p .madgrix && printf ${shq(TOOL_LOG_FORMAT)} "$MADGRIX_TASK_ID" "$MADGRIX_CONTENDER_ID" ` +
		`"$MADGRIX_AGENT_ID" "$MADGRIX_BASELINE_SHA" > .madgrix/tool-status.jsonl`
	);
}

/** One `env` dump per evaluation command and per run ($$ = that shell's pid). */
function evaluationCommands(dumpDir: string): Record<string, string> {
	return Object.fromEntries(
		Object.entries(EVAL_COMMAND_VARS).map(([kind, name]) => [name, `env > ${shq(dumpDir)}/eval-${kind}."$$".env`]),
	);
}

interface Dump {
	text: string;
	vars: Map<string, string>;
}

async function readDump(file: string): Promise<Dump> {
	const text = await readFile(file, "utf8");
	const vars = new Map<string, string>();
	for (const line of text.split("\n")) {
		const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
		if (m) vars.set(m[1], m[2]);
	}
	return { text, vars };
}

/** Read every dump in `dir` whose file name matches `pattern`. */
async function readDumps(dir: string, pattern: RegExp): Promise<Array<{ file: string; dump: Dump }>> {
	const files = (await readdir(dir)).filter((f) => pattern.test(f)).sort();
	return Promise.all(files.map(async (file) => ({ file, dump: await readDump(path.join(dir, file)) })));
}

/**
 * The dump holds no credential-named variable except `ownZone`'s service
 * token, and no other credential value under any name.
 */
function assertCredentials(
	label: string,
	dump: Dump,
	ownZone?: Zone,
	extraSecrets: string[] = [],
	alsoAllowed: string[] = [],
): void {
	const own = [...(ownZone ? [ZONE_TOKEN_VARS[ownZone]] : []), ...alsoAllowed].sort();
	assert.deepEqual(
		[...dump.vars.keys()].filter((name) => CREDENTIAL_NAME.test(name)).sort(),
		own,
		`${label}: credential-named variables in its environment`,
	);
	const foreign: Array<[string, string]> = [
		...Object.entries(OPERATOR_SECRETS).filter(([name]) => !own.includes(name)),
		[PROFILE_SECRET.name, PROFILE_SECRET.value],
		...extraSecrets.map((value): [string, string] => ["issued Artifacts token or agent secret", value]),
	];
	assert.deepEqual(
		foreign.filter(([, value]) => dump.text.includes(value)).map(([name]) => name),
		[],
		`${label}: credential values present under some variable name`,
	);
}

/** The dump holds minimalEnv() base variables plus exactly `extras`. */
function assertOnly(label: string, dump: Dump, extras: string[]): void {
	const permitted = new Set([...BASE_VARS, ...SHELL_VARS, ...extras]);
	assert.deepEqual(
		[...dump.vars.keys()].filter((name) => !permitted.has(name)).sort(),
		[],
		`${label}: variables outside minimalEnv() and its explicit extras`,
	);
}

interface RunResult {
	code: number | null;
	stdout: string;
	stderr: string;
}

function runScript(script: string, env: Record<string, string>): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [script], { cwd: REPO_ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (b) => (stdout += b));
		child.stderr.on("data", (b) => (stderr += b));
		child.on("error", reject);
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	});
}

/* ------------------------------------------------------------------ */
/* Local mock of the MADGRIX Worker                                     */
/* ------------------------------------------------------------------ */

interface Contender {
	id: string;
	taskId: string;
	agentId: string;
	bare: string;
}

interface Mock {
	url: string;
	requests: Array<{ route: string; zone: Zone | null }>;
	issuedCredentials: string[];
	createContender(taskId: string, agentId: string): Contender;
	/** Enroll agents in a task as POST /tasks does; returns their secrets. */
	enroll(taskId: string, agentIds: string[]): Record<string, string>;
	close(): Promise<void>;
}

/**
 * The zone(s) whose service token each route admits. Stricter than the
 * Worker, which also admits CONTROL on claim/contenders: here each route
 * admits only the zone of the script that should be calling it.
 */
const ROUTE_ZONES: Record<string, Zone[]> = {
	"POST /tasks": ["control"],
	"POST verifiers/commit": ["control"],
	"POST verifiers/labels": ["control"],
	"POST verifiers/reveal": ["control"],
	"POST verifiers/report": ["control"],
	"POST verdict": ["control"],
	"POST promote": ["control"],
	"GET bundle": ["control"],
	"GET context": ["agent", "control"],
	"POST claim": ["agent"],
	"POST contenders": ["agent"],
	"POST evaluator-credentials": ["evaluation"],
	"POST evidence": ["evaluation"],
};

interface MockPromotion {
	permit: Record<string, any>;
	evaluation: Record<string, any>;
	contenderId: string;
}

/** A permit whose id recomputes from its bound fields, as the TaskAuthority issues it. */
async function issueMockPermit(taskId: string, taskHashValue: string, chosen: any): Promise<MockPromotion> {
	const bound = {
		task_hash: taskHashValue,
		baseline_commit: fx.baselineSha,
		winning_tree_sha256: chosen.tree_sha256,
		evaluation_bundle_hash: chosen.bundle.bundle_hash,
		selector_policy_hash: await sha256Hex(SELECTOR_POLICY_INPUT),
		expected_destination_head: fx.baselineSha,
	};
	const permit = {
		...bound,
		permit_id: await buildPermitId(bound, sha256Hex),
		winner_candidate_sha: chosen.candidate_sha,
		contender_id: chosen.contender_id,
		destination_repo: "madgrix/env-isolation",
		nonce: randomBytes(32).toString("hex"),
		issued_at: new Date().toISOString(),
		consumed: false,
		consumed_at: null,
	};
	return { permit, evaluation: chosen.bundle, contenderId: chosen.contender_id };
}

/** The ship record, signed by the code the TaskAuthority runs at /promotion/finalize. */
async function mockSignedBundle(taskId: string, p: MockPromotion, promotedSha: string) {
	const ctx: Ctx = {
		now: () => new Date().toISOString(),
		randomHex: (n: number) => randomBytes(n).toString("hex"),
		sha256Hex,
		selectorPolicyHash: p.permit.selector_policy_hash,
		policyVersion: SELECTOR_POLICY_VERSION,
	};
	let state = createAuthority({
		task_id: taskId,
		task_hash: p.permit.task_hash,
		intent: "keep every credential inside its own zone",
		baseline_repo: "madgrix/env-isolation",
		baseline_commit: p.permit.baseline_commit,
		behavior_contract: "",
		policy_version: SELECTOR_POLICY_VERSION,
		frozen_at: ctx.now(),
	});
	state = {
		...state,
		permits: { [p.permit.permit_id]: { ...p.permit, consumed: true, consumed_at: ctx.now() } as never },
		evaluations: { [p.permit.winner_candidate_sha]: p.evaluation as never },
		contenders: { [p.contenderId]: { contender_id: p.contenderId, fork_repo: `fork-${p.contenderId}` } as never },
		verdicts: [{ state: "ACCEPT", winner_sha: p.permit.winner_candidate_sha } as never],
	};
	state = await appendLedger(
		state,
		"promotion_succeeded",
		{ permit_id: p.permit.permit_id, tree_sha256: p.permit.winning_tree_sha256 },
		ctx,
	);
	return (await recordPromotionBundle(state, p.permit.permit_id, promotedSha, fx.authority, ctx)).bundle;
}

async function startMock(): Promise<Mock> {
	const contenders = new Map<string, Contender>();
	const taskHashes = new Map<string, string>();
	const requests: Mock["requests"] = [];
	const issuedCredentials: string[] = [];
	/** SHA-256(agent secret) -> agent, as the authority enrolls it at task creation. */
	const agentSecrets = new Map<string, string>();
	/** task id -> agent -> SHA-256(agent secret). */
	const enrollment = new Map<string, Map<string, string>>();
	const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
	const enroll = (taskId: string, agentIds: string[]): Record<string, string> => {
		const secrets: Record<string, string> = {};
		const hashes = new Map<string, string>();
		for (const agent of agentIds) {
			secrets[agent] = randomBytes(32).toString("hex");
			hashes.set(agent, sha256(secrets[agent]));
			agentSecrets.set(sha256(secrets[agent]), agent);
			issuedCredentials.push(secrets[agent]);
		}
		enrollment.set(taskId, hashes);
		return secrets;
	};
	let seq = 0;
	let winner = "";
	let promotion: MockPromotion | null = null;

	const createContender = (taskId: string, agentId: string): Contender => {
		const id = `contender-${++seq}`;
		const bare = path.join(fx.forks, `${id}.git`);
		git(fx.root, "clone", "--quiet", "--bare", fx.seed, bare);
		const contender = { id, taskId, agentId, bare };
		contenders.set(id, contender);
		return contender;
	};
	const head = (c: Contender) => git(c.bare, "rev-parse", "refs/heads/main");
	const taskHash = (taskId: string) => taskHashes.get(taskId) ?? "f".repeat(64);

	const server = createServer(async (req, res) => {
		const send = (status: number, data: unknown) => {
			res.writeHead(status, { "content-type": "application/json" });
			res.end(JSON.stringify(data));
		};
		try {
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(chunk as Buffer);
			const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
			const { pathname } = new URL(req.url ?? "/", "http://mock.invalid");
			const match = /^\/tasks\/([^/]+)\/(.+)$/.exec(pathname);
			const taskId = match?.[1] ?? "";
			const route = pathname === "/tasks" ? `${req.method} /tasks` : `${req.method} ${match?.[2]}`;
			const zone =
				(Object.keys(ZONE_TOKEN_VARS) as Zone[]).find(
					(z) => req.headers.authorization === `Bearer ${OPERATOR_SECRETS[ZONE_TOKEN_VARS[z]]}`,
				) ?? null;
			requests.push({ route, zone });
			const admitted = ROUTE_ZONES[route];
			if (!admitted) return send(404, { error: `no route ${route}` });
			if (!zone || !admitted.includes(zone)) return send(403, { error: `${route} refuses zone ${zone}` });

			switch (route) {
				case "POST /tasks": {
					const id = `task_${randomBytes(12).toString("hex")}`;
					taskHashes.set(id, randomBytes(32).toString("hex"));
					if (!Array.isArray(body.agent_ids) || body.agent_ids.length === 0) {
						return send(400, { error: "agent_ids_required" });
					}
					return send(200, { task_id: id, task_hash: taskHashes.get(id), agent_secrets: enroll(id, body.agent_ids) });
				}
				case "GET context":
					return send(200, {
						task: {
							task_id: taskId,
							task_hash: taskHash(taskId),
							baseline_commit: fx.baselineSha,
							intent: "keep every credential inside its own zone",
						},
						contenders: [...contenders.values()]
							.filter((c) => c.taskId === taskId)
							.map((c) => ({ contender_id: c.id, agent_id: c.agentId, latest_commit: head(c) })),
						claims: [],
					});
				case "POST claim": {
					// Every claim presents the secret the agent was enrolled with.
					const presented = req.headers["x-madgrix-agent-secret"];
					const enrolled = enrollment.get(taskId)?.get(body.claim?.agent);
					if (enrolled === undefined) return send(403, { error: "agent_not_enrolled" });
					if (typeof presented !== "string" || sha256(presented) !== enrolled) {
						return send(403, { error: "agent_secret_invalid" });
					}
					return send(200, { work_id: `work-${++seq}`, conflicts: [] });
				}
				case "POST contenders": {
					const presented = req.headers["x-madgrix-agent-secret"];
					const agent =
						typeof presented === "string"
							? agentSecrets.get(createHash("sha256").update(presented).digest("hex"))
							: undefined;
					if (agent === undefined) return send(401, { error: "agent_secret_required" });
					if (body.agent_id !== undefined && body.agent_id !== agent) return send(403, { error: "agent_id_mismatch" });
					const c = createContender(taskId, agent);
					const token = `fake-fork-write-token-${c.id}`;
					issuedCredentials.push(token);
					return send(200, { contender_id: c.id, remote: c.bare, token, fork_repo: `fork-${c.id}` });
				}
				case "POST evaluator-credentials": {
					const c = contenders.get(body.contender_id);
					if (!c) return send(404, { error: "unknown contender" });
					const token = `fake-fork-read-token-${c.id}-${++seq}`;
					issuedCredentials.push(token);
					return send(200, {
						token,
						remote: c.bare,
						baseline_commit: fx.baselineSha,
						task_hash: taskHash(taskId),
						claim: { agent: c.agentId, scope: { paths: CLAIM_PATHS.split(","), symbols: [] } },
						latest_commit: head(c),
						agent_id: c.agentId,
						fork_lineage: { parent_repo: "madgrix/env-isolation", parent_commit: fx.baselineSha },
					});
				}
				case "POST verdict": {
					const chosen = body.candidates?.[0];
					winner = chosen?.candidate_sha ?? "";
					promotion = await issueMockPermit(taskId, taskHash(taskId), chosen);
					return send(200, { verdict: { state: "ACCEPT", winner_sha: winner }, permit: promotion.permit });
				}
				case "POST promote":
					return send(200, { outcome: "PROMOTED", promoted_sha: winner });
				case "GET bundle":
					if (!promotion) return send(404, { error: "bundle_not_found" });
					return send(200, await mockSignedBundle(taskId, promotion, winner));
				default:
					// evidence and verifier commit/labels/reveal/report
					return send(200, { ok: true });
			}
		} catch (err) {
			send(500, { error: String(err) });
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		requests,
		issuedCredentials,
		createContender,
		enroll,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

/* ------------------------------------------------------------------ */

describe("process environment boundaries of the live-run scripts", () => {
	before(async () => {
		fx.root = await mkdtemp(path.join(os.tmpdir(), "madgrix-env-isolation-"));
		fx.home = path.join(fx.root, "home");
		fx.tmp = path.join(fx.root, "tmp");
		fx.dumps = path.join(fx.root, "dumps");
		fx.forks = path.join(fx.root, "forks");
		fx.seed = path.join(fx.root, "seed");
		for (const dir of [fx.home, fx.tmp, fx.dumps, fx.forks, fx.seed]) await mkdir(dir, { recursive: true });
		await writeFile(path.join(fx.home, ".profile"), `export ${PROFILE_SECRET.name}=${PROFILE_SECRET.value}\n`);
		git(fx.seed, "init", "--quiet", "--initial-branch=main");
		await writeFile(path.join(fx.seed, "README.md"), "baseline\n");
		git(fx.seed, "add", "-A");
		git(fx.seed, "commit", "--quiet", "-m", "baseline");
		fx.baselineSha = git(fx.seed, "rev-parse", "HEAD");
		const authorityKey = generateKeyPairSync("ed25519");
		fx.authority = await loadAuthoritySigner(authorityKey.privateKey.export({ type: "pkcs8", format: "pem" }).toString());
		fx.trustKeyPath = path.join(fx.root, "authority.pub");
		await writeFile(fx.trustKeyPath, authorityKey.publicKey.export({ type: "spki", format: "pem" }).toString());
		fx.mock = await startMock();
	});

	after(async () => {
		await fx.mock?.close();
		if (fx.root) await rm(fx.root, { recursive: true, force: true });
	});

	it("run-contenders.mjs: the agent command gets no credential, only its five MADGRIX_* variables", async () => {
		const dumpDir = await mkdtemp(path.join(fx.dumps, "contenders-"));
		const taskId = `task_${"a".repeat(24)}`;
		const resultPath = path.join(dumpDir, "result.json");
		const run = await runScript(
			"scripts/run-contenders.mjs",
			operatorEnv({
				MADGRIX_BASE_URL: fx.mock.url,
				MADGRIX_TASK_ID: taskId,
				MADGRIX_AGENT_IDS: "agent-a,agent-b",
				MADGRIX_AGENT_SECRETS: JSON.stringify(fx.mock.enroll(taskId, ["agent-a", "agent-b"])),
				MADGRIX_AGENT_COMMAND: agentCommand(dumpDir),
				MADGRIX_CLAIM_PATHS: CLAIM_PATHS,
				MADGRIX_RESULT_PATH: resultPath,
			}),
		);
		assert.equal(run.code, 0, `run-contenders failed:\n${run.stderr}`);
		const result = JSON.parse(await readFile(resultPath, "utf8"));
		assert.equal(result.candidates.length, 2);

		for (const candidate of result.candidates) {
			assert.equal(
				candidate.candidate_sha,
				git(path.join(fx.forks, `${candidate.contender_id}.git`), "rev-parse", "refs/heads/main"),
				`${candidate.agent_id}: reported SHA is the pushed commit`,
			);
			const label = `agent command (${candidate.agent_id})`;
			const dump = await readDump(path.join(dumpDir, `agent-${candidate.agent_id}.env`));
			assertCredentials(label, dump, undefined, fx.mock.issuedCredentials);
			assertOnly(label, dump, AGENT_VARS);
			assert.equal(dump.vars.get("MADGRIX_AGENT_ID"), candidate.agent_id);
			assert.equal(dump.vars.get("MADGRIX_CONTENDER_ID"), candidate.contender_id);
			assert.equal(dump.vars.get("MADGRIX_TASK_ID"), taskId);
			assert.equal(dump.vars.get("MADGRIX_BASELINE_SHA"), fx.baselineSha);
			assert.ok(dump.vars.get("MADGRIX_WORKSPACE"), `${label}: MADGRIX_WORKSPACE is set`);
		}
	});

	it("run-contenders.mjs: MADGRIX_AGENT_ENV_ALLOWLIST passes the agent's own model key and nothing else", async () => {
		const dumpDir = await mkdtemp(path.join(fx.dumps, "allowlist-"));
		const run = await runScript(
			"scripts/run-contenders.mjs",
			operatorEnv({
				MADGRIX_BASE_URL: fx.mock.url,
				MADGRIX_TASK_ID: `task_${"b".repeat(24)}`,
				MADGRIX_AGENT_IDS: "agent-a,agent-b",
				MADGRIX_AGENT_SECRETS: JSON.stringify(fx.mock.enroll(`task_${"b".repeat(24)}`, ["agent-a", "agent-b"])),
				MADGRIX_AGENT_COMMAND: agentCommand(dumpDir),
				MADGRIX_CLAIM_PATHS: CLAIM_PATHS,
				MADGRIX_AGENT_ENV_ALLOWLIST: ` ${MODEL_KEY.name} ,UNSET_BY_OPERATOR`,
			}),
		);
		assert.equal(run.code, 0, `run-contenders failed:\n${run.stderr}`);
		for (const agentId of ["agent-a", "agent-b"]) {
			const label = `agent command (${agentId})`;
			const dump = await readDump(path.join(dumpDir, `agent-${agentId}.env`));
			assertCredentials(label, dump, undefined, fx.mock.issuedCredentials);
			assertOnly(label, dump, [...AGENT_VARS, MODEL_KEY.name]);
			assert.equal(dump.vars.get(MODEL_KEY.name), MODEL_KEY.value);
		}
	});

	it("run-contenders.mjs and live-e2e.ts refuse an allowlist naming a zone or Cloudflare credential", async () => {
		const dumpDir = await mkdtemp(path.join(fx.dumps, "refused-"));
		const refused = [
			{ entry: "MADGRIX_CONTROL_SERVICE_TOKEN", reported: "MADGRIX_CONTROL_SERVICE_TOKEN" },
			{ entry: "CLOUDFLARE_API_TOKEN", reported: "CLOUDFLARE_API_TOKEN" },
			{ entry: "CF_API_TOKEN", reported: "CF_API_TOKEN" },
			{ entry: "OTHER_SERVICE_TOKEN", reported: "OTHER_SERVICE_TOKEN" },
			// NAME=value instead of NAME: refused without echoing the value.
			{ entry: `${MODEL_KEY.name}=${MODEL_KEY.value}`, reported: "entry 2" },
		];
		for (const { entry, reported } of refused) {
			const before = fx.mock.requests.length;
			const run = await runScript(
				"scripts/run-contenders.mjs",
				operatorEnv({
					MADGRIX_BASE_URL: fx.mock.url,
					MADGRIX_TASK_ID: `task_${"c".repeat(24)}`,
					MADGRIX_AGENT_COMMAND: agentCommand(dumpDir),
					MADGRIX_CLAIM_PATHS: CLAIM_PATHS,
					MADGRIX_AGENT_ENV_ALLOWLIST: `${MODEL_KEY.name},${entry}`,
				}),
			);
			assert.equal(run.code, 2, `run-contenders must refuse allowlist ${reported}`);
			assert.ok(run.stderr.includes(reported), `refusal names ${reported}`);
			assert.ok(!run.stderr.includes(MODEL_KEY.value), "a refusal never echoes a credential value");
			assert.equal(fx.mock.requests.length, before, `${reported}: refused before any Worker call`);
		}

		const before = fx.mock.requests.length;
		const live = await runScript(
			"scripts/live-e2e.ts",
			operatorEnv({
				MADGRIX_BASE_URL: fx.mock.url,
				MADGRIX_BASELINE_REPO: "madgrix/env-isolation",
				MADGRIX_BASELINE_COMMIT: fx.baselineSha,
				MADGRIX_INTENT: "refuse a dangerous allowlist",
				MADGRIX_BEHAVIOR_CONTRACT: "no zone credential reaches the agent",
				MADGRIX_AGENT_COMMAND: agentCommand(dumpDir),
				MADGRIX_CLAIM_PATHS: CLAIM_PATHS,
				MADGRIX_HIDDEN_TEST_COMMAND: "true",
				MADGRIX_BUNDLE_PATH: path.join(dumpDir, "never.bundle"),
				MADGRIX_AGENT_ENV_ALLOWLIST: "MADGRIX_EVALUATION_SERVICE_TOKEN",
			}),
		);
		assert.equal(live.code, 2, "live-e2e must refuse an allowlist naming a zone credential");
		assert.match(live.stderr, /MADGRIX_EVALUATION_SERVICE_TOKEN/);
		assert.equal(fx.mock.requests.length, before, "live-e2e refused before creating a task");
		assert.deepEqual(await readdir(dumpDir), [], "no agent command ran");
	});

	it("Artifacts tokens reach git through its environment, never its command line", async () => {
		// A `git` shim first on PATH records the argv and environment of every
		// git process the runner and the evaluator start. Another local user
		// can read a process's argv (/proc/<pid>/cmdline); its environment only
		// the same user can.
		const dumpDir = await mkdtemp(path.join(fx.dumps, "git-"));
		const shimDir = path.join(dumpDir, "bin");
		await mkdir(shimDir);
		const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
		await writeFile(
			path.join(shimDir, "git"),
			`#!/bin/sh\nd=${shq(dumpDir)}/call.$$\nmkdir -p "$d"\nfor a in "$@"; do printf '%s\\n' "$a"; done > "$d/argv"\nenv > "$d/env"\nexec ${shq(realGit)} "$@"\n`,
		);
		await chmod(path.join(shimDir, "git"), 0o755);
		const withShim = { PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ""}` };

		const taskId = `task_${"g".repeat(24)}`;
		const resultPath = path.join(dumpDir, "contenders.json");
		const contenders = await runScript(
			"scripts/run-contenders.mjs",
			operatorEnv({
				...withShim,
				MADGRIX_BASE_URL: fx.mock.url,
				MADGRIX_TASK_ID: taskId,
				MADGRIX_AGENT_IDS: "agent-a,agent-b",
				MADGRIX_AGENT_SECRETS: JSON.stringify(fx.mock.enroll(taskId, ["agent-a", "agent-b"])),
				MADGRIX_AGENT_COMMAND: agentCommand(dumpDir),
				MADGRIX_CLAIM_PATHS: CLAIM_PATHS,
				MADGRIX_RESULT_PATH: resultPath,
			}),
		);
		assert.equal(contenders.code, 0, `run-contenders failed:\n${contenders.stderr}`);
		const candidate = JSON.parse(await readFile(resultPath, "utf8")).candidates[0];
		const evaluation = await runScript(
			"scripts/evaluate-candidate.ts",
			operatorEnv({
				...withShim,
				MADGRIX_BASE_URL: fx.mock.url,
				MADGRIX_TASK_ID: taskId,
				MADGRIX_CONTENDER_ID: candidate.contender_id,
				MADGRIX_CANDIDATE_SHA: candidate.candidate_sha,
				MADGRIX_HIDDEN_TEST_COMMAND: "true",
			}),
		);
		assert.equal(evaluation.code, 0, `evaluate-candidate failed:\n${evaluation.stderr}`);

		const calls = await Promise.all(
			(await readdir(dumpDir)).filter((f) => f.startsWith("call.")).map(async (f) => ({
				argv: (await readFile(path.join(dumpDir, f, "argv"), "utf8")).split("\n").filter(Boolean),
				env: (await readDump(path.join(dumpDir, f, "env"))).vars,
			})),
		);
		const tokens = fx.mock.issuedCredentials.filter((c) => c.startsWith("fake-fork-"));
		assert.deepEqual(
			calls.flatMap(({ argv }) => argv.filter((arg) => tokens.some((token) => arg.includes(token)))),
			[],
			"no git argument carries an Artifacts token",
		);
		const authenticated = (env: Map<string, string>) =>
			Array.from({ length: Number(env.get("GIT_CONFIG_COUNT") ?? 0) }, (_, i) => i).some(
				(i) =>
					env.get(`GIT_CONFIG_KEY_${i}`) === "http.extraHeader" &&
					tokens.some((token) => env.get(`GIT_CONFIG_VALUE_${i}`) === `Authorization: Bearer ${token}`),
			);
		const network = calls.filter(({ argv }) => argv.includes("clone") || argv.includes("push"));
		assert.equal(network.length, 5, "two clones and two pushes by the runner, one clone by the evaluator");
		for (const { argv, env } of network) {
			assert.ok(authenticated(env), `git ${argv.join(" ")}: the token reaches git as http.extraHeader in its environment`);
		}
		for (const { argv, env } of calls.filter((call) => !network.includes(call))) {
			assert.ok(!authenticated(env), `git ${argv.join(" ")}: no token for a local git command`);
		}
	});

	it("a Claude Code agent piped through the tool-status adapter passes valid_tool_states and provenance_complete", async () => {
		// A fake `claude` stands in for `claude -p ... --output-format stream-json
		// --verbose`: it makes the change and prints the message shapes Claude
		// Code 2.1.42 emits. No model is called.
		const dumpDir = await mkdtemp(path.join(fx.dumps, "claude-"));
		const binDir = path.join(dumpDir, "bin");
		await mkdir(binDir);
		const stream = [
			{ type: "system", subtype: "init", session_id: "s", tools: ["Write"], model: "claude-fake-model-1", claude_code_version: "2.1.42", uuid: "u0" },
			{ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Write", input: { file_path: "CANDIDATE.txt" } }] }, parent_tool_use_id: null, session_id: "s", uuid: "u1" },
			{ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] }, parent_tool_use_id: null, session_id: "s", uuid: "u2" },
			{ type: "result", subtype: "success", is_error: false, num_turns: 1, session_id: "s" },
		];
		await writeFile(
			path.join(binDir, "claude"),
			`#!/bin/sh\necho "candidate from $MADGRIX_AGENT_ID" > CANDIDATE.txt\ncat <<'JSON'\n${stream.map((m) => JSON.stringify(m)).join("\n")}\nJSON\n`,
		);
		await chmod(path.join(binDir, "claude"), 0o755);
		const adapter = path.join(REPO_ROOT, "scripts", "adapters", "claude-code-tool-log.mjs");
		const taskId = `task_${"h".repeat(24)}`;
		const resultPath = path.join(dumpDir, "contenders.json");
		const contenders = await runScript(
			"scripts/run-contenders.mjs",
			operatorEnv({
				PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
				MADGRIX_BASE_URL: fx.mock.url,
				MADGRIX_TASK_ID: taskId,
				MADGRIX_AGENT_IDS: "agent-a,agent-b",
				MADGRIX_AGENT_SECRETS: JSON.stringify(fx.mock.enroll(taskId, ["agent-a", "agent-b"])),
				MADGRIX_AGENT_COMMAND: `set -o pipefail; claude -p "fix it" --output-format stream-json --verbose | node ${shq(adapter)} > /dev/null`,
				MADGRIX_CLAIM_PATHS: CLAIM_PATHS,
				MADGRIX_RESULT_PATH: resultPath,
			}),
		);
		assert.equal(contenders.code, 0, `run-contenders failed:\n${contenders.stderr}`);
		const candidate = JSON.parse(await readFile(resultPath, "utf8")).candidates[0];
		const evaluationPath = path.join(dumpDir, "evaluation.json");
		const evaluation = await runScript(
			"scripts/evaluate-candidate.ts",
			operatorEnv({
				MADGRIX_BASE_URL: fx.mock.url,
				MADGRIX_TASK_ID: taskId,
				MADGRIX_CONTENDER_ID: candidate.contender_id,
				MADGRIX_CANDIDATE_SHA: candidate.candidate_sha,
				MADGRIX_HIDDEN_TEST_COMMAND: "true",
				MADGRIX_RESULT_PATH: evaluationPath,
			}),
		);
		assert.equal(evaluation.code, 0, `evaluate-candidate failed:\n${evaluation.stderr}`);
		const result = JSON.parse(await readFile(evaluationPath, "utf8"));
		assert.deepEqual(result.tool_status, { actions: 1, errors: [] });
		assert.equal(result.bundle.admission.valid_tool_states, true);
		assert.equal(result.bundle.admission.provenance_complete, true);
		assert.equal(result.provenance.model, "claude-fake-model-1");
		assert.equal(result.provenance.harness, "claude-code/2.1.42");
		assert.equal(result.provenance.agent_id, candidate.agent_id);
	});

	it("evaluate-candidate.ts: hidden/regression/semantic/static/security commands run with minimalEnv() only", async () => {
		const dumpDir = await mkdtemp(path.join(fx.dumps, "evaluate-"));
		const taskId = `task_${"d".repeat(24)}`;
		const contender = fx.mock.createContender(taskId, "agent-eval");
		const work = await mkdtemp(path.join(fx.root, "candidate-"));
		git(fx.root, "clone", "--quiet", contender.bare, work);
		await writeFile(path.join(work, "CANDIDATE.txt"), "candidate under evaluation\n");
		git(work, "add", "-A");
		git(work, "commit", "--quiet", "-m", "candidate");
		git(work, "push", "--quiet", "origin", "HEAD:refs/heads/main");
		const candidateSha = git(work, "rev-parse", "HEAD");

		const resultPath = path.join(dumpDir, "result.json");
		const run = await runScript(
			"scripts/evaluate-candidate.ts",
			operatorEnv({
				MADGRIX_BASE_URL: fx.mock.url,
				MADGRIX_TASK_ID: taskId,
				MADGRIX_CONTENDER_ID: contender.id,
				MADGRIX_CANDIDATE_SHA: candidateSha,
				MADGRIX_RESULT_PATH: resultPath,
				MADGRIX_AGENT_ENV_ALLOWLIST: MODEL_KEY.name,
				...evaluationCommands(dumpDir),
			}),
		);
		assert.equal(run.code, 0, `evaluate-candidate failed:\n${run.stderr}`);
		const result = JSON.parse(await readFile(resultPath, "utf8"));
		assert.equal(result.candidate_sha, candidateSha);
		assert.equal(result.bundle.hidden_oracle.passed, true);
		assert.deepEqual(result.changed_files, ["CANDIDATE.txt"]);
		assert.equal(
			result.tree_sha256,
			treeDigestV1({ "CANDIDATE.txt": "candidate under evaluation\n", "README.md": "baseline\n" }),
		);

		const dumps = await readDumps(dumpDir, /^eval-\w+\.\d+\.env$/);
		assert.deepEqual(
			dumps.map(({ file }) => file.split(".")[0]).sort(),
			Object.keys(EVAL_COMMAND_VARS).map((kind) => `eval-${kind}`).sort(),
			"each of the five evaluation commands ran once",
		);
		for (const { file, dump } of dumps) {
			assertCredentials(file, dump, undefined, fx.mock.issuedCredentials);
			assertOnly(file, dump, []);
		}
	});

	it("live-e2e.ts: each child gets only its own zone's token and the agent gets none", async () => {
		const dumpDir = await mkdtemp(path.join(fx.dumps, "live-"));
		// A `node` shim first on PATH records the environment of every node
		// child live-e2e spawns (contender runner, evaluators, verifier).
		const shimDir = path.join(dumpDir, "bin");
		await mkdir(shimDir);
		await writeFile(
			path.join(shimDir, "node"),
			`#!/bin/sh\nenv > ${shq(dumpDir)}/node-"$(basename "$1")".$$.env\nexec ${shq(process.execPath)} "$@"\n`,
		);
		await chmod(path.join(shimDir, "node"), 0o755);

		const hidden = evaluationCommands(dumpDir);
		const live = await runScript(
			"scripts/live-e2e.ts",
			operatorEnv({
				PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ""}`,
				MADGRIX_BASE_URL: fx.mock.url,
				MADGRIX_BASELINE_REPO: "madgrix/env-isolation",
				MADGRIX_BASELINE_COMMIT: fx.baselineSha,
				MADGRIX_INTENT: "keep every credential inside its own zone",
				MADGRIX_BEHAVIOR_CONTRACT: "no child receives another zone's credential",
				MADGRIX_AGENT_IDS: "agent-a,agent-b",
				MADGRIX_AGENT_COMMAND: agentCommand(dumpDir),
				MADGRIX_CLAIM_PATHS: CLAIM_PATHS,
				MADGRIX_AGENT_ENV_ALLOWLIST: MODEL_KEY.name,
				MADGRIX_EVENT_TIMEOUT_MS: "10000",
				MADGRIX_BUNDLE_PATH: path.join(dumpDir, "promotion.bundle"),
				MADGRIX_TRUST_KEY: fx.trustKeyPath,
				...hidden,
			}),
		);
		assert.equal(live.code, 0, `live-e2e failed:\n${live.stderr}`);
		assert.match(live.stdout, /MADGRIX_LIVE_E2E_OK/);
		// live-e2e verified the Worker's bundle against the pinned key, not the embedded one.
		assert.match(live.stdout, /^authority key\.+ PINNED$/m);
		assert.match(live.stdout, /^VERIFIED$/m);

		const runner = await readDumps(dumpDir, /^node-run-contenders\.mjs\.\d+\.env$/);
		const evaluators = await readDumps(dumpDir, /^node-evaluate-candidate\.ts\.\d+\.env$/);
		const verifier = await readDumps(dumpDir, /^node-verify\.ts\.\d+\.env$/);
		assert.equal(runner.length, 1, "one contender-runner process");
		assert.equal(evaluators.length, 2, "one evaluator process per candidate");
		assert.equal(verifier.length, 1, "one offline-verify process");

		for (const { file, dump } of runner) {
			// The runner holds the agents' enrollment secrets; their agent commands never do.
			assertCredentials(file, dump, "agent", [], ["MADGRIX_AGENT_SECRETS"]);
			assertOnly(file, dump, [
				"MADGRIX_BASE_URL",
				"MADGRIX_TASK_ID",
				"MADGRIX_AGENT_SERVICE_TOKEN",
				"MADGRIX_AGENT_COMMAND",
				"MADGRIX_AGENT_IDS",
				"MADGRIX_AGENT_SECRETS",
				"MADGRIX_AGENT_ENV_ALLOWLIST",
				"MADGRIX_CLAIM_PATHS",
				"MADGRIX_RESULT_PATH",
				MODEL_KEY.name,
			]);
			assert.equal(dump.vars.get("MADGRIX_AGENT_SERVICE_TOKEN"), OPERATOR_SECRETS.MADGRIX_AGENT_SERVICE_TOKEN);
		}
		for (const { file, dump } of evaluators) {
			assertCredentials(file, dump, "evaluation");
			assertOnly(file, dump, [
				"MADGRIX_BASE_URL",
				"MADGRIX_TASK_ID",
				"MADGRIX_CONTENDER_ID",
				"MADGRIX_CANDIDATE_SHA",
				"MADGRIX_EVALUATION_SERVICE_TOKEN",
				"MADGRIX_RESULT_PATH",
				...Object.values(EVAL_COMMAND_VARS),
			]);
			assert.equal(
				dump.vars.get("MADGRIX_EVALUATION_SERVICE_TOKEN"),
				OPERATOR_SECRETS.MADGRIX_EVALUATION_SERVICE_TOKEN,
			);
		}
		for (const { file, dump } of verifier) {
			assertCredentials(file, dump);
			assertOnly(file, dump, []);
		}

		const agents = await readDumps(dumpDir, /^agent-.+\.env$/);
		assert.equal(agents.length, 2, "one agent command per contender");
		for (const { file, dump } of agents) {
			assertCredentials(file, dump, undefined, fx.mock.issuedCredentials);
			assertOnly(file, dump, [...AGENT_VARS, MODEL_KEY.name]);
			for (const command of Object.values(hidden)) {
				assert.ok(!dump.text.includes(command), `${file}: an evaluation command reached the agent`);
			}
		}

		const evaluations = await readDumps(dumpDir, /^eval-\w+\.\d+\.env$/);
		assert.equal(evaluations.length, 10, "five evaluation commands per candidate");
		for (const { file, dump } of evaluations) {
			assertCredentials(file, dump, undefined, fx.mock.issuedCredentials);
			assertOnly(file, dump, []);
		}
	});
});
