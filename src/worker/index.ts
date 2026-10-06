/**
 * Worker entry point for MADGRIX.
 *
 * # What this file is
 *
 * The Cloudflare control plane: the HTTP routes, the Queue consumer, the
 * PromotionWorkflow, and the adapter from the Artifacts binding to
 * `ArtifactsPort`. cloudflare.config.ts wires it to Artifacts, the
 * `madgrix-events` queue, the TaskAuthority and PromotionContainer Durable
 * Objects, the `madgrix-promotion` Workflow and the three zone service tokens.
 *
 * Where it has run: the tests drive this module in Node with stand-ins
 * (FakeArtifacts for the binding, in-memory Durable Object storage, a model of
 * the promotion container's scripts, test/helpers/fake-workflow.ts for the
 * Workflow binding). Nothing in this repository runs it on Cloudflare;
 * scripts/live-e2e.ts is the real-infrastructure path and fails unless real
 * Artifacts push events reach Queue → TaskAuthority.
 *
 * # Architecture (spec 5)
 *
 * - Ingestion: Queue (at-least-once, unordered) → `queue()` → per-task
 *   Durable Object (`TaskAuthority`) via POST /event → `event_key` dedupe →
 *   authoritative state transition → `Effect[]` RETURNED (never executed by
 *   the DO) → executed here by `executeEffects`.
 * - `Env.ARTIFACTS` is the `ArtifactsPort` abstraction. `productionPort()`
 *   adapts the raw runtime value ONCE at the edge: the real binding in
 *   production (`BindingArtifactsPort`), a `FakeArtifacts` in the local
 *   harness (which already implements the port).
 * - Zone credentials (spec 3 §5): `issueContenderCredentials` (WRITE, own
 *   fork only, ≤1h), `issueEvaluatorCredentials` (READ, per-evaluation),
 *   verifiers get NONE.
 * - The promotion service is the ONLY canonical writer (spec 3 §2).
 *   POST /tasks/:id/promote starts the permit's PromotionWorkflow instance
 *   (instance id = permit id, spec 5 §5) and answers 202; GET
 *   /tasks/:id/promotions/:permit_id reports it. The instance's step runs
 *   `runPromotion`, which performs the platform-owned preconditions (permit
 *   lookup, consumed check, quarantine check, permit-id recompute, evidence
 *   check) and mints five-minute repo-scoped tokens; the canonical write
 *   itself is container/promote.sh in the trusted promotion container, which
 *   fast-forwards the destination to the reviewed commit (spec 5 §7;
 *   specs/amendments/rebase-ancestry-v1.md). `/rebase` replays a candidate
 *   onto a moved destination head with container/rebase.sh and pushes the
 *   new commit to the contender's fork, never to the destination.
 * - Every answer is JSON, and a Durable Object's answer is parsed only after
 *   its content-type says it is JSON (specs/amendments/promotion-runtime-v1.md).
 *
 * No credentials in code or logs. No network calls from this module beyond
 * the platform's own RPCs. Plaintext tokens are returned once in a response
 * body and never logged.
 */

import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";

import type {
	ArtifactsPort,
	ArtifactsRepo,
	CommitMetadata,
	CreateRepoResult,
	CreateTokenResult,
	RepoListResult,
	TokenInfo,
	TokenScope,
} from "../lib/artifacts-port.ts";
import { forkIdempotent } from "../lib/artifacts-port.ts";
import type { SimulatedGit } from "../lib/artifacts-port.ts";
import { FakeArtifacts } from "../lib/fake-artifacts.ts";
import { joinHashParts, randomHex, sha256Hex } from "../lib/canonical.ts";
import { contenderRepoName, normalizeArtifactQueueBody } from "../lib/artifact-events.ts";
import type {
	AuthorityState,
	ContenderRecord,
	EvaluationBundle,
	PermitRecord,
	PromotionOutcome,
	QueuePushEvent,
	TaskRecord,
	WorkClaim,
} from "../lib/types.ts";
import { SELECTOR_POLICY_VERSION } from "../lib/types.ts";
import { compositionBlocks } from "../lib/task-state.ts";
import { buildWorkGraph } from "../lib/work-graph.ts";
import type { Effect } from "../lib/task-state.ts";
import { mergeArtifactAdmissionRefuses } from "../lib/merge-artifacts.ts";
import { AGENT_ID_PATTERN, evaluationBases, resolveAgentBySecret, taskHashFor, type RebaseReport } from "../lib/task-state.ts";
import type { PromotionResult, RebaseResult } from "../lib/git-promotion.ts";
import { computePermitId, TaskAuthority } from "../do/TaskAuthority.ts";
import { PromotionContainer } from "../do/PromotionContainer.ts";

/** Re-exported so the runtime can register the Durable Object class from
 *  the entry module (classic DO wiring). */
export { TaskAuthority, PromotionContainer };

/* ------------------------------------------------------------------ */
/* Small HTTP helpers                                                  */
/* ------------------------------------------------------------------ */

