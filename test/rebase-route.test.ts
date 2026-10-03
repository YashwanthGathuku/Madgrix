/**
 * The Worker's verdict, rebase and promote routes when the destination moves
 * (specs/amendments/rebase-ancestry-v1.md).
 *
 * Drives the real Worker router (src/worker/index.ts) and real TaskAuthority
 * Durable Objects on in-memory storage over FakeArtifacts. The promotion
 * container Durable Object is replaced by one that runs the container's
 * procedures over the same FakeArtifacts repositories
 * (src/harness/fake-container.ts, the model test/promotion-fixtures.test.ts
 * holds to container/promote.sh and container/rebase.sh), or that returns a
 * canned answer. The Worker's only Workers-runtime import,
 * `cloudflare:workers`, is mapped to a stub with module.registerHooks.
 *
 * node --test test/rebase-route.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { registerHooks } from "node:module";

import { TaskAuthority } from "../src/do/TaskAuthority.ts";
import { canonicalJson, sha256Hex } from "../src/lib/canonical.ts";
import { FakeArtifacts } from "../src/lib/fake-artifacts.ts";
import { treeDigestOfFiles } from "../src/lib/tree-digest.ts";
import { fakePromote, fakeRebase } from "../src/harness/fake-container.ts";
import { parseTrustedKey, verifyWithTrustedKey } from "../src/cli/verify.ts";
import type { AuthorityState } from "../src/lib/types.ts";

const WORKERS_STUB = `data:text/javascript,${encodeURIComponent("export class WorkflowEntrypoint {}")}`;
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "cloudflare:workers") return { url: WORKERS_STUB, shortCircuit: true };
		return nextResolve(specifier, context);
	},
});
const { fetch: workerFetch, PromotionWorkflow } = await import("../src/worker/index.ts");

const TOKENS = {
	control: "control-service-token-0001",
	agent: "agent-service-token-0002",
	evaluation: "evaluation-service-token-0003",
};

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

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

const BASELINE_TREE = { "README.md": "acme api\n", "src/a.js": "export const isExpired = (exp, now) => exp < now;\n" };
const FIXED_TREE = { ...BASELINE_TREE, "src/a.js": "export const isExpired = (exp, now) => exp <= now;\n" };

interface Harness {
	fake: FakeArtifacts;
	env: Record<string, any>;
	taskId: string;
	baseline: string;
	contenderId: string;
	forkRepo: string;
	forkToken: string;
	pinnedKeyDerHex: string;
	/** Replace the container's answers; null: run the container model. */
	containerAnswer: ((body: any) => Promise<Response>) | null;
	containerCalls: any[];
}

async function call(h: Harness, method: string, path: string, opts: { token?: string; secret?: string; body?: unknown } = {}) {
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (opts.token) headers.authorization = `Bearer ${opts.token}`;
	if (opts.secret) headers["x-madgrix-agent-secret"] = opts.secret;
	const res = await workerFetch(
		new Request(`https://madgrix.test${path}`, {
			method,
			headers,
			body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
		}),
		h.env as never,
	);
	return { status: res.status, body: (await res.json()) as any };
}

function authority(h: Harness) {
	return h.env.TASK_AUTHORITY.get(h.env.TASK_AUTHORITY.idFromName(h.taskId));
}

async function authorityState(h: Harness): Promise<AuthorityState> {
	return (await authority(h).fetch(new Request("https://task-authority/state"))).json();
}

