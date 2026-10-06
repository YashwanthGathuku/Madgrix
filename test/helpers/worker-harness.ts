/**
 * Shared harness for tests that drive the real Worker router
 * (src/worker/index.ts) and real TaskAuthority Durable Objects on in-memory
 * storage over FakeArtifacts.
 *
 * - PROMOTION_CONTAINER runs the container's procedures over the same
 *   FakeArtifacts repositories (src/harness/fake-container.ts), unless a test
 *   sets `containerAnswer`.
 * - PROMOTION_WORKFLOW is a FakeWorkflow (./fake-workflow.ts) whose instances
 *   run the Worker's PromotionWorkflow class when a test calls drain().
 * - The Worker's only Workers-runtime import, `cloudflare:workers`, is mapped
 *   to a stub whose WorkflowEntrypoint keeps `ctx` and `env`, as the real one
 *   does.
 */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { registerHooks } from "node:module";

import { TaskAuthority } from "../../src/do/TaskAuthority.ts";
import { canonicalJson, sha256Hex } from "../../src/lib/canonical.ts";
import { assumeCompleteMergeArtifactScan } from "../../src/lib/merge-artifacts.ts";
import { FakeArtifacts } from "../../src/lib/fake-artifacts.ts";
import { treeDigestOfFiles } from "../../src/lib/tree-digest.ts";
import { fakePromote, fakeRebase } from "../../src/harness/fake-container.ts";
import { parseTrustedKey } from "../../src/cli/verify.ts";
import type { AuthorityState } from "../../src/lib/types.ts";
import { FakeWorkflow } from "./fake-workflow.ts";

const WORKERS_STUB = `data:text/javascript,${encodeURIComponent(
	"export class WorkflowEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
)}`;
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "cloudflare:workers") return { url: WORKERS_STUB, shortCircuit: true };
		return nextResolve(specifier, context);
	},
});
export const worker = await import("../../src/worker/index.ts");

export const TOKENS = {
	control: "control-service-token-0001",
	agent: "agent-service-token-0002",
	evaluation: "evaluation-service-token-0003",
};

export function memoryNamespace(make: (state: unknown) => { fetch(r: Request): Promise<Response> }) {
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

export function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

export const BASELINE_TREE = { "README.md": "acme api\n", "src/a.js": "export const isExpired = (exp, now) => exp < now;\n" };
export const FIXED_TREE = { ...BASELINE_TREE, "src/a.js": "export const isExpired = (exp, now) => exp <= now;\n" };

export interface Harness {
	fake: FakeArtifacts;
	env: Record<string, any>;
	workflow: FakeWorkflow;
	taskId: string;
	taskHash: string;
	baseline: string;
	contenderId: string;
	forkRepo: string;
	forkToken: string;
	pinnedKeyDerHex: string;
	/** Replace the container's answers; null: run the container model. */
	containerAnswer: ((body: any) => Promise<Response>) | null;
	containerCalls: any[];
}

export interface Reply {
	status: number;
	contentType: string | null;
	body: any;
}

export async function call(
	h: Pick<Harness, "env">,
	method: string,
	path: string,
	opts: { token?: string; secret?: string; body?: unknown; contentType?: string } = {},
): Promise<Reply> {
	const headers: Record<string, string> = { "content-type": opts.contentType ?? "application/json" };
	if (opts.token) headers.authorization = `Bearer ${opts.token}`;
	if (opts.secret) headers["x-madgrix-agent-secret"] = opts.secret;
	const res = await worker.fetch(
		new Request(`https://madgrix.test${path}`, {
			method,
			headers,
			body: opts.body === undefined ? undefined : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body),
		}),
		h.env as never,
	);
	const contentType = res.headers.get("content-type");
	return { status: res.status, contentType, body: await res.json() };
}

export function authority(h: Pick<Harness, "env" | "taskId">) {
	return h.env.TASK_AUTHORITY.get(h.env.TASK_AUTHORITY.idFromName(h.taskId));
}

export async function authorityState(h: Pick<Harness, "env" | "taskId">): Promise<AuthorityState> {
	return (await authority(h).fetch(new Request("https://task-authority/state"))).json();
}

/**
 * A task on `canonical` (baseline BASELINE_TREE) with agent-a's claim, and no
 * contender yet. `fake` replaces the Artifacts stand-in (a subclass that fails
 * the way the platform can). Returns agent-a's enrollment secret.
 */
