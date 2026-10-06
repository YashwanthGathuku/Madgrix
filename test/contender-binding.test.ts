/**
 * Contender binding: one agent cannot take over another agent's contender
 * (spec 3 §5 credential matrix, spec 3 §7 quarantine; amendment
 * specs/amendments/contender-agent-binding.md).
 *
 * Every agent shares one AGENT_SERVICE_TOKEN. Before this fix
 * POST /tasks/:id/contenders took agent_id from the request body, so agent B
 * could name agent A, receive a fresh 1h write token on A's fork, and the
 * TaskAuthority overwrote A's contender record (and its token id) with B's.
 *
 * These tests drive the real Worker router (src/worker/index.ts) against
 * FakeArtifacts and real TaskAuthority Durable Objects on in-memory storage.
 * The Worker's only Workers-runtime import, `cloudflare:workers`, is mapped
 * to a stub with module.registerHooks before the Worker module loads.
 *
 * The last suite drives the same harness through /evidence: evidence naming
 * changed evaluation files quarantines the contender and revokes its fork
 * tokens (specs/amendments/tamper-quarantine-v1.md).
 *
 * node --test test/contender-binding.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { registerHooks } from "node:module";

import { TaskAuthority } from "../src/do/TaskAuthority.ts";
import { canonicalJson, sha256Hex } from "../src/lib/canonical.ts";
import { assumeCompleteMergeArtifactScan } from "../src/lib/merge-artifacts.ts";
import { FakeArtifacts } from "../src/lib/fake-artifacts.ts";
import { quarantineContender, type Ctx } from "../src/lib/task-state.ts";
import { SELECTOR_POLICY_VERSION, type AuthorityState, type TaskRecord } from "../src/lib/types.ts";

const WORKERS_STUB = `data:text/javascript,${encodeURIComponent("export class WorkflowEntrypoint {}")}`;
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "cloudflare:workers") return { url: WORKERS_STUB, shortCircuit: true };
		return nextResolve(specifier, context);
	},
});
const { fetch: workerFetch, executeEffects } = await import("../src/worker/index.ts");

const TOKENS = {
	control: "control-service-token-0001",
	agent: "agent-service-token-0002",
	evaluation: "evaluation-service-token-0003",
};
const AGENT_SECRET_HEADER = "x-madgrix-agent-secret";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Durable Object namespace whose objects keep storage in memory. Storage
 *  round-trips through structuredClone, as real DO storage serializes, and
 *  transactions run one at a time. */
function memoryNamespace(make: (state: unknown) => { fetch(r: Request): Promise<Response> }) {
	const objects = new Map<string, { fetch(r: Request): Promise<Response> }>();
	return {
		idFromName: (name: string) => ({ toString: () => name }),
		get(id: { toString(): string }) {
			const key = id.toString();
			let object = objects.get(key);
			if (!object) {
				const data = new Map<string, unknown>();
				let queue: Promise<unknown> = Promise.resolve();
				const storage = {
					get: async (k: string) => structuredClone(data.get(k)),
					put: async (k: string, v: unknown) => void data.set(k, structuredClone(v)),
					transaction<T>(fn: (txn: unknown) => Promise<T>): Promise<T> {
						const run = queue.then(() => fn(undefined));
						queue = run.catch(() => undefined);
						return run;
					},
				};
				object = make({ storage, id: { toString: () => key } });
				objects.set(key, object);
			}
			return object;
		},
	};
}

interface Harness {
	fake: FakeArtifacts;
	env: Record<string, unknown> & { TASK_AUTHORITY: ReturnType<typeof memoryNamespace> };
	taskId: string;
	taskHash: string;
	baseline: string;
	/** Agent id → the secret POST /tasks issued it (agent-enrollment-v1). */
	secrets: Record<string, string>;
}

interface Reply {
	status: number;
	body: any;
}

async function call(
	h: Pick<Harness, "env">,
	method: string,
	path: string,
	opts: { token?: string; secret?: string; body?: unknown } = {},
): Promise<Reply> {
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (opts.token) headers.authorization = `Bearer ${opts.token}`;
	if (opts.secret !== undefined) headers[AGENT_SECRET_HEADER] = opts.secret;
	const res = await workerFetch(
		new Request(`https://madgrix.test${path}`, {
			method,
			headers,
			body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
		}),
		h.env as never,
	);
	return { status: res.status, body: await res.json() };
}