/** A task on `canonical`, one contender forked and credentialed. */
async function makeHarness(): Promise<Harness> {
	const fake = new FakeArtifacts();
	await fake.create("canonical");
	const baseline = await fake.adminPush({ repo: "canonical", ref: "main", tree: BASELINE_TREE, message: "baseline" });
	const key = generateKeyPairSync("ed25519");
	const h = {
		fake,
		baseline,
		pinnedKeyDerHex: parseTrustedKey(key.publicKey.export({ type: "spki", format: "pem" }).toString()),
		containerAnswer: null,
		containerCalls: [],
	} as unknown as Harness;
	const repoOf = (remote: string) => remote.replace(/^fake:\/\//, "");
	h.env = {
		ARTIFACTS: fake,
		TASK_AUTHORITY: memoryNamespace(
			(state) =>
				new TaskAuthority(state as never, {
					AUTHORITY_SIGNING_KEY: key.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
				}),
		),
		PROMOTION_CONTAINER: memoryNamespace(() => ({
			async fetch(request: Request) {
				const body = (await request.json()) as any;
				h.containerCalls.push(body);
				if (h.containerAnswer) return h.containerAnswer(body);
				if (body.action === "rebase") {
					const r = await fakeRebase(fake, {
						fork: repoOf(body.fork_remote),
						destination: repoOf(body.destination_remote),
						candidate_sha: body.candidate_sha,
						onto: body.onto,
					});
					return json(r.body, r.status);
				}
				if (body.action === undefined) {
					const r = await fakePromote(fake, {
						source: repoOf(body.source_remote),
						destination: repoOf(body.destination_remote),
						candidate_sha: body.candidate_sha,
						expected_head: body.expected_destination_head,
						winning_tree_sha256: body.winning_tree_sha256,
					});
					return json(r.body, r.status);
				}
				throw new Error(`unexpected container action ${body.action}`);
			},
		})),
		CONTROL_SERVICE_TOKEN: TOKENS.control,
		AGENT_SERVICE_TOKEN: TOKENS.agent,
		EVALUATION_SERVICE_TOKEN: TOKENS.evaluation,
	};
	const created = await call(h, "POST", "/tasks", {
		token: TOKENS.control,
		body: { intent: "rebase when the destination moves", baseline_repo: "canonical", baseline_commit: baseline, agent_ids: ["agent-a"] },
	});
	assert.equal(created.status, 201, JSON.stringify(created.body));
	h.taskId = created.body.task_id;
	const secret = created.body.agent_secrets["agent-a"];
	const claimed = await call(h, "POST", `/tasks/${h.taskId}/claim`, {
		token: TOKENS.agent,
		secret,
		body: {
			claim: {
				agent: "agent-a",
				task: created.body.task_hash,
				baseline,
				intent: { behavior: ["fix isExpired"] },
				scope: { paths: ["src/**"], symbols: [] },
				contracts: { reads: [], modifies: [] },
				interfaces: [],
				schema_changes: [],
				expected_tests: [],
				lease: { claimed_at: "2026-10-03T09:00:00Z", expires_at: "2026-10-03T10:00:00Z" },
			},
		},
	});
	assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
	const contender = await call(h, "POST", `/tasks/${h.taskId}/contenders`, { token: TOKENS.agent, secret, body: {} });
	assert.equal(contender.status, 201, JSON.stringify(contender.body));
	h.contenderId = contender.body.contender_id;
	h.forkRepo = contender.body.fork_repo;
	h.forkToken = contender.body.token;
	assert.equal((await authorityState(h)).contenders[h.contenderId].fork_base, baseline, "the fork base is the task baseline");
	return h;
}

/** The contender pushes `tree` on top of `parent`, and the push reaches the authority. */
async function push(h: Harness, tree: Record<string, string>, parent: string): Promise<string> {
	const sha = await h.fake.pushAsToken({ repo: h.forkRepo, ref: "main", tree, message: "contender: fix", parents: [parent], token: h.forkToken });
	await observe(h, parent, sha);
	return sha;
}

async function observe(h: Harness, before: string, after: string): Promise<void> {
	const res = await authority(h).fetch(
		new Request("https://task-authority/event", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ event: { namespace: "rebase-route", repo: h.forkRepo, ref: "refs/heads/main", before, after } }),
		}),
	);
	assert.equal(res.status, 200);
}

/** Evidence from the evaluation domain for the contender's `sha`. */
async function evidence(h: Harness, sha: string, evaluated_at: string): Promise<void> {
	const tree = h.fake.readCommitObject(h.forkRepo, sha)!.tree;
	const rest = {
		candidate_sha: sha,
		tree_sha256: await treeDigestOfFiles(tree),
		contender_id: h.contenderId,
		task_hash: (await authorityState(h)).task.task_hash,
		admission: { exact_baseline: true, scope_compliance: true, valid_tool_states: true, no_eval_tampering: true, provenance_complete: true },
		hidden_oracle: { passed: true, total: 1, failed: [] as string[] },
		regressions: { passed: true, total: 1, failed: [] as string[] },
		static_analysis: { passed: true, findings: [] as string[] },
		semantic_checks: { passed: true, total: 1, failed: [] as string[] },
		security_policy: { passed: true, findings: [] as string[] },
		evaluated_at,
		tainted: false,
	};
	const bundle = { ...rest, bundle_hash: await sha256Hex(canonicalJson(rest)) };
	const res = await call(h, "POST", `/tasks/${h.taskId}/evidence`, { token: TOKENS.evaluation, body: { bundle } });
	assert.equal(res.status, 200, JSON.stringify(res.body));
}