function json(data: unknown, status: number = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/** `application/json` or `application/*+json`, with or without parameters. */
function isJsonContentType(value: string | null): boolean {
	return value !== null && /^application\/(?:[\w.+-]+\+)?json\s*(?:;|$)/i.test(value.trim());
}

/**
 * Every request body is JSON: a body sent as anything else is 415 before it
 * is parsed, and a body that does not parse is 400
 * (specs/amendments/promotion-runtime-v1.md).
 */
async function readJsonBody(
	request: Request,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: Response }> {
	if (!isJsonContentType(request.headers.get("content-type"))) {
		return { ok: false, response: json({ error: "content_type_must_be_json" }, 415) };
	}
	try {
		const body = (await request.json()) as Record<string, unknown>;
		return { ok: true, body };
	} catch {
		return { ok: false, response: json({ error: "invalid_json" }, 400) };
	}
}

/**
 * A Durable Object answered something that is not JSON (the runtime's own
 * error page, say). The router answers it as a 502 `upstream_not_json`.
 */
class UpstreamNotJsonError extends Error {
	readonly upstream: string;
	readonly upstreamStatus: number;
	constructor(upstream: string, upstreamStatus: number) {
		super(`upstream_not_json: ${upstream} answered HTTP ${upstreamStatus} without a JSON body`);
		this.upstream = upstream;
		this.upstreamStatus = upstreamStatus;
	}
}

/**
 * Read a Durable Object's answer. Its content-type is checked first: .json()
 * is only called on a JSON answer; anything else throws UpstreamNotJsonError
 * (as does a JSON answer that does not parse).
 */
async function readUpstreamJson(
	res: Response,
	upstream: "task_authority" | "promotion_container",
): Promise<{ ok: boolean; status: number; body: unknown }> {
	if (!isJsonContentType(res.headers.get("content-type"))) {
		await res.body?.cancel().catch(() => undefined);
		throw new UpstreamNotJsonError(upstream, res.status);
	}
	try {
		return { ok: res.ok, status: res.status, body: await res.json() };
	} catch {
		throw new UpstreamNotJsonError(upstream, res.status);
	}
}

function taskStub(env: Env, taskId: string): DoStub {
	const ns = env.TASK_AUTHORITY;
	return ns.get(ns.idFromName(taskId));
}

function promotionStub(env: Env, permitId: string): DoStub {
	const ns = env.PROMOTION_CONTAINER;
	return ns.get(ns.idFromName(permitId));
}

/** An RPC to a task authority. Throws UpstreamNotJsonError if the answer is not JSON. */
async function doRpc(
	stub: DoStub,
	path: string,
	init?: { method?: string; body?: unknown },
): Promise<{ ok: boolean; status: number; body: unknown }> {
	const res = await stub.fetch(
		new Request(`https://task-authority${path}`, {
			method: init?.method ?? "POST",
			headers: { "content-type": "application/json" },
			body: init?.body === undefined ? undefined : JSON.stringify(init.body),
		}),
	);
	return readUpstreamJson(res, "task_authority");
}

/** A request to a promotion container. Throws UpstreamNotJsonError if the answer is not JSON. */
async function containerRpc(
	stub: DoStub,
	path: string,
	body: unknown,
): Promise<{ ok: boolean; status: number; body: unknown }> {
	const res = await stub.fetch(
		new Request(`https://promotion${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
	);
	return readUpstreamJson(res, "promotion_container");
}

/** The task authority's state, or the answer for a request that cannot have it. */
type TaskStateRead = { ok: true; state: AuthorityState } | { ok: false; status: number; body: Record<string, unknown> };

/**
 * Read the task authority's state. Only its 404 means there is no such task;
 * any other failure (a storage outage is its JSON 500) is 502
 * `task_authority_failed`, which the PromotionWorkflow step retries.
 */
async function readTaskState(env: Env, taskId: string): Promise<TaskStateRead> {
	const res = await doRpc(taskStub(env, taskId), "/state", { method: "GET" });
	if (res.ok) return { ok: true, state: res.body as AuthorityState };
	if (res.status === 404) return { ok: false, status: 404, body: { error: "task_not_found", task_id: taskId } };
	return {
		ok: false,
		status: 502,
		body: { error: "task_authority_failed", task_id: taskId, upstream_status: res.status, detail: res.body },
	};
}

/* ------------------------------------------------------------------ */
/* Production port adapter: real binding → ArtifactsPort               */
/* ------------------------------------------------------------------ */

/**
 * Structural mirror of the REAL generated binding types
 * (`Artifacts` / `ArtifactsRepo` in workerd types). Written out explicitly
 * because @cloudflare/workers-types is not vendored here; production
 * replaces this with the real imported types.
 */
interface RealTokenResult {
	id: string;
	plaintext: string;
	scope: "read" | "write";
	expiresAt: string;
}
interface RealTokenMeta {
	id: string;
	scope: "read" | "write";
	state: "active" | "expired" | "revoked";
	createdAt: string;
	expiresAt: string;
}
interface RealCommitMeta {
	hash: string;
	treeHash: string;
	parents: string[];
	message: string;
}
interface RealArtifactsRepoBinding {
	fork(
		name: string,
		opts?: { description?: string; readOnly?: boolean; defaultBranchOnly?: boolean },
	): Promise<{ name: string; remote: string; token: string }>;
	createToken(scope?: "read" | "write", ttl?: number): Promise<RealTokenResult>;
	revokeToken(tokenOrId: string): Promise<boolean>;
	listTokens(): Promise<{ tokens: RealTokenMeta[]; total: number }>;
	log(opts?: { ref?: string; limit?: number; offset?: number }): Promise<RealCommitMeta[]>;
	readCommit(hash: string): Promise<RealCommitMeta | null>;
	info(): Promise<{ name: string; remote: string; defaultBranch: string }>;
}
interface RealArtifactsBinding {
	create(
		name: string,
		opts?: { readOnly?: boolean; description?: string; setDefaultBranch?: string },
	): Promise<{ name: string; remote: string; token: string }>;
	get(name: string): Promise<RealArtifactsRepoBinding>;
	list(opts?: {
		limit?: number;
		cursor?: string;
	}): Promise<{
		repos: Array<{ name: string; defaultBranch: string; createdAt: string; lastPushAt: string | null }>;
		total: number;
		cursor?: string;
	}>;
	delete(name: string): Promise<boolean>;
}

class BindingRepo {
	private binding: RealArtifactsRepoBinding;
	private repoName: string;
	private repoRemote: string;

	constructor(binding: RealArtifactsRepoBinding, name: string, remote: string) {
		this.binding = binding;
		this.repoName = name;
		this.repoRemote = remote;
	}

	get name(): string {
		return this.repoName;
	}
	get remote(): string {
		return this.repoRemote;
	}

	async fork(
		name: string,
		opts?: { description?: string; readOnly?: boolean; defaultBranchOnly?: boolean },
	): Promise<CreateRepoResult> {
		const r = await this.binding.fork(name, opts);
		return { name: r.name, remote: r.remote, tokenPlaintext: r.token };
	}

	async createToken(scope: TokenScope = "write", ttl: number = 86400): Promise<CreateTokenResult> {
		const t = await this.binding.createToken(scope, ttl);
		return { id: t.id, plaintext: t.plaintext, scope: t.scope, expiresAt: t.expiresAt };
	}

	revokeToken(tokenOrId: string): Promise<boolean> {
		return this.binding.revokeToken(tokenOrId);
	}

	async listTokens(): Promise<TokenInfo[]> {
		const r = await this.binding.listTokens();
		return r.tokens.map((t) => ({
			id: t.id,
			scope: t.scope,
			state: t.state,
			createdAt: t.createdAt,
			expiresAt: t.expiresAt,
		}));
	}

	async log(opts?: { ref?: string; limit?: number; offset?: number }): Promise<CommitMetadata[]> {
		const entries = await this.binding.log(opts);
		// A just-created fork can answer log() with null instead of [] while
		// its ref is published. That is an empty history, not a thrown 500.
		if (!Array.isArray(entries)) return [];
		return entries.map((e) => ({
			hash: e.hash,
			treeHash: e.treeHash,
			parents: e.parents,
			message: e.message,
		}));
	}

	async readCommit(hash: string): Promise<CommitMetadata | null> {
		const e = await this.binding.readCommit(hash);
		if (!e) return null;
		return { hash: e.hash, treeHash: e.treeHash, parents: e.parents, message: e.message };
	}

}

/**
 * 1:1 pass-through adapter: real Artifacts binding → ArtifactsPort.
 * Every method maps to exactly one binding method (see ArtifactsPort JSDoc).
 */
class BindingArtifactsPort implements ArtifactsPort {
	private binding: RealArtifactsBinding;

	constructor(binding: RealArtifactsBinding) {
		this.binding = binding;
	}

	async create(
		name: string,
		opts?: { readOnly?: boolean; description?: string; setDefaultBranch?: string },
	): Promise<CreateRepoResult> {
		const r = await this.binding.create(name, opts);
		return { name: r.name, remote: r.remote, tokenPlaintext: r.token };
	}

	async get(name: string): Promise<ArtifactsRepo> {
		const b = await this.binding.get(name);
		const info = await b.info();
		// BindingRepo has no getHead. The Artifacts RPC repo does not either
		// (workerd types/defines/artifacts.d.ts). Callers use log() or readCommit().
		return new BindingRepo(b, info.name, info.remote) as unknown as ArtifactsRepo;
	}

	async list(opts?: { limit?: number; cursor?: string }): Promise<RepoListResult> {
		const r = await this.binding.list(opts);
		return {
			repos: r.repos.map((x) => ({
				name: x.name,
				defaultBranch: x.defaultBranch,
				createdAt: x.createdAt,
				lastPushAt: x.lastPushAt,
			})),
			total: r.total,
			cursor: r.cursor,
		};
	}

	delete(name: string): Promise<boolean> {
		return this.binding.delete(name);
	}
}

function isSimulatedGitPort(v: unknown): v is ArtifactsPort & SimulatedGit {
	// An Artifacts RPC stub reports every property access as a function,
	// including adminPush, which the binding does not implement. Probing
	// that name treated the real binding as FakeArtifacts, and the next
	// repo.getHead() was an RPC call. workerd's ArtifactsRepo has no
	// getHead; history is ArtifactsRepo.log().
	return v instanceof FakeArtifacts;
}

/**
 * Resolve the platform's ArtifactsPort from the raw runtime value, once at
 * the edge. Production: `env.ARTIFACTS` is the real binding → adapt it.
 * Local harness: `env.ARTIFACTS` is a `FakeArtifacts` → already a port.
 * (The declared `Env` type presents the port view; this function bridges
 * the declared type and the raw runtime value.)
 */
function productionPort(env: Env): ArtifactsPort {
	const raw: unknown = env.ARTIFACTS;
	if (isSimulatedGitPort(raw)) return raw;
	return new BindingArtifactsPort(raw as RealArtifactsBinding);
}

/* ------------------------------------------------------------------ */
/* Zone credential helpers (spec 3 §5 — credential matrix)             */
/* ------------------------------------------------------------------ */

/**
 * Contender credentials: WRITE scope, THE FORK ONLY, short-lived (v1 ≤ 1h),
 * minted at fork time. The contender MUST NOT hold any token for the
 * baseline repo or the canonical repo — enforced structurally: we only
 * ever mint on the fork handle.
 * Plaintext is returned once; never log or persist it.
 */
export async function issueContenderCredentials(
	port: ArtifactsPort,
	forkRepoName: string,
	ttlSeconds: number,
): Promise<CreateTokenResult> {
	if (!(ttlSeconds >= 1 && ttlSeconds <= 3600)) {
		throw new Error(`contender token TTL must be within (0, 3600]s (spec 3 §5); got ${ttlSeconds}`);
	}
	const fork = await port.get(forkRepoName);
	return fork.createToken("write", ttlSeconds);
}

/**
 * Evaluator credentials: READ scope on the candidate repo, per-evaluation
 * TTL. The evaluator gets NO write token of any kind (spec 3 §5). Binding
 * tokens are repo-scoped; candidate-SHA pinning is enforced by the
 * evaluation flow (readTreeAsToken / git fetch of the exact SHA), not by
 * the token itself.
 */
export async function issueEvaluatorCredentials(
	port: ArtifactsPort,
	candidateRepoName: string,
	ttlSeconds: number,
): Promise<CreateTokenResult> {
	const repo = await port.get(candidateRepoName);
	return repo.createToken("read", ttlSeconds);
}

/**
 * Verifiers (judges) get NO Git access at all (spec 3 §5: "Judge /
 * verifiers — NO Git access"). They read evidence, not repos. This function
 * exists so the "no credentials" rule is explicit in code rather than
 * implicit by omission.
 */
export function verifierCredentials(): null {
	return null;
}

async function constantTimeTokenEqual(a: string, b: string): Promise<boolean> {
	const enc = new TextEncoder();
	const [ha, hb] = await Promise.all([
		crypto.subtle.digest("SHA-256", enc.encode(a)),
		crypto.subtle.digest("SHA-256", enc.encode(b)),
	]);
	const aa = new Uint8Array(ha);
	const bb = new Uint8Array(hb);
	let diff = aa.length ^ bb.length;
	for (let i = 0; i < Math.min(aa.length, bb.length); i++) diff |= aa[i] ^ bb[i];
	return diff === 0;
}

async function requireBearer(request: Request, configured: string | undefined): Promise<boolean> {
	if (typeof configured !== "string" || configured.length < 16) return false;
	const auth = request.headers.get("authorization") ?? "";
	if (!auth.startsWith("Bearer ")) return false;
	return constantTimeTokenEqual(auth.slice(7), configured);
}

async function requireControlPlane(request: Request, env: Env): Promise<boolean> {
	return requireBearer(request, env.CONTROL_SERVICE_TOKEN);
}

async function requireAgentDomain(request: Request, env: Env): Promise<boolean> {
	return requireBearer(request, env.AGENT_SERVICE_TOKEN);
}

async function requireAgentOrControl(request: Request, env: Env): Promise<boolean> {
	return (await requireAgentDomain(request, env)) || (await requireControlPlane(request, env));
}

async function requireEvaluationDomain(request: Request, env: Env): Promise<boolean> {
	return requireBearer(request, env.EVALUATION_SERVICE_TOKEN);
}

/* ------------------------------------------------------------------ */
/* Route logic (also called by Workflow steps)                         */
/* ------------------------------------------------------------------ */

/** POST /tasks — freeze a task and seed its task authority. */
export async function handleCreateTask(env: Env, request: Request): Promise<Response> {
	if (!(await requireControlPlane(request, env))) return json({ error: "control_plane_auth_required" }, 401);
	const parsed = await readJsonBody(request);
	if (!parsed.ok) return parsed.response;
	const { intent, baseline_repo, baseline_commit, behavior_contract } = parsed.body;
	if (typeof intent !== "string" || intent === "") return json({ error: "intent_required" }, 400);
	if (typeof baseline_repo !== "string" || baseline_repo === "") {
		return json({ error: "baseline_repo_required" }, 400);
	}
	if (typeof baseline_commit !== "string" || baseline_commit === "") {
		return json({ error: "baseline_commit_required" }, 400);
	}
	const agent_ids = parsed.body["agent_ids"];
	if (!Array.isArray(agent_ids) || agent_ids.length === 0) return json({ error: "agent_ids_required" }, 400);
	if (
		!agent_ids.every((id): id is string => typeof id === "string" && AGENT_ID_PATTERN.test(id)) ||
		new Set(agent_ids).size !== agent_ids.length
	) {
		return json({ error: "invalid_agent_ids", detail: "distinct ids matching [A-Za-z0-9][A-Za-z0-9._-]{0,63}" }, 400);
	}

	const port = productionPort(env);
	let baselineRepo: ArtifactsRepo;
	try {
		baselineRepo = await port.get(baseline_repo);
	} catch {
		return json({ error: "baseline_repo_not_found", baseline_repo }, 404);
	}
	const baselineCommit = await baselineRepo.readCommit(baseline_commit);
	if (baselineCommit === null) {
		return json({ error: "baseline_commit_not_found", baseline_commit }, 404);
	}

	// Spec 1 §5 (FROZEN): freeze the task; task_hash = SHA256(canonical_json(task_record)).
	// The joinHashParts convention is NOT used here — it omits behavior_contract and
	// disagrees with the frozen spec; taskHashFor (src/lib/task-state.ts) is the
	// single conforming implementation.
	const frozen_at = new Date().toISOString();
	const policy_version = SELECTOR_POLICY_VERSION;
	const task_id = `task_${randomHex(12)}`;
	const task_record_fields = {
		intent,
		baseline_repo,
		baseline_commit,
		behavior_contract: typeof behavior_contract === "string" ? behavior_contract : "",
		policy_version,
		frozen_at,
	};
	const task_hash = await taskHashFor(task_record_fields, sha256Hex);
	const task: TaskRecord = {
		task_id,
		task_hash,
		...task_record_fields,
	};

	// Verifier + operator keys are registered at task freeze (spec 1 §8,
	// §9.4); the control plane supplies them with the create-task request
	// and the DO registers them immutably. Both are optional arrays; the
	// DO validates key material (fail closed on garbage).
	const verifier_keys = parsed.body["verifier_keys"];
	const operator_keys = parsed.body["operator_keys"];
	// Each agent gets its own secret here, from the control plane, so no
	// holder of the shared agent token can claim an agent id first
	// (specs/amendments/agent-enrollment-v1.md). The authority stores only
	// the hashes; the plaintexts are returned once, in this response.
	const agent_secrets: Record<string, string> = {};
	const agent_enrollment: Record<string, string> = {};
	for (const agent of agent_ids) {
		agent_secrets[agent] = randomHex(32);
		agent_enrollment[agent] = await sha256Hex(agent_secrets[agent]);
	}
	const res = await doRpc(taskStub(env, task_id), "/init", {
		body: { task, verifier_keys, operator_keys, agent_enrollment },
	});
	if (!res.ok) return json({ error: "authority_init_failed", detail: res.body }, 502);
	return json({ task_id, task_hash, frozen_at, agent_secrets }, 201);
}

/**
 * Per-agent secret header. Every agent shares AGENT_SERVICE_TOKEN; this
 * secret says WHICH agent is calling. POST /tasks issues one per enrolled
 * agent (specs/amendments/agent-enrollment-v1.md); a task initialized
 * without enrollment hands it out on the agent's first /claim
 * (specs/amendments/contender-agent-binding.md).
 */
const AGENT_SECRET_HEADER = "x-madgrix-agent-secret";

/** A claim as exposed outside the authority: without the secret's hash. */
function publicClaim(claim: WorkClaim): Omit<WorkClaim, "agent_secret_sha256"> {
	const { agent_secret_sha256: _hash, ...rest } = claim;
	return rest;
}

/**
 * POST /tasks/:id/claim — forward a WorkClaim to the task authority. Every
 * claim sends the agent's secret in X-Madgrix-Agent-Secret: the one POST
 * /tasks issued for that agent (an agent the task did not enroll gets 403).
 * On a task initialized without enrollment, the agent's first claim instead
 * returns a secret once (`agent_secret`).
 */
export async function handleClaim(env: Env, taskId: string, request: Request): Promise<Response> {
	if (!(await requireAgentOrControl(request, env))) return json({ error: "agent_auth_required" }, 401);
	const parsed = await readJsonBody(request);
	if (!parsed.ok) return parsed.response;
	// The contender supplies the claim INPUT (no work_id/status/version/
	// agent_secret_sha256 — the authority assigns those; see TaskAuthority
	// POST /claim and ClaimInput in claims.ts). The authority is the sole
	// validator of the full shape; the edge only does a light structural
	// check so malformed bodies fail fast.
	const claim = parsed.body["claim"] as Record<string, unknown> | undefined;
	if (
		!claim ||
		typeof claim !== "object" ||
		"work_id" in claim ||
		"agent_secret_sha256" in claim ||
		typeof claim["agent"] !== "string" ||
		claim["agent"] === ""
	) {
		return json(
			{
				error: "invalid_claim",
				detail: "body.claim must be a claim input (no work_id or agent_secret_sha256; the authority assigns them)",
			},
			400,
		);
	}
	const agent_secret = request.headers.get(AGENT_SECRET_HEADER) ?? undefined;
	const res = await doRpc(taskStub(env, taskId), "/claim", { body: { claim, agent_secret } });
	return json(res.body, res.status);
}


/** Name an Artifacts/runtime error without echoing a remote URL or token. */
function errorLabel(err: unknown): string {
	const e = err as { name?: string; code?: string; message?: string };
	const message = String(e?.message ?? err)
		.replace(/https:\/\/\S+/g, "[url]")
		.replace(/art_v2_\S+/g, "[token]");
	const frame = String((err as { stack?: string })?.stack ?? "")
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.startsWith("at ") && !line.includes("node:internal"));
	const where = frame ? ` @ ${frame.replace(/https:\/\/\S+/g, "[url]")}` : "";
	return `${e?.name ?? "Error"}${e?.code ? " " + e.code : ""}: ${message}${where}`.slice(0, 300);
}

/**
 * Drop the long-lived token fork() just minted. Prefer its plaintext, then
 * any still-active token id. Failures are logged and swallowed: the
 * contender credential is minted afterwards, and a revoke error here was
 * surfacing as HTTP 500 internal_error after the fork already existed.
 */
async function revokeForkCreationToken(repo: ArtifactsRepo, plaintext: string): Promise<void> {
	try {
		await repo.revokeToken(plaintext);
		return;
	} catch (err) {
		console.error(`madgrix: revoke fork plaintext failed: ${errorLabel(err)}`);
	}
	try {
		const tokens = await repo.listTokens();
		await Promise.all(
			tokens.filter((tok) => tok.state === "active").map((tok) => repo.revokeToken(tok.id).catch(() => false)),
		);
	} catch (err) {
		console.error(`madgrix: revoke fork ids failed: ${errorLabel(err)}`);
	}
}


/**
 * Branch tip via ArtifactsRepo.log. workerd's ArtifactsRepo has no getHead
 * (types/defines/artifacts.d.ts). Do not call a method by that name.
 */
async function branchTip(repo: ArtifactsRepo, ref = "main"): Promise<string | null> {
	const entries = await repo.log({ ref, limit: 1 });
	if (!Array.isArray(entries) || entries.length === 0) return null;
	const hash = entries[0]?.hash;
	return typeof hash === "string" && hash.length > 0 ? hash : null;
}

/**
 * Whether the frozen baseline commit object is in this repo.
 * ArtifactsRepo.readCommit(hash) is the binding method that reads an object
 * id. Contender creation uses the baseline SHA already frozen on the task
 * and does not call log() or getHead.
 */
async function baselinePresent(repo: ArtifactsRepo, hash: string): Promise<string | null> {
	let last: unknown;
	for (let attempt = 0; attempt < 4; attempt++) {
		try {
			const commit = await repo.readCommit(hash);
			if (commit && commit.hash === hash) return hash;
		} catch (err) {
			last = err;
		}
		await new Promise((resolve) => setTimeout(resolve, 200 * 2 ** attempt));
	}
	if (last) throw last;
	return null;
}

/** 200 for a contender that already exists: its record stands, no token. */
function existingContender(record: ContenderRecord): Response {
	return json({ contender_id: record.contender_id, fork_repo: record.fork_repo, created: false, token_issued: false });
}

/**
 * POST /tasks/:id/contenders — idempotent contender fork (spec 5 §5).
 * Fork op id = H(task_id, contender_id); the fork NAME is derived from it,
 * so a retry converges to the existing fork (list-before-create). The
 * contender gets a ≤1h WRITE token on the fork ONLY; the fork-creation
 * token (default long TTL) is revoked immediately.
 * The plaintext token is returned ONCE in the response body and never logged.
 *
 * The agent is the one whose claim matches X-Madgrix-Agent-Secret, never the
 * request body: a body agent_id or claim_work_id that disagrees is 403. A
 * contender that already exists is returned with 200 and no token; the
 * write token is minted once per contender.
 */
export async function handleCreateContender(
	env: Env,
	taskId: string,
	request: Request,
): Promise<Response> {
	if (!(await requireAgentOrControl(request, env))) return json({ error: "agent_auth_required" }, 401);
	const agentSecret = request.headers.get(AGENT_SECRET_HEADER);
	if (!agentSecret) return json({ error: "agent_secret_required" }, 401);
	const parsed = await readJsonBody(request);
	if (!parsed.ok) return parsed.response;
	const body_agent_id = parsed.body["agent_id"];
	const claim_work_id = parsed.body["claim_work_id"];
	if (body_agent_id !== undefined && (typeof body_agent_id !== "string" || body_agent_id === "")) {
		return json({ error: "invalid_agent_id" }, 400);
	}
	if (claim_work_id !== undefined && (typeof claim_work_id !== "string" || claim_work_id === "")) {
		return json({ error: "invalid_claim_work_id" }, 400);
	}

	const read = await readTaskState(env, taskId);
	if (!read.ok) return json(read.body, read.status);
	const state = read.state;
	const identity = await resolveAgentBySecret(state, agentSecret, { sha256Hex });
	if (identity === null) return json({ error: "agent_secret_invalid" }, 403);
	const agent_id = identity.agent;
	if (body_agent_id !== undefined && body_agent_id !== agent_id) {
		return json({ error: "agent_id_mismatch" }, 403);
	}
	let boundClaimWorkId: string | null = null;
	if (typeof claim_work_id === "string") {
		const claim = state.claims.find((x) => x.work_id === claim_work_id);
		if (!claim) return json({ error: "claim_not_found", claim_work_id }, 404);
		if (!identity.work_ids.includes(claim.work_id)) {
			return json({ error: "claim_agent_mismatch", claim_work_id }, 403);
		}
		boundClaimWorkId = claim.work_id;
	}

	const contender_id = (await sha256Hex(joinHashParts("contender", taskId, agent_id))).slice(0, 32);
	const existing = state.contenders[contender_id];
	if (existing) return existingContender(existing);
	const forkOpId = await sha256Hex(joinHashParts("fork", taskId, contender_id));
	const forkName = contenderRepoName(taskId, forkOpId);

	const port = productionPort(env);
	try {
	const { repo, created, initialTokenPlaintext, viaImportFallback } = await forkIdempotent(
		port,
		state.task.baseline_repo,
		forkName,
	);

	// Cloudflare's Artifacts beta fork endpoint is currently broken
	// server-side. forkIdempotent falls back to creating an empty repo; when
	// that happens we reproduce fork semantics by copying the frozen baseline
	// commit through the trusted Git container before issuing a contender
	// credential. A fork that already exists but is still empty is such a
	// repo whose copy did not finish (the container answered a retryable
	// 503, say): this request copies again, with a fresh five-minute write
	// token, so retrying the request is how a caller recovers. A missing
	// baseline object counts as empty: readCommit returns null when the
	// object is not in the repo, and copy-baseline.sh checks the destination
	// itself (ALREADY_IMPORTED, or DESTINATION_NOT_EMPTY).
	const unfinishedCopy = !created && (await repo.readCommit(state.task.baseline_commit).catch(() => null)) === null;
	if ((created && viaImportFallback) || unfinishedCopy) {
		let destinationToken: string;
		let revokeDestinationToken: string;
		if (created) {
			if (initialTokenPlaintext === null) {
				return json({ error: "fork_fallback_missing_write_token", fork_repo: forkName }, 502);
			}
			destinationToken = initialTokenPlaintext;
			revokeDestinationToken = initialTokenPlaintext;
		} else {
			const minted = await repo.createToken("write", 300);
			destinationToken = minted.plaintext;
			revokeDestinationToken = minted.id;
		}
		const baseline = await port.get(state.task.baseline_repo);
		const sourceToken = await baseline.createToken("read", 300);
		try {
			const copy = await containerRpc(promotionStub(env, `fork-${forkOpId}`), "/copy-baseline", {
				action: "copy_baseline",
				op_id: forkOpId,
				source_remote: baseline.remote,
				source_token: sourceToken.plaintext,
				source_commit: state.task.baseline_commit,
				destination_remote: repo.remote,
				destination_token: destinationToken,
			});
			const result = copy.body as { outcome?: string; head?: string; error?: string; retryable?: boolean };
			if (!copy.ok || (result.outcome !== "IMPORTED" && result.outcome !== "ALREADY_IMPORTED")) {
				// A retryable container failure keeps its 503: retry this request.
				const retryable = copy.status === 503 && result.retryable === true;
				return json(
					{ error: "fork_baseline_import_failed", retryable, detail: result },
					retryable ? 503 : 502,
				);
			}
			if (result.head !== state.task.baseline_commit) {
				return json({ error: "fork_baseline_head_mismatch", expected: state.task.baseline_commit, actual: result.head }, 502);
			}
		} finally {
			await Promise.allSettled([
				baseline.revokeToken(sourceToken.id),
				repo.revokeToken(revokeDestinationToken),
			]);
		}
	} else if (created && initialTokenPlaintext !== null) {
		// The fork-creation token has the binding default TTL (24h) — too
		// long for a contender. Revoke it; the contender gets a ≤1h token.
		// Revocation of a token minted in this same request can throw
		// (ArtifactsError) even though the fork itself succeeded. That must
		// not fail contender creation: the credential we return is a new one.
		await revokeForkCreationToken(repo, initialTokenPlaintext);
	}

	const credentials = await issueContenderCredentials(port, forkName, 3600);
	const latest_commit = await baselinePresent(repo, state.task.baseline_commit);
	if (latest_commit !== state.task.baseline_commit) {
		await repo.revokeToken(credentials.id);
		return json({
			error: "contender_fork_not_at_frozen_baseline",
			expected: state.task.baseline_commit,
			actual: latest_commit,
		}, 409);
	}

	const contender: ContenderRecord = {
		contender_id,
		agent_id,
		fork_repo: forkName,
		fork_lineage: { parent_repo: state.task.baseline_repo, parent_commit: state.task.baseline_commit },
		fork_base: state.task.baseline_commit,
		token_id: credentials.id,
		token_ids: [credentials.id],
		status: "forked",
		claim_work_id: boundClaimWorkId,
		latest_commit,
	};
	const reg = await doRpc(taskStub(env, taskId), "/contender", { body: { contender } });
	// A token whose id did not make it onto a record could never be revoked
	// by quarantine: revoke it now.
	if (!reg.ok) {
		await repo.revokeToken(credentials.id);
		return json({ error: "contender_register_failed", detail: reg.body }, 502);
	}
	const registered = reg.body as { recorded: boolean; contender: ContenderRecord };
	if (!registered.recorded) {
		// A concurrent request registered this contender first; its record stands.
		await repo.revokeToken(credentials.id);
		return existingContender(registered.contender);
	}

	// NOTE: `credentials.plaintext` appears here exactly once — in the
	// response body. It is never logged, never persisted.
	return json(
		{
			contender_id,
			fork_repo: forkName,
			remote: repo.remote,
			token: credentials.plaintext,
			expires_at: credentials.expiresAt,
			created: created,
		},
		created ? 201 : 200,
	);
	} catch (err) {
		// The fork may already exist. Name the exception instead of collapsing
		// it to internal_error; nothing secret is included.
		console.error(`madgrix: POST /contenders failed: ${errorLabel(err)}`);
		return json({ error: "contender_create_failed", detail: errorLabel(err) }, 500);
	}
}

/** GET /tasks/:id/context — non-secret frozen task + work graph context. */
export async function handleTaskContext(env: Env, taskId: string, request: Request): Promise<Response> {
	if (!(await requireAgentOrControl(request, env))) return json({ error: "task_context_auth_required" }, 401);
	const read = await readTaskState(env, taskId);
	if (!read.ok) return json(read.body, read.status);
	const state = read.state;
	const graph = buildWorkGraph(state);
	return json({
		task: state.task,
		task_status: state.task_status,
		claims: state.claims.map(publicClaim),
		contenders: Object.values(state.contenders).map((x) => ({
			contender_id: x.contender_id,
			agent_id: x.agent_id,
			fork_repo: x.fork_repo,
			claim_work_id: x.claim_work_id,
			latest_commit: x.latest_commit,
			status: x.status,
		})),
		conflict_reports: state.conflict_reports ?? [],
		composition: state.composition ?? null,
		crew: graph.crew,
		graph,
	});
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (ch) => {
		if (ch === "&") return "&amp;";
		if (ch === "<") return "&lt;";
		if (ch === ">") return "&gt;";
		if (ch === '"') return "&quot;";
		return "&#39;";
	});
}

/**
 * GET /tasks/:id/graph — a small HTML view of the same context the API returns.
 * It does not fetch other services and it does not include agent secrets.
 */
export async function handleWorkGraph(env: Env, taskId: string, request: Request): Promise<Response> {
	if (!(await requireAgentOrControl(request, env))) return json({ error: "task_context_auth_required" }, 401);
	const read = await readTaskState(env, taskId);
	if (!read.ok) return json(read.body, read.status);
	const state = read.state;
	const graph = buildWorkGraph(state);
	const wantsJson =
		new URL(request.url).searchParams.get("format") === "json" ||
		(request.headers.get("accept") ?? "").includes("application/json");
	if (wantsJson) return json(graph);
	const composition = state.composition;
	const claims = state.claims
		.map(
			(claim) =>
				`<li><code>${escapeHtml(claim.agent)}</code> ${escapeHtml(claim.work_id)} ` +
				`<span>${escapeHtml(claim.status)}</span> ${escapeHtml(claim.scope.paths.join(", "))} ` +
				`— ${escapeHtml(claim.intent.behavior.join("; "))}</li>`,
		)
		.join("");
	const contenders = Object.values(state.contenders)
		.map(
			(row) =>
				`<li><code>${escapeHtml(row.agent_id)}</code> ${escapeHtml(row.status)} ` +
				`commit <code>${escapeHtml(row.latest_commit ?? "none")}</code></li>`,
		)
		.join("");
	const conflicts = (state.conflict_reports ?? [])
		.map(
			(report) =>
				`<li>${escapeHtml(report.risk)} ${escapeHtml(report.claim_a)} × ${escapeHtml(report.claim_b)} — ${escapeHtml(report.explanation)}</li>`,
		)
		.join("");
	const files = (composition?.files ?? [])
		.map((file) => {
			const sides = file.sides
				.map(
					(side) =>
						`<p><code>${escapeHtml(side.agent_id)}</code> ${escapeHtml(side.intent)}<pre>${escapeHtml(side.excerpt)}</pre></p>`,
				)
				.join("");
			return `<section><h3>${escapeHtml(file.path)}</h3><p>${escapeHtml(file.classification)}</p>${sides}</section>`;
		})
		.join("");
	const html = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>${escapeHtml(state.task.task_id)} work graph</title>
<style>
  body { font: 16px/1.45 "Iowan Old Style", Palatino, serif; margin: 2.5rem auto; max-width: 42rem; color: #1c1915; background: #f6f1e7; }
  code, pre { font-family: ui-monospace, monospace; font-size: 0.85em; }
  pre { white-space: pre-wrap; background: #fff; padding: 0.6rem; }
  h1 { font-weight: 500; letter-spacing: -0.02em; }
</style>
<h1>${escapeHtml(state.task.intent)}</h1>
<p>Status ${escapeHtml(state.task_status)}. Composition ${escapeHtml(graph.composition_state ?? "none")}.
Candidate <code>${escapeHtml(graph.candidate_sha ?? "none")}</code>.</p>
<h2>Crew</h2>
<p>${graph.crew ? `parent <code>${escapeHtml(graph.crew.parent.agent_id)}</code> authority parent, outcome ${escapeHtml(graph.crew.outcome)}` : "none"}</p>
<h2>Members</h2>
<ul>${
	graph.members
		.map(
			(member) =>
				`<li><code>${escapeHtml(member.agent_id)}</code> ${escapeHtml(member.status)} ` +
				`intent ${escapeHtml(member.intent)} scope ${escapeHtml(member.scope.join(", "))} ` +
				`commit <code>${escapeHtml(member.commit_sha ?? "none")}</code></li>`,
		)
		.join("") || "<li>none</li>"
}</ul>
<h2>Dependencies</h2>
<ul>${
	graph.dependencies
		.map(
			(edge) =>
				`<li>${escapeHtml(edge.relation)} <code>${escapeHtml(edge.from)}</code> → <code>${escapeHtml(edge.to)}</code></li>`,
		)
		.join("") || "<li>none</li>"
}</ul>
<h2>Overlaps</h2>
<ul>${
	graph.overlaps
		.map((file) => `<li>${escapeHtml(file.path)} ${escapeHtml(file.classification)} ${escapeHtml(file.agents.join(", "))}</li>`)
		.join("") || "<li>none</li>"
}</ul>
<h2>Claims</h2><ul>${claims || "<li>none</li>"}</ul>
<h2>Contenders</h2><ul>${contenders || "<li>none</li>"}</ul>
<h2>Potential conflicts</h2><ul>${conflicts || "<li>none</li>"}</ul>
<h2>Composition files</h2>${files || "<p>none</p>"}
</html>`;
	return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}

/** POST /tasks/:id/composition — control plane only. Coding agents cannot call this. */
export async function handleComposition(env: Env, taskId: string, request: Request): Promise<Response> {
	if (!(await requireControlPlane(request, env))) return json({ error: "control_plane_auth_required" }, 401);
	const parsed = await readJsonBody(request);
	if (!parsed.ok) return parsed.response;
	const composition = parsed.body["composition"];
	if (composition === null || typeof composition !== "object" || Array.isArray(composition)) {
		return json({ error: "invalid_composition" }, 400);
	}
	const recorded = await doRpc(taskStub(env, taskId), "/composition", { body: { composition } });
	if (!recorded.ok) return json(recorded.body, recorded.status);
	return json(recorded.body, 200);
}

/**
 * POST /tasks/:id/evaluator-credentials — short-lived READ access to one
 * contender fork. This route is evaluation-domain authenticated and never
 * mints canonical write authority.
 */
export async function handleEvaluatorCredentials(env: Env, taskId: string, request: Request): Promise<Response> {
	if (!(await requireEvaluationDomain(request, env))) {
		return json({ error: "evaluation_domain_auth_required" }, 401);
	}
	const parsed = await readJsonBody(request);
	if (!parsed.ok) return parsed.response;
	const contender_id = parsed.body["contender_id"];
	if (typeof contender_id !== "string" || contender_id === "") {
		return json({ error: "contender_id_required" }, 400);
	}
	const read = await readTaskState(env, taskId);
	if (!read.ok) return json(read.body, read.status);
	const state = read.state;
	const contender = state.contenders[contender_id];
	if (!contender) return json({ error: "contender_not_found", contender_id }, 404);
	if (state.quarantine[contender_id]?.status === "QUARANTINED") {
		return json({ error: "contender_quarantined", contender_id }, 409);
	}
	const port = productionPort(env);
	const repo = await port.get(contender.fork_repo);
	const credentials = await issueEvaluatorCredentials(port, contender.fork_repo, 300);
	const claim = contender.claim_work_id
		? state.claims.find((x) => x.work_id === contender.claim_work_id)
		: undefined;
	return json({
		contender_id,
		fork_repo: contender.fork_repo,
		remote: repo.remote,
		token: credentials.plaintext,
		expires_at: credentials.expiresAt,
		task_hash: state.task.task_hash,
		baseline_commit: state.task.baseline_commit,
		claim: claim ? publicClaim(claim) : null,
		latest_commit: contender.latest_commit,
		// What the agent's tool-status log must agree with for
		// provenance_complete (specs/amendments/tool-status-v1.md).
		agent_id: contender.agent_id,
		fork_lineage: contender.fork_lineage,
		// The commits the contender's work may sit on, oldest first: the fork
		// base, then every head a recorded rebase put under one of its
		// candidates. The evaluator compares the candidate with the newest of
		// these it descends from (specs/amendments/rebase-ancestry-v1.md).
		evaluation_bases: evaluationBases(contender),
	});
}

/**
 * POST /tasks/:id/evidence — accept an evaluation bundle from the
 * evaluation domain and record it in the task authority. The caller must
 * present EVALUATION_SERVICE_TOKEN (spec 3 §2): evidence is only admissible
 * from the evaluation domain (spec 3 §6, attack 6). The authority's answer
 * passes through: 422 for a bundle it rejects, 409 for a replacement of a
 * labeled candidate's evidence (specs/amendments/evidence-integrity-v1.md).
 * When the bundle names changed evaluation files the authority quarantines
 * the contender, and this route executes the effects: every fork token is
 * revoked (specs/amendments/tamper-quarantine-v1.md) and the PromotionWorkflow
 * instances of the contender's unconsumed permits are terminated
 * (specs/amendments/promotion-runtime-v1.md).
 */
export async function handleEvidence(env: Env, taskId: string, request: Request): Promise<Response> {
	if (!(await requireEvaluationDomain(request, env))) {
		return json({ error: "evaluation_domain_auth_required" }, 401);
	}
	const parsed = await readJsonBody(request);
	if (!parsed.ok) return parsed.response;
	const bundle = parsed.body["bundle"] as EvaluationBundle | undefined;
	if (!bundle || typeof bundle.candidate_sha !== "string") {
		return json({ error: "invalid_bundle" }, 400);
	}
	// Trust-zone identity is derived by the Worker after transport
	// authentication. The caller cannot self-assert its zone in JSON.
	const caller = { zone: "evaluation_domain" as const };
	const res = await doRpc(taskStub(env, taskId), "/evidence", { body: { bundle, caller } });
	// A tamper quarantine's effects run here (spec 5 §3: the DO returns
	// effects, this layer executes them) and are not echoed to the evaluator.
	const { effects, ...body } = (res.body ?? {}) as { effects?: Effect[] } & Record<string, unknown>;
	if (Array.isArray(effects) && effects.length > 0) {
		await executeEffects(productionPort(env), effects, env.PROMOTION_WORKFLOW);
	}
	return json(body, res.status);
}

/**
 * POST /tasks/:id/verifiers/commit — record a blind-verifier commitment.
 * Verifier report authenticity is ultimately enforced by the verifier's
 * Ed25519 key registered when the task was frozen.
 */
export async function handleVerifierCommit(env: Env, taskId: string, request: Request): Promise<Response> {
	if (!(await requireControlPlane(request, env))) return json({ error: "control_plane_auth_required" }, 401);
	const parsed = await readJsonBody(request);
	if (!parsed.ok) return parsed.response;
	const res = await doRpc(taskStub(env, taskId), "/verifier/commit", { body: { commitment: parsed.body["commitment"] } });
	return json(res.body, res.status);
}

/** POST /tasks/:id/verifiers/labels — assign labels only after commitments. */
export async function handleCandidateLabels(env: Env, taskId: string, request: Request): Promise<Response> {
	if (!(await requireControlPlane(request, env))) return json({ error: "control_plane_auth_required" }, 401);
	const parsed = await readJsonBody(request);
	if (!parsed.ok) return parsed.response;
	const res = await doRpc(taskStub(env, taskId), "/candidate-labels", { body: { candidate_shas: parsed.body["candidate_shas"] } });
	return json(res.body, res.status);
}

/** POST /tasks/:id/verifiers/reveal — verify commit→reveal. */
export async function handleVerifierReveal(env: Env, taskId: string, request: Request): Promise<Response> {
	if (!(await requireControlPlane(request, env))) return json({ error: "control_plane_auth_required" }, 401);
	const parsed = await readJsonBody(request);
	if (!parsed.ok) return parsed.response;
	const res = await doRpc(taskStub(env, taskId), "/verifier/reveal", {
		body: {
			verifier_id: parsed.body["verifier_id"],
			report: parsed.body["report"],
			nonce: parsed.body["nonce"],
		},
	});
	return json(res.body, res.status);
}

/** POST /tasks/:id/verifiers/report — submit a signed blind-verifier report. */
export async function handleVerifierReport(env: Env, taskId: string, request: Request): Promise<Response> {
	if (!(await requireControlPlane(request, env))) return json({ error: "control_plane_auth_required" }, 401);
	const parsed = await readJsonBody(request);
	if (!parsed.ok) return parsed.response;
	const res = await doRpc(taskStub(env, taskId), "/verifier/report", { body: { report: parsed.body["report"] } });
	return json(res.body, res.status);
}

/**
 * POST /tasks/:id/verdict — execute the frozen Verdict Seam against
 * authority-held evidence and issue an exact-state permit only on ACCEPT.
 */
export async function handleVerdict(env: Env, taskId: string, request: Request): Promise<Response> {
	if (!(await requireControlPlane(request, env))) return json({ error: "control_plane_auth_required" }, 401);
	const parsed = await readJsonBody(request);
	if (!parsed.ok) return parsed.response;
	const candidates = parsed.body["candidates"];
	const destination_repo = parsed.body["destination_repo"];
	if (!Array.isArray(candidates) || candidates.length === 0) {
		return json({ error: "candidates_required" }, 400);
	}
	if (typeof destination_repo !== "string" || destination_repo === "") {
		return json({ error: "destination_repo_required" }, 400);
	}

	const vr = await doRpc(taskStub(env, taskId), "/verdict", { body: { candidates } });
	if (!vr.ok) return json(vr.body, vr.status);
	const verdict = (vr.body as { verdict?: { state?: string; winner_sha?: string | null } }).verdict;
	if (!verdict) return json({ error: "verdict_authority_invalid_response" }, 502);
	if (verdict.state !== "ACCEPT" || !verdict.winner_sha) {
		return json({ verdict, permit: null }, 200);
	}

	const dest = await productionPort(env).get(destination_repo);
	const destination_head = await branchTip(dest);
	if (!destination_head) return json({ error: "destination_head_not_found", destination_repo }, 409);
	const pr = await doRpc(taskStub(env, taskId), "/permit", {
		body: { winner_sha: verdict.winner_sha, destination_repo, destination_head },
	});
	// The destination moved past the winner's base: no permit. The control
	// plane rebases the candidate (POST /tasks/:id/rebase), which makes a new
	// SHA to evaluate (specs/amendments/rebase-ancestry-v1.md).
	if (
		pr.status === 409 &&
		((pr.body as { outcome?: unknown } | null)?.outcome === "REBASE_REQUIRED" ||
			(pr.body as { outcome?: unknown } | null)?.outcome === "UNRESOLVED_CONFLICT")
	) {
		return json({ verdict, permit: null, ...(pr.body as Record<string, unknown>) }, 409);
	}
	if (!pr.ok) return json({ verdict, error: "permit_issue_failed", detail: pr.body }, pr.status);
	return json({ verdict, ...(pr.body as Record<string, unknown>) }, 200);
}

/** A permit id: the SHA-256 hex of its bound fields (computePermitId). */
const PERMIT_ID_PATTERN = /^[0-9a-f]{64}$/;

/** An answer of the promotion operation, before it becomes a Response. */
interface PromotionAnswer {
	status: number;
	body: Record<string, unknown>;
}

/**
 * The exact-state canonical promotion of one permit; it runs in the permit's
 * PromotionWorkflow step. It validates the permit and its evidence, mints
 * short-lived Git capabilities, delegates the single canonical write to the
 * trusted promotion container (container/promote.sh: a fast-forward to the
 * reviewed commit), then has the task authority finalize/consume the permit.
 *
 * Answers: 200 PROMOTED or ALREADY_CONSUMED; 404 for an unknown task or
 * permit; 409 for every terminal refusal (the container's included), which
 * leaves the permit unconsumed; 502/503 for a failure the step retries (a
 * git failure, a container that is not running or overran its deadline, a
 * finalize that did not land). An exception (an Artifacts call that fails,
 * an upstream that does not answer JSON) is thrown, and the step retries it.
 */
export async function runPromotion(env: Env, taskId: string, permit_id: string): Promise<PromotionAnswer> {
	const read = await readTaskState(env, taskId);
	if (!read.ok) return { status: read.status, body: read.body };
	const state = read.state;
	const permit = Object.hasOwn(state.permits, permit_id) ? (state.permits as Record<string, PermitRecord>)[permit_id] : undefined;
	if (!permit) return { status: 404, body: { outcome: "UNKNOWN_PERMIT" satisfies PromotionOutcome, permit_id } };
	if (permit.consumed) {
		return { status: 200, body: { outcome: "ALREADY_CONSUMED" satisfies PromotionOutcome, permit_id } };
	}
	const quarantine = state.quarantine[permit.contender_id];
	if (quarantine?.status === "QUARANTINED") {
		return { status: 409, body: { outcome: "QUARANTINED_CANDIDATE" satisfies PromotionOutcome, permit_id } };
	}
	if (compositionBlocks(state, permit.contender_id, permit.winner_candidate_sha)) {
		return { status: 409, body: { outcome: "UNRESOLVED_CONFLICT" satisfies PromotionOutcome, permit_id } };
	}
	const contender = state.contenders[permit.contender_id];
	if (!contender) return { status: 409, body: { error: "winner_contender_not_found", permit_id } };

	const recomputed = await computePermitId({
		task_hash: permit.task_hash,
		baseline_commit: permit.baseline_commit,
		winning_tree_sha256: permit.winning_tree_sha256,
		evaluation_bundle_hash: permit.evaluation_bundle_hash,
		selector_policy_hash: permit.selector_policy_hash,
		expected_destination_head: permit.expected_destination_head,
	});
	if (recomputed !== permit_id) return { status: 409, body: { error: "permit_id_invalid", permit_id } };

	const storedBundle = state.evaluations[permit.winner_candidate_sha];
	// A missing scan or a named artifact stops before any write token is
	// minted. A complete scan that lists no paths does not: the container
	// reads the blobs itself. This check does not prove the evaluator's
	// empty list is true.
	if (mergeArtifactAdmissionRefuses(storedBundle)) {
		return { status: 409, body: { outcome: "UNRESOLVED_CONFLICT" satisfies PromotionOutcome, permit_id } };
	}
	if (!storedBundle || storedBundle.bundle_hash !== permit.evaluation_bundle_hash) {
		return {
			status: 409,
			body: {
				outcome: "EVAL_BUNDLE_MISMATCH" satisfies PromotionOutcome,
				permit_id,
				permit_bundle_hash: permit.evaluation_bundle_hash,
				stored_bundle_hash: storedBundle?.bundle_hash ?? null,
			},
		};
	}

	const port = productionPort(env);
	const sourceRepo = await port.get(contender.fork_repo);
	const candidate = await sourceRepo.readCommit(permit.winner_candidate_sha);
	if (candidate === null) {
		return {
			status: 409,
			body: { outcome: "TREE_MISMATCH" satisfies PromotionOutcome, permit_id, detail: "candidate commit missing from contender repo" },
		};
	}
	const destinationRepo = await port.get(permit.destination_repo);
	// No head pre-check here: the container decides. A destination that moved
	// on from our own earlier write still holds the candidate in its history
	// (ALREADY_WRITTEN, so the permit can be finalized); any other move is
	// EXPIRED_HEAD_MOVED, and the push itself is the final compare-and-swap.

	// The only credentials with canonical write authority are minted here and
	// live for at most five minutes. They are never persisted or logged.
	const sourceToken = await sourceRepo.createToken("read", 300);
	const destinationToken = await destinationRepo.createToken("write", 300);
	try {
		const promoRes = await containerRpc(promotionStub(env, permit_id), "/run", {
			permit_id,
			source_remote: sourceRepo.remote,
			source_token: sourceToken.plaintext,
			candidate_sha: permit.winner_candidate_sha,
			destination_remote: destinationRepo.remote,
			destination_token: destinationToken.plaintext,
			expected_destination_head: permit.expected_destination_head,
			winning_tree_sha256: permit.winning_tree_sha256,
			issued_at: permit.issued_at,
		});
		const promotion = promoRes.body as Partial<PromotionResult>;
		if (!promoRes.ok) {
			// The container answers 409 for every terminal refusal
			// (EXPIRED_HEAD_MOVED, TREE_MISMATCH, PUSH_REJECTED,
			// UNSUPPORTED_TREE_ENTRY, BASELINE_MISMATCH, UNRESOLVED_CONFLICT):
			// the step does not
			// retry those. Its 503s (not running, deadline) stay 503; anything
			// else is a git failure, 502. The step retries both.
			const status = promoRes.status === 409 ? 409 : promoRes.status === 503 ? 503 : 502;
			return { status, body: { ...promotion, permit_id } };
		}
		if (
			(promotion.outcome !== "PROMOTED" && promotion.outcome !== "ALREADY_WRITTEN") ||
			promotion.promoted_sha !== permit.winner_candidate_sha ||
			promotion.tree_sha256 !== permit.winning_tree_sha256 ||
			promotion.base !== permit.expected_destination_head ||
			typeof promotion.parent !== "string"
		) {
			return { status: 502, body: { error: "promotion_container_invalid_result", permit_id, promotion } };
		}

		// Consume the permit only AFTER the canonical write is known to exist.
		// If this RPC is lost after the Git push, retry reconciliation returns
		// ALREADY_WRITTEN and this same finalization safely runs again.
		// The authority consumes the permit and signs the ship record (the
		// promotion bundle) in the same transaction (spec 1 §11).
		const finalized = await doRpc(taskStub(env, taskId), "/promotion/finalize", {
			body: {
				permit_id,
				verified_base: promotion.base,
				tree_sha256: permit.winning_tree_sha256,
				promoted_sha: promotion.promoted_sha,
				promoted_parent: promotion.parent,
			},
		});
		if (!finalized.ok) {
			return {
				status: 503,
				body: {
					error: "promotion_written_but_finalize_pending",
					permit_id,
					promoted_sha: promotion.promoted_sha,
					detail: finalized.body,
				},
			};
		}
		return {
			status: 200,
			body: {
				outcome: "PROMOTED" satisfies PromotionOutcome,
				permit_id,
				promoted_sha: promotion.promoted_sha,
				reconciled_existing_write: promotion.outcome === "ALREADY_WRITTEN",
			},
		};
	} finally {
		// Revocation is best-effort but happens even when Git/evaluation fails.
		await Promise.allSettled([
			sourceRepo.revokeToken(sourceToken.id),
			destinationRepo.revokeToken(destinationToken.id),
		]);
	}
}

/** Where a client polls a promotion. */
function promotionStatusUrl(taskId: string, permitId: string): string {
	return `/tasks/${taskId}/promotions/${permitId}`;
}

/**
 * The permit's PromotionWorkflow instance, as the status route reports it:
 * `result` is the promotion's answer once the instance is complete; `error`
 * is the last failure of an errored instance.
 */
async function promotionInstanceStatus(instance: WorkflowInstanceHandle): Promise<Record<string, unknown>> {
	const current = await instance.status();
	const reported: Record<string, unknown> = { instance_id: instance.id, status: current.status };
	const output = current.output as { status?: unknown; body?: unknown } | null | undefined;
	if (current.status === "complete" && typeof output?.status === "number" && typeof output.body === "string") {
		let body: unknown = output.body;
		try {
			body = JSON.parse(output.body);
		} catch {
			// Not the JSON text PromotionWorkflow.run returns: report it as is.
		}
		reported.result = { status: output.status, body };
	}
	if (current.error) reported.error = current.error;
	return reported;
}

/**
 * The permit named in a promotion request, if the task authority holds it.
 * A malformed id is 400 and an unknown one 404; neither reaches the Workflow.
 */
async function lookUpPermit(
	env: Env,
	taskId: string,
	permit_id: unknown,
): Promise<{ ok: true; permit_id: string } | { ok: false; response: Response }> {
	if (typeof permit_id !== "string" || permit_id === "") {
		return { ok: false, response: json({ error: "permit_id_required" }, 400) };
	}
	if (!PERMIT_ID_PATTERN.test(permit_id)) {
		return { ok: false, response: json({ error: "invalid_permit_id", permit_id }, 400) };
	}
	const read = await readTaskState(env, taskId);
	if (!read.ok) return { ok: false, response: json(read.body, read.status) };
	if (!Object.hasOwn(read.state.permits, permit_id)) {
		return { ok: false, response: json({ outcome: "UNKNOWN_PERMIT" satisfies PromotionOutcome, permit_id }, 404) };
	}
	return { ok: true, permit_id };
}

/**
 * POST /tasks/:id/promote — start the promotion of a permit. Body
 * `{ permit_id }`; control plane only.
 *
 * The promotion runs in a PromotionWorkflow instance whose id is the permit
 * id (spec 5 §5: the promote operation id is the permit id;
 * specs/amendments/promotion-runtime-v1.md). The answer is 202
 * `{ instance_id, status, status_url }`; GET status_url reports the
 * instance and, once it is complete, the promotion's answer. A repeated
 * request finds the permit's instance and reports it instead of starting a
 * second one; an instance that errored (its retries ran out) is restarted.
 * A permit the task authority does not hold is 404 and starts nothing.
 */
export async function handlePromote(
	env: Env,
	taskId: string,
	request: Request,
): Promise<Response> {
	if (!(await requireControlPlane(request, env))) return json({ error: "control_plane_auth_required" }, 401);
	const parsed = await readJsonBody(request);
	if (!parsed.ok) return parsed.response;
	const found = await lookUpPermit(env, taskId, parsed.body["permit_id"]);
	if (!found.ok) return found.response;
	const { permit_id } = found;

	let instance: WorkflowInstanceHandle;
	try {
		instance = await env.PROMOTION_WORKFLOW.create({ id: permit_id, params: { task_id: taskId, permit_id } });
	} catch (createError) {
		// The id is taken: this permit's instance exists already.
		try {
			instance = await env.PROMOTION_WORKFLOW.get(permit_id);
		} catch {
			throw createError;
		}
		if ((await instance.status()).status === "errored") await instance.restart();
	}
	const { status } = await instance.status();
	return json({ instance_id: instance.id, status, status_url: promotionStatusUrl(taskId, permit_id) }, 202);
}

/**
 * GET /tasks/:id/promotions/:permit_id — the status of the permit's
 * PromotionWorkflow instance (queued, running, complete, errored,
 * terminated, ...). A complete instance carries the promotion's answer as
 * `result: { status, body }`: 200 PROMOTED, or a terminal 4xx refusal.
 * 404 `promotion_not_started` when the permit has no instance.
 */
export async function handlePromotionStatus(
	env: Env,
	taskId: string,
	permitId: string,
	request: Request,
): Promise<Response> {
	if (!(await requireControlPlane(request, env))) return json({ error: "control_plane_auth_required" }, 401);
	const found = await lookUpPermit(env, taskId, permitId);
	if (!found.ok) return found.response;
	let instance: WorkflowInstanceHandle;
	try {
		instance = await env.PROMOTION_WORKFLOW.get(permitId);
	} catch {
		return json({ error: "promotion_not_started", permit_id: permitId }, 404);
	}
	return json(await promotionInstanceStatus(instance));
}

/**
 * POST /tasks/:id/rebase — rebase a contender's latest candidate onto the
 * destination's current head (specs/amendments/rebase-ancestry-v1.md).
 * Control plane only; body `{ contender_id, destination_repo }`.
 *
 * The trusted promotion container replays the candidate (container/rebase.sh)
 * and pushes the result to the contender's fork with a fork-scoped write token
 * minted here for at most five minutes; nothing is written to the
 * destination, which gets only a read token. The task authority records the
 * report: REBASED and UP_TO_DATE make the head a recorded ancestor of the
 * (new) candidate — a REBASED commit is a new SHA with no evidence until the
 * evaluation domain evaluates it — and CONFLICT escalates the task with the
 * conflicting paths as data (409). The container's other refusals
 * (FORK_MOVED, PUSH_REJECTED, ALREADY_IN_DESTINATION) pass through as 409,
 * its retryable 503s (not running, deadline) as 503, git failures as 502.
 */
export async function handleRebase(env: Env, taskId: string, request: Request): Promise<Response> {
	if (!(await requireControlPlane(request, env))) return json({ error: "control_plane_auth_required" }, 401);
	const parsed = await readJsonBody(request);
	if (!parsed.ok) return parsed.response;
	const contender_id = parsed.body["contender_id"];
	const destination_repo = parsed.body["destination_repo"];
	if (typeof contender_id !== "string" || contender_id === "") return json({ error: "contender_id_required" }, 400);
	if (typeof destination_repo !== "string" || destination_repo === "") {
		return json({ error: "destination_repo_required" }, 400);
	}

	const read = await readTaskState(env, taskId);
	if (!read.ok) return json(read.body, read.status);
	const state = read.state;
	const contender = Object.hasOwn(state.contenders, contender_id) ? state.contenders[contender_id] : undefined;
	if (!contender) return json({ error: "contender_not_found", contender_id }, 404);
	const sanction = state.quarantine[contender_id]?.status;
	if (sanction === "QUARANTINED" || sanction === "REVOKED") {
		return json({ error: "contender_quarantined", contender_id }, 409);
	}
	const candidate = contender.latest_commit;
	if (!candidate) return json({ error: "no_candidate", contender_id }, 409);

	const port = productionPort(env);
	const fork = await port.get(contender.fork_repo);
	const destination = await port.get(destination_repo);
	const onto = await branchTip(destination);
	if (!onto) return json({ error: "destination_head_not_found", destination_repo }, 409);

	const opId = (await sha256Hex(joinHashParts("rebase", taskId, contender_id, candidate, onto))).slice(0, 32);
	const forkToken = await fork.createToken("write", 300);
	const destinationToken = await destination.createToken("read", 300);
	try {
		const res = await containerRpc(promotionStub(env, `rebase-${opId}`), "/rebase", {
			action: "rebase",
			op_id: opId,
			fork_remote: fork.remote,
			fork_token: forkToken.plaintext,
			candidate_sha: candidate,
			destination_remote: destination.remote,
			destination_token: destinationToken.plaintext,
			onto,
		});
		const result = res.body as Partial<RebaseResult>;
		const where = { contender_id, candidate_sha: candidate, onto };
		let report: RebaseReport;
		if (res.ok && result.outcome === "REBASED" && typeof result.rebased_sha === "string" && result.rebased_sha !== candidate) {
			report = { contender_id, outcome: "REBASED", from_sha: candidate, onto, new_sha: result.rebased_sha };
		} else if (res.ok && result.outcome === "UP_TO_DATE" && result.rebased_sha === candidate) {
			report = { contender_id, outcome: "UP_TO_DATE", from_sha: candidate, onto };
		} else if (res.status === 409 && result.outcome === "CONFLICT" && Array.isArray(result.paths)) {
			report = { contender_id, outcome: "CONFLICT", from_sha: candidate, onto, paths: result.paths };
		} else if (res.status === 409) {
			return json({ ...result, ...where }, 409);
		} else if (!res.ok) {
			// The container's 503s (not running, deadline) stay 503: retry the request.
			return json({ ...result, ...where }, res.status === 503 ? 503 : 502);
		} else {
			return json({ error: "rebase_container_invalid_result", ...where, result }, 502);
		}
		if (result.onto !== onto) return json({ error: "rebase_container_invalid_result", ...where, result }, 502);

		const recorded = await doRpc(taskStub(env, taskId), "/rebase", { body: { report } });
		if (!recorded.ok) {
			// A pushed rebase the authority did not record: a retry rebases the
			// fork's new head, which is UP_TO_DATE on `onto`.
			return json({ error: "rebase_record_failed", ...where, result, detail: recorded.body }, 502);
		}
		const authority = recorded.body as { outcome?: string; task_status?: string };
		return json(
			{ ...result, ...where, authority: authority.outcome, task_status: authority.task_status },
			report.outcome === "CONFLICT" ? 409 : 200,
		);
	} finally {
		await Promise.allSettled([fork.revokeToken(forkToken.id), destination.revokeToken(destinationToken.id)]);
	}
}

/**
 * GET /tasks/:id/bundle[?permit_id=] — the promotion bundle the task
 * authority signed at finalize (default: the task's latest promotion).
 * Verify it offline with `src/cli/verify.ts` against the pinned authority key.
 */
export async function handlePromotionBundle(env: Env, taskId: string, request: Request): Promise<Response> {
	if (!(await requireControlPlane(request, env))) return json({ error: "control_plane_auth_required" }, 401);
	const permitId = new URL(request.url).searchParams.get("permit_id");
	const query = permitId === null ? "" : `?permit_id=${encodeURIComponent(permitId)}`;
	const res = await doRpc(taskStub(env, taskId), `/bundle${query}`, { method: "GET" });
	return json(res.body, res.status);
}

/** GET /tasks/:id/ledger — the task authority's append-only ledger. */
export async function handleLedger(env: Env, taskId: string): Promise<Response> {
	const read = await readTaskState(env, taskId);
	if (!read.ok) return json(read.body, read.status);
	return json({ task_id: taskId, ledger: read.state.ledger });
}

/**
 * GET /tasks/:id/attestation/:pid/verify — platform-level permit
 * verification: recompute the permit id from its bound fields (spec 1 §10)
 * and check consumption + destination HEAD. This is NOT the full spec-4
 * attestation (in-toto + DSSE + Sigstore); that is protocol-layer.
 */
export async function handleVerifyAttestation(
	env: Env,
	taskId: string,
	permitId: string,
): Promise<Response> {
	const read = await readTaskState(env, taskId);
	if (!read.ok) return json(read.body, read.status);
	const state = read.state;
	const permit = (state.permits as Record<string, PermitRecord>)[permitId];
	if (!permit) return json({ error: "unknown_permit", permit_id: permitId }, 404);

	const recomputed = await computePermitId({
		task_hash: permit.task_hash,
		baseline_commit: permit.baseline_commit,
		winning_tree_sha256: permit.winning_tree_sha256,
		evaluation_bundle_hash: permit.evaluation_bundle_hash,
		selector_policy_hash: permit.selector_policy_hash,
		expected_destination_head: permit.expected_destination_head,
	});

	const port = productionPort(env);
	let currentHead: string | null = null;
	try {
		currentHead = await branchTip(await port.get(permit.destination_repo));
	} catch {
		currentHead = null;
	}

	const destinationState =
		permit.consumed
			? currentHead === permit.winner_candidate_sha
				? "PROMOTED_EXACT_CANDIDATE"
				: "PROMOTED_BUT_DESTINATION_MOVED_AFTERWARD"
			: currentHead === permit.expected_destination_head
				? "UNCONSUMED_AT_EXPECTED_PARENT"
				: "UNCONSUMED_DESTINATION_MOVED";

	return json({
		permit_id: permitId,
		permit_id_valid: recomputed === permitId,
		consumed: permit.consumed,
		consumed_at: permit.consumed_at,
		expected_destination_head: permit.expected_destination_head,
		winner_candidate_sha: permit.winner_candidate_sha,
		current_destination_head: currentHead,
		destination_state: destinationState,
		exact_reviewed_candidate_current:
			permit.consumed && currentHead === permit.winner_candidate_sha,
		task_hash: permit.task_hash,
		note:
			"Platform-level permit/destination check. Full offline evidence verification uses promotion.bundle via src/cli/verify.ts.",
	});
}

/* ------------------------------------------------------------------ */
/* Effect execution — the DO returns effects; THIS layer executes them  */
/* ------------------------------------------------------------------ */

/**
 * Execute the effects the task authority returns (spec 5 §3: the DO returns
 * effects, it never executes them). Called by the queue consumer and the
 * evidence route; `promotions` is the PromotionWorkflow binding a
 * cancel_workflow effect stops instances of.
 */
export async function executeEffects(
	port: ArtifactsPort,
	effects: Effect[],
	promotions?: WorkflowBindingLike,
): Promise<void> {
	for (const effect of effects) {
		switch (effect.kind) {
			case "revoke_token": {
				// Quarantine path (spec 3 §7): kill the contender's write token.
				try {
					const repo = await port.get(effect.repo);
					await repo.revokeToken(effect.token_id);
				} catch (err) {
					console.warn(`executeEffects: revoke_token failed for ${effect.repo}:`, err);
				}
				break;
			}
			case "cancel_workflow": {
				// Quarantine stops the contender's pending promotions: each
				// unconsumed permit's PromotionWorkflow instance (id = permit id)
				// is terminated. A permit with no instance, or whose instance has
				// already finished, has nothing to stop. A promotion that ran
				// before the quarantine landed is refused by the authority's own
				// quarantine check (QUARANTINED_CANDIDATE) at finalize.
				if (!promotions) {
					console.warn(
						`executeEffects: cancel_workflow for contender ${effect.contender_id}: no PromotionWorkflow binding`,
					);
					break;
				}
				for (const permit_id of effect.permit_ids) {
					let instance: WorkflowInstanceHandle;
					try {
						instance = await promotions.get(permit_id);
					} catch {
						continue;
					}
					try {
						await instance.terminate();
					} catch (err) {
						console.warn(`executeEffects: cancel_workflow could not terminate promotion ${permit_id}:`, err);
					}
				}
				break;
			}
			case "notify": {
				// Notifications go to the Worker log; no notification channel is
				// wired.
				console.log(`[notify] to=${effect.to.join(",")}: ${effect.message}`);
				break;
			}
			case "canonical_write": {
				// Canonical writes ONLY happen through the promote route and
				// the promotion container's fast-forward (container/promote.sh;
				// spec 3 §2, spec 5 §7). An effect carrying a canonical write is
				// a protocol-layer signal; executing it here would bypass the
				// promotion service. Log and stop.
				console.warn(
					`executeEffects: canonical_write effect for ${effect.repo} NOT executed here — canonical writes go through the promotion service only`,
				);
				break;
			}
		}
	}
}

/* ------------------------------------------------------------------ */
/* fetch router                                                        */
/* ------------------------------------------------------------------ */

/**
 * Every answer is JSON (specs/amendments/promotion-runtime-v1.md): a Durable
 * Object that answered something other than JSON is 502
 * `upstream_not_json`, and any other exception a route throws is 500
 * `internal_error`, with its detail logged rather than returned.
 */
export async function fetch(request: Request, env: Env): Promise<Response> {
	try {
		return await route(request, env);
	} catch (err) {
		if (err instanceof UpstreamNotJsonError) {
			return json({ error: "upstream_not_json", upstream: err.upstream, upstream_status: err.upstreamStatus }, 502);
		}
		console.error(`madgrix: ${request.method} ${new URL(request.url).pathname} failed: ${(err as Error)?.message ?? err}`);
		return json({ error: "internal_error" }, 500);
	}
}

async function route(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const parts = url.pathname.split("/").filter((p) => p !== "");

	// POST /tasks
	if (request.method === "POST" && parts.length === 1 && parts[0] === "tasks") {
		return handleCreateTask(env, request);
	}
	// /tasks/:id/...
	if (parts.length >= 3 && parts[0] === "tasks") {
		const taskId = parts[1];
		const action = parts[2];
		if (request.method === "POST" && action === "claim" && parts.length === 3) {
			return handleClaim(env, taskId, request);
		}
		if (request.method === "POST" && action === "contenders" && parts.length === 3) {
			return handleCreateContender(env, taskId, request);
		}
		if (request.method === "GET" && action === "context" && parts.length === 3) {
			return handleTaskContext(env, taskId, request);
		}
		if (request.method === "GET" && action === "graph" && parts.length === 3) {
			return handleWorkGraph(env, taskId, request);
		}
		if (request.method === "POST" && action === "composition" && parts.length === 3) {
			return handleComposition(env, taskId, request);
		}
		if (request.method === "POST" && action === "evaluator-credentials" && parts.length === 3) {
			return handleEvaluatorCredentials(env, taskId, request);
		}
		if (request.method === "POST" && action === "evidence" && parts.length === 3) {
			return handleEvidence(env, taskId, request);
		}
		if (request.method === "POST" && action === "verifiers" && parts.length === 4) {
			if (parts[3] === "commit") return handleVerifierCommit(env, taskId, request);
			if (parts[3] === "labels") return handleCandidateLabels(env, taskId, request);
			if (parts[3] === "reveal") return handleVerifierReveal(env, taskId, request);
			if (parts[3] === "report") return handleVerifierReport(env, taskId, request);
		}
		if (request.method === "POST" && action === "verdict" && parts.length === 3) {
			return handleVerdict(env, taskId, request);
		}
		if (request.method === "POST" && action === "promote" && parts.length === 3) {
			return handlePromote(env, taskId, request);
		}
		if (request.method === "GET" && action === "promotions" && parts.length === 4) {
			return handlePromotionStatus(env, taskId, parts[3], request);
		}
		if (request.method === "POST" && action === "rebase" && parts.length === 3) {
			return handleRebase(env, taskId, request);
		}
		if (request.method === "GET" && action === "ledger" && parts.length === 3) {
			return handleLedger(env, taskId);
		}
		if (request.method === "GET" && action === "bundle" && parts.length === 3) {
			return handlePromotionBundle(env, taskId, request);
		}
		if (
			request.method === "GET" &&
			action === "attestation" &&
			parts.length === 5 &&
			parts[4] === "verify"
		) {
			return handleVerifyAttestation(env, taskId, parts[3]);
		}
	}

	return json({ error: "not_found", path: url.pathname }, 404);
}

/* ------------------------------------------------------------------ */
/* Queue consumer — ingestion (spec 5 §2–§3)                           */
/* ------------------------------------------------------------------ */

/**
 * Queue consumer accepts Cloudflare's official `cf.artifacts.repo.pushed`
 * envelope (plus the deterministic internal test envelope). Contender repo
 * names encode the opaque task id, so pushes route to the correct per-task
 * authority without a mutable global registry. Forwards to the task's
 * Durable Object (POST /event) for `event_key`
 * dedupe + authoritative transition, then executes returned effects.
 * Returns normally to ACK; throws only on genuine failure so the message
 * is redelivered (spec 5 §10: MUST NOT drop the event).
 */
export async function queue(batch: QueueBatchLike, env: Env): Promise<void> {
	const port = productionPort(env);
	for (const msg of batch.messages) {
		const routed = normalizeArtifactQueueBody(msg.body);
		// Event subscriptions may share a queue with unrelated Artifacts
		// lifecycle events or pushes to baseline/canonical repositories.
		// Those are intentionally acknowledged without mutating task state.
		if (routed === null) continue;
		const { task_id, event } = routed;
		const res = await doRpc(taskStub(env, task_id), "/event", { body: { event } });
		if (!res.ok) {
			throw new Error(`queue: DO /event failed for task ${task_id}: HTTP ${res.status}`);
		}
		const { outcome, effects } = res.body as {
			outcome: string;
			effects: Effect[];
			event_key: string;
		};
		if (outcome !== "ACK_DUP" && outcome !== "APPLIED_NEW" && outcome !== "REJECTED_OUT_OF_ORDER") {
			throw new Error(`queue: unexpected outcome ${outcome} for task ${task_id}`);
		}
		await executeEffects(port, effects ?? [], env.PROMOTION_WORKFLOW);
	}
}

/* ------------------------------------------------------------------ */
/* PromotionWorkflow — durable retry wrapper (spec 5 §5)               */
/* ------------------------------------------------------------------ */

export interface PromotionWorkflowParams {
	task_id: string;
	permit_id: string;
}

/**
 * Retries of the promotion step: 10 s, 20 s, 40 s, 80 s, 160 s. One attempt
 * is bounded at two minutes, well inside the five minutes its Artifacts
 * tokens live (the container's own exec deadline is 60 s).
 */
export const PROMOTION_STEP_CONFIG = {
	retries: { limit: 5, delay: "10 seconds", backoff: "exponential" },
	timeout: "2 minutes",
} as const;

/**
 * The permit's promotion as a durable Workflow instance: POST
 * /tasks/:id/promote creates it with the permit id as its instance id, so
 * there is at most one per permit. Its one step runs runPromotion. A retry
 * after a lost response is safe because promotion creates no commit:
 * container/promote.sh fast-forwards the destination to the reviewed
 * candidate itself, so on a retry it finds that commit already in the
 * destination's history (even under later commits), reports ALREADY_WRITTEN,
 * and the task authority consumes the same permit. Only 5xx answers and
 * exceptions are retried; 409s (expired head, tree or baseline mismatch, a
 * refused push, an unsupported tree entry, a quarantined candidate) are
 * terminal and leave the permit unconsumed
 * (specs/amendments/rebase-ancestry-v1.md,
 * specs/amendments/promotion-runtime-v1.md).
 */
export class PromotionWorkflow extends WorkflowEntrypoint<Env, PromotionWorkflowParams> {
	async run(event: WorkflowEvent<PromotionWorkflowParams>, step: WorkflowStep) {
		const p = event.payload;
		if (!p || typeof p.task_id !== "string" || typeof p.permit_id !== "string") {
			throw new Error("PromotionWorkflow: invalid payload");
		}
		return step.do(`promote/${p.permit_id}`, PROMOTION_STEP_CONFIG, async () => {
			const { status, body } = await runPromotion(this.env, p.task_id, p.permit_id);
			const text = JSON.stringify(body);
			// 5xx is an infrastructure failure: throw, and the step retries.
			if (status >= 500) throw new Error(`promotion attempt failed: HTTP ${status} ${text}`);
			// A step result must be Rpc.Serializable: the JSON text is, a parsed
			// `unknown` is not. The status route parses it.
			return { status, body: text };
		});
	}
}

/* ------------------------------------------------------------------ */
/* Module-worker export shape                                           */
/* ------------------------------------------------------------------ */

export default {
	fetch,
	queue,
};