async function makeHarness(): Promise<Harness> {
	const fake = new FakeArtifacts();
	const env = {
		ARTIFACTS: fake,
		TASK_AUTHORITY: memoryNamespace((state) => new TaskAuthority(state as never, {})),
		PROMOTION_CONTAINER: memoryNamespace(() => ({
			fetch: async () => {
				throw new Error("the promotion container is not used by these routes");
			},
		})),
		CONTROL_SERVICE_TOKEN: TOKENS.control,
		AGENT_SERVICE_TOKEN: TOKENS.agent,
		EVALUATION_SERVICE_TOKEN: TOKENS.evaluation,
	};
	await fake.create("baseline");
	const baseline = await fake.adminPush({
		repo: "baseline",
		ref: "main",
		tree: { "src/app.js": "export const ok = true;\n" },
		message: "baseline",
	});
	const created = await call({ env }, "POST", "/tasks", {
		token: TOKENS.control,
		body: {
			intent: "bind contenders to agents",
			baseline_repo: "baseline",
			baseline_commit: baseline,
			agent_ids: ["agent-a", "agent-b", "agent-c"],
		},
	});
	assert.equal(created.status, 201, `task creation failed: ${JSON.stringify(created.body)}`);
	return {
		fake,
		env,
		taskId: created.body.task_id,
		taskHash: created.body.task_hash,
		baseline,
		secrets: created.body.agent_secrets,
	};
}

/**
 * A task the authority initialized without enrollment, as before
 * agent-enrollment-v1: an agent's first claim mints its secret.
 */
async function makeLegacyHarness(): Promise<Harness> {
	const h = await makeHarness();
	const task: TaskRecord = {
		task_id: "task_legacy_unenrolled",
		task_hash: await sha256Hex("a task initialized without enrollment"),
		intent: "bind contenders to agents",
		baseline_repo: "baseline",
		baseline_commit: h.baseline,
		behavior_contract: "",
		policy_version: SELECTOR_POLICY_VERSION,
		frozen_at: "2026-10-02T09:00:00Z",
	};
	const legacy = { ...h, taskId: task.task_id, taskHash: task.task_hash, secrets: {} };
	const init = await authority(legacy).fetch(
		new Request("https://task-authority/init", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ task }),
		}),
	);
	assert.equal(init.status, 200);
	return legacy;
}

function claimInput(h: Harness, agent: string) {
	return {
		agent,
		task: h.taskHash,
		baseline: h.baseline,
		intent: { behavior: [`${agent} keeps its own fork`] },
		scope: { paths: ["src/**"], symbols: [] },
		contracts: { reads: [], modifies: [] },
		interfaces: [],
		schema_changes: [],
		expected_tests: [],
		lease: { claimed_at: "2026-10-02T09:00:00Z", expires_at: "2026-10-02T10:00:00Z" },
	};
}

function claim(h: Harness, agent: string, secret?: string): Promise<Reply> {
	return call(h, "POST", `/tasks/${h.taskId}/claim`, { token: TOKENS.agent, secret, body: { claim: claimInput(h, agent) } });
}

function contender(
	h: Harness,
	opts: { secret?: string; agent_id?: string; claim_work_id?: string },
): Promise<Reply> {
	const body: Record<string, string> = {};
	if (opts.agent_id !== undefined) body.agent_id = opts.agent_id;
	if (opts.claim_work_id !== undefined) body.claim_work_id = opts.claim_work_id;
	return call(h, "POST", `/tasks/${h.taskId}/contenders`, { token: TOKENS.agent, secret: opts.secret, body });
}

function authority(h: Harness) {
	return h.env.TASK_AUTHORITY.get(h.env.TASK_AUTHORITY.idFromName(h.taskId));
}

async function authorityState(h: Harness): Promise<AuthorityState> {
	return (await authority(h).fetch(new Request("https://task-authority/state"))).json() as Promise<AuthorityState>;
}

/** The stored contender record, serialized: equal strings = byte-identical records. */
async function storedRecord(h: Harness, contenderId: string): Promise<string> {
	return JSON.stringify((await authorityState(h)).contenders[contenderId]);
}

async function forkTokens(h: Harness, forkRepo: string): Promise<string> {
	return JSON.stringify(await (await h.fake.get(forkRepo)).listTokens());
}

const testCtx: Ctx = {
	now: () => "2026-10-02T09:30:00.000Z",
	randomHex: (n: number) => "c".repeat(n * 2),
	sha256Hex,
	selectorPolicyHash: "policyhash",
	policyVersion: "seam-policy/0.1.0",
};