export async function makeTask(fake: FakeArtifacts = new FakeArtifacts()): Promise<{ h: Harness; secret: string }> {
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
	h.workflow = new FakeWorkflow(() => new worker.PromotionWorkflow({} as never, h.env as never) as never);
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
		PROMOTION_WORKFLOW: h.workflow,
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
	h.taskHash = created.body.task_hash;
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
	return { h, secret };
}

/** POST /tasks/:id/contenders as agent-a. */
export function createContender(h: Harness, secret: string): Promise<Reply> {
	return call(h, "POST", `/tasks/${h.taskId}/contenders`, { token: TOKENS.agent, secret, body: {} });
}

/** A task on `canonical`, one contender forked and credentialed. */
export async function makeHarness(): Promise<Harness> {
	const { h, secret } = await makeTask();
	const contender = await createContender(h, secret);
	assert.equal(contender.status, 201, JSON.stringify(contender.body));
	h.contenderId = contender.body.contender_id;
	h.forkRepo = contender.body.fork_repo;
	h.forkToken = contender.body.token;
	assert.equal((await authorityState(h)).contenders[h.contenderId].fork_base, h.baseline, "the fork base is the task baseline");
	return h;
}

/** The contender pushes `tree` on top of `parent`, and the push reaches the authority. */
export async function push(h: Harness, tree: Record<string, string>, parent: string): Promise<string> {
	const sha = await h.fake.pushAsToken({ repo: h.forkRepo, ref: "main", tree, message: "contender: fix", parents: [parent], token: h.forkToken });
	await observe(h, parent, sha);
	return sha;
}

export async function observe(h: Harness, before: string, after: string): Promise<void> {
	const res = await authority(h).fetch(
		new Request("https://task-authority/event", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ event: { namespace: "worker-harness", repo: h.forkRepo, ref: "refs/heads/main", before, after } }),
		}),
	);
	assert.equal(res.status, 200);
}

/** Evidence from the evaluation domain for the contender's `sha`. */
export async function evidence(h: Harness, sha: string, evaluated_at: string, extra: Record<string, unknown> = {}): Promise<Reply> {
	const tree = h.fake.readCommitObject(h.forkRepo, sha)!.tree;
	const rest = {
		candidate_sha: sha,
		tree_sha256: await treeDigestOfFiles(tree),
		contender_id: h.contenderId,
		task_hash: h.taskHash,
		admission: { exact_baseline: true, scope_compliance: true, valid_tool_states: true, no_eval_tampering: true, provenance_complete: true },
		hidden_oracle: { passed: true, total: 1, failed: [] as string[] },
		regressions: { passed: true, total: 1, failed: [] as string[] },
		static_analysis: { passed: true, findings: [] as string[] },
		semantic_checks: { passed: true, total: 1, failed: [] as string[] },
		security_policy: { passed: true, findings: [] as string[] },
		evaluated_at,
		tainted: false,
		...extra,
	};
	const scanned = assumeCompleteMergeArtifactScan(rest);
	const bundle = { ...scanned, bundle_hash: await sha256Hex(canonicalJson(scanned)) };
	const res = await call(h, "POST", `/tasks/${h.taskId}/evidence`, { token: TOKENS.evaluation, body: { bundle } });
	assert.equal(res.status, 200, JSON.stringify(res.body));
	return res;
}

export function verdict(h: Harness, sha: string): Promise<Reply> {
	return call(h, "POST", `/tasks/${h.taskId}/verdict`, {
		token: TOKENS.control,
		body: {
			candidates: [{ contender_id: h.contenderId, candidate_sha: sha, blast_radius: 1, change_surface: 1 }],
			destination_repo: "canonical",
		},
	});
}

export async function moveDestination(h: Harness, tree: Record<string, string>): Promise<string> {
	return h.fake.adminPush({ repo: "canonical", ref: "main", tree, message: "concurrent merge", parents: [h.baseline] });
}

/** A contender candidate with an issued permit at the fork base. */
export async function issuedPermit(): Promise<{ h: Harness; X: string; permit: any }> {
	const h = await makeHarness();
	const X = await push(h, FIXED_TREE, h.baseline);
	await evidence(h, X, "2026-10-03T09:10:00Z");
	const issued = await verdict(h, X);
	assert.equal(issued.status, 200, JSON.stringify(issued.body));
	return { h, X, permit: issued.body.permit };
}