function verdict(h: Harness, sha: string) {
	return call(h, "POST", `/tasks/${h.taskId}/verdict`, {
		token: TOKENS.control,
		body: {
			candidates: [{ contender_id: h.contenderId, candidate_sha: sha, blast_radius: 1, change_surface: 1 }],
			destination_repo: "canonical",
		},
	});
}

async function moveDestination(h: Harness, tree: Record<string, string>): Promise<string> {
	return h.fake.adminPush({ repo: "canonical", ref: "main", tree, message: "concurrent merge", parents: [h.baseline] });
}

describe("the destination moved after the candidate was reviewed", () => {
	it("verdict → 409 REBASE_REQUIRED; /rebase → a new SHA, evaluated again; its permit at the new head PROMOTES with base and parent", async () => {
		const h = await makeHarness();
		const X = await push(h, FIXED_TREE, h.baseline);
		await evidence(h, X, "2026-10-03T09:10:00Z");
		const H2 = await moveDestination(h, { ...BASELINE_TREE, "docs/usage.md": "# Usage\n" });

		const refused = await verdict(h, X);
		assert.equal(refused.status, 409, JSON.stringify(refused.body));
		assert.equal(refused.body.verdict.state, "ACCEPT");
		assert.equal(refused.body.permit, null);
		assert.equal(refused.body.outcome, "REBASE_REQUIRED");
		assert.equal(refused.body.destination_head, H2);
		assert.deepEqual(refused.body.bases, [h.baseline]);
		assert.deepEqual(Object.keys((await authorityState(h)).permits), [], "no permit exists");

		const forkTokensBefore = (await (await h.fake.get(h.forkRepo)).listTokens()).length;
		const rebased = await call(h, "POST", `/tasks/${h.taskId}/rebase`, {
			token: TOKENS.control,
			body: { contender_id: h.contenderId, destination_repo: "canonical" },
		});
		assert.equal(rebased.status, 200, JSON.stringify(rebased.body));
		assert.equal(rebased.body.outcome, "REBASED");
		assert.equal(rebased.body.onto, H2);
		assert.equal(rebased.body.candidate_sha, X);
		assert.equal(rebased.body.authority, "RECORDED");
		const X2 = rebased.body.rebased_sha;
		assert.notEqual(X2, X, "the rebase makes a new SHA");
		assert.equal(await (await h.fake.get(h.forkRepo)).getHead(), X2, "pushed to the contender's fork");
		assert.equal(await (await h.fake.get("canonical")).getHead(), H2, "nothing written to the destination");
		const forkTokens = await (await h.fake.get(h.forkRepo)).listTokens();
		assert.equal(forkTokens.length, forkTokensBefore + 1, "one fork write token minted for the rebase");
		assert.equal(forkTokens.at(-1)?.state, "revoked", "and revoked when it finished");
		assert.equal(h.containerCalls.at(-1).action, "rebase");

		let state = await authorityState(h);
		assert.equal(state.contenders[h.contenderId].latest_commit, X2, "the rebased commit re-enters evaluation");
		assert.deepEqual(
			state.contenders[h.contenderId].rebases?.map((r) => [r.outcome, r.from_sha, r.onto, r.new_sha]),
			[["REBASED", X, H2, X2]],
		);
		assert.equal(state.evaluations[X2], undefined, "no evidence yet for the new SHA");

		await observe(h, X, X2); // the rebase's push, as the queue delivers it
		await evidence(h, X2, "2026-10-03T09:20:00Z");
		const issued = await verdict(h, X2);
		assert.equal(issued.status, 200, JSON.stringify(issued.body));
		assert.equal(issued.body.outcome, "ISSUED");
		assert.equal(issued.body.permit.winner_candidate_sha, X2);
		assert.equal(issued.body.permit.expected_destination_head, H2);

		const promoted = await call(h, "POST", `/tasks/${h.taskId}/promote`, { token: TOKENS.control, body: { permit_id: issued.body.permit.permit_id } });
		assert.equal(promoted.status, 200, JSON.stringify(promoted.body));
		assert.equal(promoted.body.outcome, "PROMOTED");
		assert.equal(promoted.body.promoted_sha, X2);
		assert.equal(await (await h.fake.get("canonical")).getHead(), X2, "fast-forwarded to the rebased commit");

		state = await authorityState(h);
		assert.equal(state.permits[issued.body.permit.permit_id].consumed, true);
		const bundle = (await call(h, "GET", `/tasks/${h.taskId}/bundle`, { token: TOKENS.control })).body;
		assert.equal(bundle.version, 3);
		assert.deepEqual([bundle.ship.commit, bundle.ship.base, bundle.ship.parent], [X2, H2, H2]);
		const verified = await verifyWithTrustedKey(bundle, h.pinnedKeyDerHex);
		assert.equal(verified.verified, true, JSON.stringify(verified.lines));
		assert.equal(verified.lines.find((l) => l.label === "destination base")?.status, "OK");
	});

	it("/rebase CONFLICT → 409 with the paths; the task is escalated with the paths as data; nothing is pushed", async () => {
		const h = await makeHarness();
		const X = await push(h, { ...FIXED_TREE, "README.md": "acme api (contender)\n" }, h.baseline);
		await evidence(h, X, "2026-10-03T09:10:00Z");
		await moveDestination(h, { ...BASELINE_TREE, "README.md": "acme api (destination)\n" });

		const res = await call(h, "POST", `/tasks/${h.taskId}/rebase`, {
			token: TOKENS.control,
			body: { contender_id: h.contenderId, destination_repo: "canonical" },
		});
		assert.equal(res.status, 409, JSON.stringify(res.body));
		assert.equal(res.body.outcome, "CONFLICT");
		assert.deepEqual(res.body.paths, ["README.md"]);
		assert.equal(res.body.authority, "ESCALATED");
		assert.equal(await (await h.fake.get(h.forkRepo)).getHead(), X, "the fork is unchanged");

		const state = await authorityState(h);
		assert.equal(state.task_status, "escalated");
		const escalation = state.escalations.at(-1)!;
		assert.deepEqual(escalation.data, {
			kind: "rebase_conflict",
			contender_id: h.contenderId,
			candidate_sha: X,
			onto: res.body.onto,
			paths: ["README.md"],
			paths_total: 1,
		});
		assert.ok(!escalation.reason.includes("README.md"));
		assert.equal(state.contenders[h.contenderId].rebases, undefined, "a conflict records no ancestry");
	});

	it("/rebase refuses a quarantined contender and needs the control plane", async () => {
		const h = await makeHarness();
		const X = await push(h, FIXED_TREE, h.baseline);
		const anon = await call(h, "POST", `/tasks/${h.taskId}/rebase`, {
			token: TOKENS.agent,
			body: { contender_id: h.contenderId, destination_repo: "canonical" },
		});
		assert.equal(anon.status, 401);
		await evidence(h, X, "2026-10-03T09:10:00Z");
		// Evidence naming a changed evaluation file quarantines the contender.
		const tampered = await h.fake.pushAsToken({
			repo: h.forkRepo,
			ref: "main",
			tree: { ...FIXED_TREE, "test/a.test.js": "process.exit(0)\n" },
			message: "tamper",
			parents: [X],
			token: h.forkToken,
		});
		await observe(h, X, tampered);
		const tree = h.fake.readCommitObject(h.forkRepo, tampered)!.tree;
		const rest = {
			candidate_sha: tampered,
			tree_sha256: await treeDigestOfFiles(tree),
			contender_id: h.contenderId,
			task_hash: (await authorityState(h)).task.task_hash,
			admission: { exact_baseline: true, scope_compliance: true, valid_tool_states: true, no_eval_tampering: false, provenance_complete: true },
			hidden_oracle: { passed: true, total: 1, failed: [] as string[] },
			regressions: { passed: true, total: 1, failed: [] as string[] },
			static_analysis: { passed: true, findings: [] as string[] },
			semantic_checks: { passed: true, total: 1, failed: [] as string[] },
			security_policy: { passed: true, findings: [] as string[] },
			evaluated_at: "2026-10-03T09:30:00Z",
			tainted: false,
			eval_file_changes: ["test/a.test.js"],
		};
		const bundle = { ...rest, bundle_hash: await sha256Hex(canonicalJson(rest)) };
		assert.equal((await call(h, "POST", `/tasks/${h.taskId}/evidence`, { token: TOKENS.evaluation, body: { bundle } })).status, 200);
		const calls = h.containerCalls.length;
		const res = await call(h, "POST", `/tasks/${h.taskId}/rebase`, {
			token: TOKENS.control,
			body: { contender_id: h.contenderId, destination_repo: "canonical" },
		});
		assert.equal(res.status, 409);
		assert.equal(res.body.error, "contender_quarantined");
		assert.equal(h.containerCalls.length, calls, "the container is never asked");
	});
});