describe("contender binding: one agent cannot take over another agent's contender", () => {
	it("agent B naming agent A gets 403 and no token; A's record is byte-identical", async () => {
		const h = await makeHarness();
		const claimA = await claim(h, "agent-a", h.secrets["agent-a"]);
		const contenderA = await contender(h, {
			secret: h.secrets["agent-a"],
			agent_id: "agent-a",
			claim_work_id: claimA.body.work_id,
		});
		assert.equal(contenderA.status, 201);
		assert.equal(typeof contenderA.body.token, "string", "A receives its write token");
		const recordBefore = await storedRecord(h, contenderA.body.contender_id);
		const tokensBefore = await forkTokens(h, contenderA.body.fork_repo);

		await claim(h, "agent-b", h.secrets["agent-b"]);
		const attack = await contender(h, { secret: h.secrets["agent-b"], agent_id: "agent-a" });

		assert.equal(typeof attack.body.token, "undefined", "B must not receive a write token for A's fork");
		assert.equal(attack.status, 403);
		assert.equal(await storedRecord(h, contenderA.body.contender_id), recordBefore, "A's record is byte-identical");
		assert.equal(await forkTokens(h, contenderA.body.fork_repo), tokensBefore, "no token minted on A's fork");
	});

	it("on a task initialized without enrollment, /claim returns a 32-byte hex secret once; only its SHA-256 is kept", async () => {
		const h = await makeLegacyHarness();
		const first = await claim(h, "agent-a");
		assert.equal(first.status, 200);
		assert.match(String(first.body.agent_secret), /^[0-9a-f]{64}$/);
		const secret: string = first.body.agent_secret;

		const state = await authorityState(h);
		const stored = state.claims.find((c) => c.work_id === first.body.work_id);
		assert.equal(stored?.agent_secret_sha256, sha256(secret));
		assert.ok(!JSON.stringify(state).includes(secret), "the plaintext secret is not persisted");
		const context = await call(h, "GET", `/tasks/${h.taskId}/context`, { token: TOKENS.agent });
		assert.equal(context.status, 200);
		assert.ok(!JSON.stringify(context.body).includes(sha256(secret)), "task context does not expose the hash");

		// Agent A's identity is bound: a later claim as agent-a needs A's secret.
		const claimB = await claim(h, "agent-b");
		for (const presented of [undefined, claimB.body.agent_secret]) {
			const impostor = await claim(h, "agent-a", presented);
			assert.equal(impostor.status, 403, "a claim as agent-a without A's secret is refused");
			assert.equal(impostor.body.agent_secret, undefined);
		}
		const second = await claim(h, "agent-a", secret);
		assert.equal(second.status, 200);
		assert.equal(second.body.agent_secret, undefined, "the secret is returned once");

		// The hash is assigned by the authority, never accepted from the caller.
		const forged = await call(h, "POST", `/tasks/${h.taskId}/claim`, {
			token: TOKENS.agent,
			body: { claim: { ...claimInput(h, "agent-c"), agent_secret_sha256: sha256("chosen") } },
		});
		assert.equal(forged.status, 400);
	});

	it("/contenders requires X-Madgrix-Agent-Secret and derives the agent from the matching claim", async () => {
		const h = await makeHarness();
		const a = await claim(h, "agent-a", h.secrets["agent-a"]);
		const b = await claim(h, "agent-b", h.secrets["agent-b"]);

		const missing = await contender(h, { agent_id: "agent-a", claim_work_id: a.body.work_id });
		assert.equal(missing.status, 401, "no agent secret");
		const unknown = await contender(h, { secret: "0".repeat(64), agent_id: "agent-a" });
		assert.equal(unknown.status, 403, "secret matches no claim");
		const crossClaim = await contender(h, { secret: h.secrets["agent-b"], claim_work_id: a.body.work_id });
		assert.equal(crossClaim.status, 403, "B cannot bind A's claim");
		for (const refused of [missing, unknown, crossClaim]) assert.equal(typeof refused.body.token, "undefined");

		const derived = await contender(h, { secret: h.secrets["agent-b"], claim_work_id: b.body.work_id });
		assert.equal(derived.status, 201);
		const state = await authorityState(h);
		assert.deepEqual(
			Object.values(state.contenders).map((c) => [c.agent_id, c.claim_work_id]),
			[["agent-b", b.body.work_id]],
			"only B's own contender exists, derived from B's secret",
		);
	});

	it("an existing contender is returned unchanged with 200 and no new token", async () => {
		const h = await makeHarness();
		await claim(h, "agent-a", h.secrets["agent-a"]);
		const first = await contender(h, { secret: h.secrets["agent-a"], agent_id: "agent-a" });
		assert.equal(first.status, 201);
		const id: string = first.body.contender_id;
		const recordBefore = await storedRecord(h, id);
		const tokensBefore = await forkTokens(h, first.body.fork_repo);

		const retry = await contender(h, { secret: h.secrets["agent-a"], agent_id: "agent-a" });
		assert.equal(retry.status, 200);
		assert.equal(retry.body.contender_id, id);
		assert.equal(typeof retry.body.token, "undefined", "a retry mints no second token");
		assert.equal(await storedRecord(h, id), recordBefore);
		assert.equal(await forkTokens(h, first.body.fork_repo), tokensBefore);

		// The TaskAuthority itself never overwrites, whatever the edge sends.
		const replacement = { ...JSON.parse(recordBefore), agent_id: "agent-b", token_id: "tok-other", token_ids: ["tok-other"] };
		const res = await authority(h).fetch(
			new Request("https://task-authority/contender", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ contender: replacement }),
			}),
		);
		assert.equal(res.status, 200);
		const body = (await res.json()) as { recorded: boolean; contender: unknown };
		assert.equal(body.recorded, false);
		assert.equal(JSON.stringify(body.contender), recordBefore);
		assert.equal(await storedRecord(h, id), recordBefore);
	});

	it("every minted token id is on the contender and quarantine revokes all of them", async () => {
		const h = await makeHarness();
		await claim(h, "agent-a", h.secrets["agent-a"]);
		const created = await contender(h, { secret: h.secrets["agent-a"], agent_id: "agent-a" });
		const state = await authorityState(h);
		const record = state.contenders[created.body.contender_id];
		assert.deepEqual(record.token_ids, [record.token_id], "the minted write token is recorded");
		const fork = await h.fake.get(record.fork_repo);
		assert.deepEqual(
			(await fork.listTokens()).filter((t) => t.state === "active").map((t) => t.id),
			record.token_ids,
			"every live token on the fork is on the record",
		);

		// A record carrying two minted tokens: quarantine revokes both.
		const extra = await fork.createToken("write", 3600);
		const twoTokens: AuthorityState = {
			...state,
			contenders: { ...state.contenders, [record.contender_id]: { ...record, token_ids: [record.token_id, extra.id] } },
		};
		const { effects } = await quarantineContender(
			twoTokens,
			record.contender_id,
			"credential_scope_violation",
			"evidence-hash",
			testCtx,
		);
		const revokes = effects.filter((e) => e.kind === "revoke_token");
		assert.deepEqual(
			revokes.map((e) => (e.kind === "revoke_token" ? e.token_id : null)),
			[record.token_id, extra.id],
		);
		await executeEffects(h.fake, revokes);
		assert.deepEqual(
			(await fork.listTokens()).filter((t) => t.state === "active"),
			[],
			"no write token on the fork survives quarantine",
		);
	});
});

