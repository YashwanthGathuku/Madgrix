/**
 * The TaskAuthority signs the ship record at /promotion/finalize and the
 * Worker serves it at GET /tasks/:id/bundle (spec 1 §11; amendment
 * authority-signing-v1).
 *
 * A real TaskAuthority Durable Object on in-memory storage is seeded with an
 * authority state holding an issued permit (built by the pure state
 * machine), then finalized the way the Worker's /promote route finalizes
 * after the canonical write. The Worker router serves the bundle; its only
 * Workers-runtime import, `cloudflare:workers`, is mapped to a stub with
 * module.registerHooks.
 *
 * node --test test/promotion-bundle.test.ts
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { registerHooks } from "node:module";

import { SELECTOR_POLICY_INPUT, TaskAuthority } from "../src/do/TaskAuthority.ts";
import { canonicalJson, sha256Hex } from "../src/lib/canonical.ts";
import {
	createAuthority,
	issuePermit,
	registerClaim,
	runVerdictSeam,
	submitEvaluation,
	type Ctx,
} from "../src/lib/task-state.ts";
import { SELECTOR_POLICY_VERSION, type AuthorityState, type EvaluationBundle } from "../src/lib/types.ts";
import { parseTrustedKey, verifyWithTrustedKey } from "../src/cli/verify.ts";

const WORKERS_STUB = `data:text/javascript,${encodeURIComponent("export class WorkflowEntrypoint {}")}`;
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "cloudflare:workers") return { url: WORKERS_STUB, shortCircuit: true };
		return nextResolve(specifier, context);
	},
});
const { fetch: workerFetch } = await import("../src/worker/index.ts");

const TOKENS = { control: "control-service-token-0001", agent: "agent-service-token-0002" };
const TASK_ID = "task_bundle_route";
const CANDIDATE = "c0ffee0000000000000000000000000000000001";
const HEAD = "5eed000000000000000000000000000000000002";
const BASELINE = "ba5e000000000000000000000000000000000003";

async function seededState(ctx: Ctx) {
	const task_hash = await sha256Hex("bundle-route task");
	let state: AuthorityState = createAuthority({
		task_id: TASK_ID,
		task_hash,
		intent: "sign the ship record at finalize",
		baseline_repo: "acme/api",
		baseline_commit: BASELINE,
		behavior_contract: "",
		policy_version: SELECTOR_POLICY_VERSION,
		frozen_at: ctx.now(),
	});
	const claim = await registerClaim(
		state,
		{
			agent: "agent-a",
			task: task_hash,
			baseline: BASELINE,
			intent: { behavior: ["fix"] },
			scope: { paths: ["src/**"], symbols: [] },
			contracts: { reads: [], modifies: [] },
			interfaces: [],
			schema_changes: [],
			expected_tests: [],
			lease: { claimed_at: ctx.now(), expires_at: "2026-10-03T00:00:00Z" },
		},
		ctx,
	);
	state = {
		...claim.state,
		contenders: {
			"contender-a": {
				contender_id: "contender-a",
				agent_id: "agent-a",
				fork_repo: "fork-contender-a",
				fork_lineage: { parent_repo: "acme/api", parent_commit: BASELINE },
				token_id: "tok-a",
				token_ids: ["tok-a"],
				status: "forked",
				claim_work_id: claim.claim.work_id,
				latest_commit: CANDIDATE,
			},
		},
	};
	const rest = {
		candidate_sha: CANDIDATE,
		tree_sha256: await sha256Hex("the reviewed tree"),
		contender_id: "contender-a",
		task_hash,
		admission: {
			exact_baseline: true,
			scope_compliance: true,
			valid_tool_states: true,
			no_eval_tampering: true,
			provenance_complete: true,
		},
		hidden_oracle: { passed: true, total: 2, failed: [] as string[] },
		regressions: { passed: true, total: 3, failed: [] as string[] },
		static_analysis: { passed: true, findings: [] as string[] },
		semantic_checks: { passed: true, total: 1, failed: [] as string[] },
		security_policy: { passed: true, findings: [] as string[] },
		evaluated_at: ctx.now(),
		tainted: false,
	};
	const evaluation: EvaluationBundle = { ...rest, bundle_hash: await sha256Hex(canonicalJson(rest)) };
	state = (await submitEvaluation(state, evaluation, { zone: "evaluation_domain" }, ctx)).state;
	const verdict = await runVerdictSeam(
		state,
		[{ contender_id: "contender-a", candidate_sha: CANDIDATE, blast_radius: 0, change_surface: 1 }],
		ctx,
	);
	assert.equal(verdict.record.state, "ACCEPT");
	const { state: withPermit, permit } = await issuePermit(verdict.state, CANDIDATE, "acme/canonical", HEAD, ctx);
	return { state: withPermit, permit };
}

/** In-memory Durable Object storage: structured-clone round-trips, one transaction at a time. */
function memoryStorage(initial: Record<string, unknown>) {
	const data = new Map(Object.entries(initial).map(([k, v]) => [k, structuredClone(v)]));
	let queue: Promise<unknown> = Promise.resolve();
	return {
		get: async (k: string) => structuredClone(data.get(k)),
		put: async (k: string, v: unknown) => void data.set(k, structuredClone(v)),
		transaction<T>(fn: (txn: unknown) => Promise<T>): Promise<T> {
			const run = queue.then(() => fn(undefined));
			queue = run.catch(() => undefined);
			return run;
		},
	};
}