describe("promote: the container's answers", () => {
	async function issuedPermit() {
		const h = await makeHarness();
		const X = await push(h, FIXED_TREE, h.baseline);
		await evidence(h, X, "2026-10-03T09:10:00Z");
		const issued = await verdict(h, X);
		assert.equal(issued.status, 200, JSON.stringify(issued.body));
		return { h, X, permit: issued.body.permit };
	}

	for (const [outcome, exit] of [
		["PUSH_REJECTED", 44],
		["UNSUPPORTED_TREE_ENTRY", 46],
	] as const) {
		it(`a terminal ${outcome} (promote.sh exit ${exit}) is a 409 the PromotionWorkflow does not retry; the permit stays unconsumed`, async () => {
			const { h, permit } = await issuedPermit();
			h.containerAnswer = async () => json({ outcome }, 409);
			const res = await call(h, "POST", `/tasks/${h.taskId}/promote`, { token: TOKENS.control, body: { permit_id: permit.permit_id } });
			assert.equal(res.status, 409);
			assert.equal(res.body.outcome, outcome);
			assert.equal((await authorityState(h)).permits[permit.permit_id].consumed, false);

			const workflow = new PromotionWorkflow({} as never, h.env as never) as any;
			workflow.env = h.env;
			const steps: string[] = [];
			const result = await workflow.run(
				{ payload: { task_id: h.taskId, permit_id: permit.permit_id } },
				{ do: async (name: string, fn: () => Promise<unknown>) => (steps.push(name), fn()) },
			);
			assert.equal(result.status, 409, "returned, not thrown: Workflows retry only a thrown step");
			assert.equal(JSON.parse(result.body).outcome, outcome);
			assert.deepEqual(steps, [`promote/${permit.permit_id}`]);
		});
	}

	it("a git failure is a 502 the PromotionWorkflow retries", async () => {
		const { h, permit } = await issuedPermit();
		h.containerAnswer = async () => json({ outcome: "GIT_ERROR", detail: "fatal: unable to access" }, 502);
		const res = await call(h, "POST", `/tasks/${h.taskId}/promote`, { token: TOKENS.control, body: { permit_id: permit.permit_id } });
		assert.equal(res.status, 502);
		const workflow = new PromotionWorkflow({} as never, h.env as never) as any;
		workflow.env = h.env;
		await assert.rejects(
			workflow.run({ payload: { task_id: h.taskId, permit_id: permit.permit_id } }, { do: (_n: string, fn: () => Promise<unknown>) => fn() }),
			/transient/,
		);
	});

	it("a PROMOTED answer whose base or commit is not the permit's is not finalized", async () => {
		const { h, X, permit } = await issuedPermit();
		const good = { outcome: "PROMOTED", promoted_sha: X, tree_sha256: permit.winning_tree_sha256, base: permit.expected_destination_head, parent: h.baseline };
		for (const bad of [{ ...good, base: "f".repeat(64) }, { ...good, promoted_sha: "e".repeat(64) }, { ...good, parent: undefined }]) {
			h.containerAnswer = async () => json(bad, 200);
			const res = await call(h, "POST", `/tasks/${h.taskId}/promote`, { token: TOKENS.control, body: { permit_id: permit.permit_id } });
			assert.equal(res.status, 502, JSON.stringify(bad));
			assert.equal(res.body.error, "promotion_container_invalid_result");
		}
		assert.equal((await authorityState(h)).permits[permit.permit_id].consumed, false);
		// The real fast-forward then promotes; the ship's parent comes from the commit.
		h.containerAnswer = null;
		const res = await call(h, "POST", `/tasks/${h.taskId}/promote`, { token: TOKENS.control, body: { permit_id: permit.permit_id } });
		assert.equal(res.status, 200, JSON.stringify(res.body));
		const bundle = (await call(h, "GET", `/tasks/${h.taskId}/bundle`, { token: TOKENS.control })).body;
		assert.deepEqual([bundle.ship.commit, bundle.ship.base, bundle.ship.parent], [X, h.baseline, h.baseline]);
	});
});