describe("tamper quarantine at the evidence route", () => {
	async function contenderWithPush(h: Harness, sha: string) {
		await claim(h, "agent-a", h.secrets["agent-a"]);
		const created = await contender(h, { secret: h.secrets["agent-a"], agent_id: "agent-a" });
		assert.equal(created.status, 201);
		const event = { namespace: "default", repo: created.body.fork_repo, ref: "refs/heads/main", before: h.baseline, after: sha };
		const pushed = await authority(h).fetch(
			new Request("https://task-authority/event", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ event }),
			}),
		);
		assert.equal(pushed.status, 200);
		return created.body as { contender_id: string; fork_repo: string };
	}

	async function evidence(h: Harness, contenderId: string, sha: string, evalFileChanges: string[]) {
		const rest = {
			candidate_sha: sha,
			tree_sha256: await sha256Hex(`tree of ${sha}`),
			contender_id: contenderId,
			task_hash: h.taskHash,
			admission: {
				exact_baseline: true,
				scope_compliance: true,
				valid_tool_states: true,
				no_eval_tampering: evalFileChanges.length === 0,
				provenance_complete: true,
			},
			hidden_oracle: { passed: true, total: 1, failed: [] as string[] },
			regressions: { passed: true, total: 1, failed: [] as string[] },
			static_analysis: { passed: true, findings: [] as string[] },
			semantic_checks: { passed: true, total: 1, failed: [] as string[] },
			security_policy: { passed: evalFileChanges.length === 0, findings: [] as string[] },
			evaluated_at: "2026-10-03T09:00:00Z",
			tainted: false,
			eval_file_changes: evalFileChanges,
		};
		const scanned = assumeCompleteMergeArtifactScan(rest);
		const bundle = { ...scanned, bundle_hash: await sha256Hex(canonicalJson(scanned)) };
		return call(h, "POST", `/tasks/${h.taskId}/evidence`, { token: TOKENS.evaluation, body: { bundle } });
	}

	it("evidence naming changed evaluation files quarantines the contender and revokes every fork token", async () => {
		const h = await makeHarness();
		const sha = "ca11ed0000000000000000000000000000000001";
		const c = await contenderWithPush(h, sha);
		const fork = await h.fake.get(c.fork_repo);
		assert.ok((await fork.listTokens()).some((t) => t.state === "active"), "the contender holds a live write token");

		const res = await evidence(h, c.contender_id, sha, ["package.json"]);
		assert.equal(res.status, 200, JSON.stringify(res.body));
		assert.equal(res.body.quarantined, true);
		assert.equal(res.body.effects, undefined, "effects are executed by the Worker, not returned to the evaluator");

		const state = await authorityState(h);
		assert.equal(state.quarantine[c.contender_id]?.status, "QUARANTINED");
		assert.equal(state.quarantine[c.contender_id]?.trigger, "eval_file_modification");
		assert.equal(state.contenders[c.contender_id].status, "quarantined");
		assert.deepEqual(
			(await fork.listTokens()).filter((t) => t.state === "active"),
			[],
			"no write token on the fork survives",
		);
	});

	it("evidence without changed evaluation files quarantines nothing", async () => {
		const h = await makeHarness();
		const sha = "ca11ed0000000000000000000000000000000002";
		const c = await contenderWithPush(h, sha);
		const res = await evidence(h, c.contender_id, sha, []);
		assert.equal(res.status, 200, JSON.stringify(res.body));
		assert.equal(res.body.quarantined, false);
		assert.equal((await authorityState(h)).quarantine[c.contender_id], undefined);
	});
});