async function rpc(authority: TaskAuthority, method: string, path: string, body?: unknown) {
	const res = await authority.fetch(
		new Request(`https://task-authority${path}`, {
			method,
			headers: { "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
	);
	return { status: res.status, body: (await res.json()) as any };
}

describe("TaskAuthority signs the ship record at /promotion/finalize", () => {
	const fx = {} as {
		noKey: TaskAuthority;
		withKey: TaskAuthority;
		env: Record<string, unknown>;
		finalize: Record<string, string>;
		permitId: string;
		pinnedKeyDerHex: string;
		bundle: any;
	};

	before(async () => {
		const ctx: Ctx = {
			now: () => new Date().toISOString(),
			randomHex: (n: number) => randomBytes(n).toString("hex"),
			sha256Hex,
			selectorPolicyHash: await sha256Hex(SELECTOR_POLICY_INPUT),
			policyVersion: SELECTOR_POLICY_VERSION,
		};
		const { state, permit } = await seededState(ctx);
		const storage = memoryStorage({ "authority-state": state });
		const id = { toString: () => TASK_ID };
		const key = generateKeyPairSync("ed25519");
		fx.noKey = new TaskAuthority({ storage, id } as never, {});
		fx.withKey = new TaskAuthority({ storage, id } as never, {
			AUTHORITY_SIGNING_KEY: key.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
		});
		fx.pinnedKeyDerHex = parseTrustedKey(key.publicKey.export({ type: "spki", format: "pem" }).toString());
		fx.permitId = permit.permit_id;
		fx.finalize = {
			permit_id: permit.permit_id,
			verified_parent: HEAD,
			tree_sha256: permit.winning_tree_sha256,
			promoted_sha: CANDIDATE,
		};
		fx.env = {
			TASK_AUTHORITY: { idFromName: (n: string) => ({ toString: () => n }), get: () => fx.withKey },
			CONTROL_SERVICE_TOKEN: TOKENS.control,
			AGENT_SERVICE_TOKEN: TOKENS.agent,
			EVALUATION_SERVICE_TOKEN: "evaluation-service-token-0003",
		};
	});

	async function getBundle(token: string, query = "") {
		const res = await workerFetch(
			new Request(`https://madgrix.test/tasks/${TASK_ID}/bundle${query}`, {
				headers: { authorization: `Bearer ${token}` },
			}),
			fx.env as never,
		);
		return { status: res.status, body: (await res.json()) as any };
	}

	it("without AUTHORITY_SIGNING_KEY: 503, the permit stays unconsumed, no bundle", async () => {
		const res = await rpc(fx.noKey, "POST", "/promotion/finalize", fx.finalize);
		assert.equal(res.status, 503);
		assert.equal(res.body.error, "authority_signing_key_unavailable");
		const state = (await rpc(fx.noKey, "GET", "/state")).body as AuthorityState;
		assert.equal(state.permits[fx.permitId].consumed, false);
		assert.equal(state.promotion_bundles, undefined);
		assert.equal((await getBundle(TOKENS.control)).status, 404);
	});

	it("consumes, ledgers and signs in one step; GET /tasks/:id/bundle serves it; it verifies against the pinned key", async () => {
		const res = await rpc(fx.withKey, "POST", "/promotion/finalize", fx.finalize);
		assert.equal(res.status, 200, JSON.stringify(res.body));
		assert.equal(res.body.outcome, "PROMOTED");
		fx.bundle = res.body.bundle;

		const state = (await rpc(fx.withKey, "GET", "/state")).body as AuthorityState;
		assert.equal(state.permits[fx.permitId].consumed, true);
		assert.equal(state.ledger.at(-1)?.kind, "promotion_succeeded");
		assert.equal(fx.bundle.ledger.head_sha256, state.ledger.at(-1)?.entry_hash, "the bundle signs the ledger head at promotion");
		assert.deepEqual(state.promotion_bundles?.[fx.permitId], fx.bundle);
		assert.equal(fx.bundle.ship.commit, CANDIDATE);
		assert.equal(fx.bundle.authority_pubkey_der_hex, fx.pinnedKeyDerHex);

		const served = await getBundle(TOKENS.control, `?permit_id=${fx.permitId}`);
		assert.equal(served.status, 200);
		assert.deepEqual(served.body, fx.bundle);
		assert.deepEqual((await getBundle(TOKENS.control)).body, fx.bundle, "default: the latest promotion");
		assert.equal((await getBundle(TOKENS.agent)).status, 401, "control plane only");

		const verified = await verifyWithTrustedKey(fx.bundle, fx.pinnedKeyDerHex);
		assert.equal(verified.verified, true, JSON.stringify(verified.lines));
		const otherKey = parseTrustedKey(
			generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString(),
		);
		assert.equal((await verifyWithTrustedKey(fx.bundle, otherKey)).verified, false);
	});

	it("a finalize retry returns the same bundle and appends nothing", async () => {
		const before = (await rpc(fx.withKey, "GET", "/state")).body as AuthorityState;
		const retry = await rpc(fx.withKey, "POST", "/promotion/finalize", fx.finalize);
		assert.equal(retry.status, 200);
		assert.equal(retry.body.outcome, "ALREADY_CONSUMED");
		assert.deepEqual(retry.body.bundle, fx.bundle);
		const after = (await rpc(fx.withKey, "GET", "/state")).body as AuthorityState;
		assert.equal(after.ledger.length, before.ledger.length);
	});
});