describe("agent enrollment (specs/amendments/agent-enrollment-v1.md)", () => {
	async function enrolledHarness(agentIds: string[]) {
		const h = await makeHarness();
		const created = await call(h, "POST", "/tasks", {
			token: TOKENS.control,
			body: { intent: "enroll agents", baseline_repo: "baseline", baseline_commit: h.baseline, agent_ids: agentIds },
		});
		return { ...h, created, taskId: created.body.task_id, taskHash: created.body.task_hash };
	}

	it("POST /tasks requires agent_ids and returns one 32-byte hex secret per agent, once; the authority keeps only SHA-256", async () => {
		const h = await makeHarness();
		const missing = await call(h, "POST", "/tasks", {
			token: TOKENS.control,
			body: { intent: "no agents named", baseline_repo: "baseline", baseline_commit: h.baseline },
		});
		assert.equal(missing.status, 400);
		assert.equal(missing.body.error, "agent_ids_required");

		const e = await enrolledHarness(["agent-a", "agent-b"]);
		assert.equal(e.created.status, 201);
		const secrets: Record<string, string> = e.created.body.agent_secrets;
		assert.deepEqual(Object.keys(secrets ?? {}).sort(), ["agent-a", "agent-b"]);
		for (const secret of Object.values(secrets)) assert.match(secret, /^[0-9a-f]{64}$/);
		const state = await authorityState(e);
		assert.deepEqual(state.agent_enrollment, {
			"agent-a": sha256(secrets["agent-a"]),
			"agent-b": sha256(secrets["agent-b"]),
		});
		for (const secret of Object.values(secrets)) {
			assert.ok(!JSON.stringify(state).includes(secret), "no plaintext secret is stored");
		}
	});

	it("an agent's first claim needs its own secret: a squatter gets 403 and the real agent still claims", async () => {
		const e = await enrolledHarness(["agent-a", "agent-b"]);
		const secrets: Record<string, string> = e.created.body.agent_secrets ?? {};
		for (const presented of [undefined, secrets["agent-b"], "0".repeat(64)]) {
			const squat = await claim(e, "agent-a", presented);
			assert.equal(squat.status, 403, `claim as agent-a with ${presented === undefined ? "no" : "a wrong"} secret`);
			assert.equal(squat.body.agent_secret, undefined);
		}
		const real = await claim(e, "agent-a", secrets["agent-a"]);
		assert.equal(real.status, 200, JSON.stringify(real.body));
		assert.equal(real.body.agent_secret, undefined, "enrolled agents are never handed a minted secret");
		const created = await contender(e, { secret: secrets["agent-a"], claim_work_id: real.body.work_id });
		assert.equal(created.status, 201);
		assert.equal((await authorityState(e)).contenders[created.body.contender_id].agent_id, "agent-a");
	});

	it("an agent id the control plane did not enroll cannot claim", async () => {
		const e = await enrolledHarness(["agent-a"]);
		const res = await claim(e, "agent-z", e.created.body.agent_secrets?.["agent-a"]);
		assert.equal(res.status, 403);
		assert.equal(res.body.error, "agent_not_enrolled");
	});
});
