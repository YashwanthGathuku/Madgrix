/**
 * Worker entry point for MADGRIX.
 *
 * # What this file is
 *
 * Production Cloudflare control-plane wiring for the competition path:
 * Artifacts, Queue ingestion, per-task Durable Object authority, independent
 * trust-zone identities, Verdict Seam execution, durable promotion Workflow,
 * and exact-state canonical Git promotion through the trusted container.
 *
 * The local deterministic slice still uses FakeArtifacts for repeatable tests;
 * scripts/live-e2e.ts is the real-infrastructure path and intentionally fails
 * unless real Artifacts push events reach Queue → TaskAuthority.
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
 * - The promotion service is the ONLY canonical writer (spec 3 §2). The
 *   `/promote` route below is a skeleton that performs the platform-owned
 *   preconditions (permit lookup, consumed check, quarantine check,
 *   destination-HEAD check, tree check); the canonical write itself happens
 *   in the merge sandbox with a merge-scoped token (spec 5 §7).
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
import type { Effect } from "../lib/task-state.ts";
import { resolveAgentBySecret, taskHashFor } from "../lib/task-state.ts";
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

async function readJsonBody(
	request: Request,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: Response }> {
	try {
		const body = (await request.json()) as Record<string, unknown>;
		return { ok: true, body };
	} catch {
		return { ok: false, response: json({ error: "invalid_json" }, 400) };
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
	let body: unknown = null;
	try {
		body = await res.json();
	} catch {
		body = null;
	}
	return { ok: res.ok, status: res.status, body };
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

class BindingRepo implements ArtifactsRepo {
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

	/** Convenience over log({ ref, limit: 1 }); no direct binding equivalent. */
	async getHead(ref: string = "main"): Promise<string | null> {
		const entries = await this.binding.log({ ref, limit: 1 });
		return entries.length > 0 ? entries[0].hash : null;
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
		return new BindingRepo(b, info.name, info.remote);
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
	return (
		typeof v === "object" &&
		v !== null &&
		typeof (v as { adminPush?: unknown }).adminPush === "function"
	);
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
	const res = await doRpc(taskStub(env, task_id), "/init", {
		body: { task, verifier_keys, operator_keys },
	});
	if (!res.ok) return json({ error: "authority_init_failed", detail: res.body }, 502);
	return json({ task_id, task_hash, frozen_at }, 201);
}

/**
 * Per-agent secret header. Every agent shares AGENT_SERVICE_TOKEN; this
 * secret, returned once by an agent's first /claim, says WHICH agent is
 * calling (specs/amendments/contender-agent-binding.md).
 */
const AGENT_SECRET_HEADER = "x-madgrix-agent-secret";

/** A claim as exposed outside the authority: without the secret's hash. */
function publicClaim(claim: WorkClaim): Omit<WorkClaim, "agent_secret_sha256"> {
	const { agent_secret_sha256: _hash, ...rest } = claim;
	return rest;
}

/**
 * POST /tasks/:id/claim — forward a WorkClaim to the task authority. An
 * agent's first claim returns its secret once (`agent_secret`); a later
 * claim for the same agent must send it in X-Madgrix-Agent-Secret.
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

	const stateRes = await doRpc(taskStub(env, taskId), "/state", { method: "GET" });
	if (!stateRes.ok) return json({ error: "task_not_found", task_id: taskId }, 404);
	const state = stateRes.body as AuthorityState;
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
	const { repo, created, initialTokenPlaintext, viaImportFallback } = await forkIdempotent(
		port,
		state.task.baseline_repo,
		forkName,
	);

	// Cloudflare's Artifacts beta fork endpoint is currently broken
	// server-side. forkIdempotent falls back to creating an empty repo; when
	// that happens we reproduce fork semantics by copying the frozen baseline
	// commit through the trusted Git container before issuing a contender
	// credential.
	if (created && viaImportFallback) {
		if (initialTokenPlaintext === null) {
			return json({ error: "fork_fallback_missing_write_token", fork_repo: forkName }, 502);
		}
		const baseline = await port.get(state.task.baseline_repo);
		const sourceToken = await baseline.createToken("read", 300);
		try {
			const copyRes = await promotionStub(env, `fork-${forkOpId}`).fetch(
				new Request("https://promotion/copy-baseline", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						action: "copy_baseline",
						op_id: forkOpId,
						source_remote: baseline.remote,
						source_token: sourceToken.plaintext,
						source_commit: state.task.baseline_commit,
						destination_remote: repo.remote,
						destination_token: initialTokenPlaintext,
					}),
				}),
			);
			const copy = (await copyRes.json()) as { outcome?: string; head?: string; error?: string };
			if (!copyRes.ok || (copy.outcome !== "IMPORTED" && copy.outcome !== "ALREADY_IMPORTED")) {
				return json({ error: "fork_baseline_import_failed", detail: copy }, 502);
			}
			if (copy.head !== state.task.baseline_commit) {
				return json({ error: "fork_baseline_head_mismatch", expected: state.task.baseline_commit, actual: copy.head }, 502);
			}
		} finally {
			await Promise.allSettled([
				baseline.revokeToken(sourceToken.id),
				repo.revokeToken(initialTokenPlaintext),
			]);
		}
	} else if (created && initialTokenPlaintext !== null) {
		// The fork-creation token has the binding default TTL (24h) — too
		// long for a contender. Revoke it; the contender gets a ≤1h token.
		await repo.revokeToken(initialTokenPlaintext);
	}

	const credentials = await issueContenderCredentials(port, forkName, 3600);
	const latest_commit = await repo.getHead();
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
}

/** GET /tasks/:id/context — non-secret frozen task + work graph context. */
export async function handleTaskContext(env: Env, taskId: string, request: Request): Promise<Response> {
	if (!(await requireAgentOrControl(request, env))) return json({ error: "task_context_auth_required" }, 401);
	const stateRes = await doRpc(taskStub(env, taskId), "/state", { method: "GET" });
	if (!stateRes.ok) return json({ error: "task_not_found", task_id: taskId }, 404);
	const state = stateRes.body as AuthorityState;
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
	});
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
	const stateRes = await doRpc(taskStub(env, taskId), "/state", { method: "GET" });
	if (!stateRes.ok) return json({ error: "task_not_found", task_id: taskId }, 404);
	const state = stateRes.body as AuthorityState;
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
	});
}

/**
 * POST /tasks/:id/evidence — accept an evaluation bundle from the
 * evaluation domain and record it in the task authority. The caller must
 * present EVALUATION_SERVICE_TOKEN (spec 3 §2): evidence is only admissible
 * from the evaluation domain (spec 3 §6, attack 6). The authority's answer
 * passes through: 422 for a bundle it rejects, 409 for a replacement of a
 * labeled candidate's evidence (specs/amendments/evidence-integrity-v1.md).
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
	return json(res.body, res.status);
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
	const destination_head = await dest.getHead();
	if (!destination_head) return json({ error: "destination_head_not_found", destination_repo }, 409);
	const pr = await doRpc(taskStub(env, taskId), "/permit", {
		body: { winner_sha: verdict.winner_sha, destination_repo, destination_head },
	});
	if (!pr.ok) return json({ verdict, error: "permit_issue_failed", detail: pr.body }, pr.status);
	return json({ verdict, ...(pr.body as Record<string, unknown>) }, 200);
}

/**
 * POST /tasks/:id/promote — exact-state canonical promotion.
 * The Worker validates the permit/evidence, mints short-lived Git
 * capabilities, delegates the single canonical write to the trusted
 * promotion container, then atomically finalizes/consumes the permit.
 */
export async function handlePromote(
	env: Env,
	taskId: string,
	request: Request,
): Promise<Response> {
	if (!(await requireControlPlane(request, env))) return json({ error: "control_plane_auth_required" }, 401);
	const parsed = await readJsonBody(request);
	if (!parsed.ok) return parsed.response;
	const permit_id = parsed.body["permit_id"];
	if (typeof permit_id !== "string" || permit_id === "") {
		return json({ error: "permit_id_required" }, 400);
	}

	const stateRes = await doRpc(taskStub(env, taskId), "/state", { method: "GET" });
	if (!stateRes.ok) return json({ error: "task_not_found", task_id: taskId }, 404);
	const state = stateRes.body as AuthorityState;
	const permit = (state.permits as Record<string, PermitRecord>)[permit_id];
	if (!permit) return json({ outcome: "UNKNOWN_PERMIT" satisfies PromotionOutcome, permit_id }, 404);
	if (permit.consumed) {
		return json({ outcome: "ALREADY_CONSUMED" satisfies PromotionOutcome, permit_id }, 200);
	}
	const quarantine = state.quarantine[permit.contender_id];
	if (quarantine?.status === "QUARANTINED") {
		return json({ outcome: "QUARANTINED_CANDIDATE" satisfies PromotionOutcome, permit_id }, 409);
	}
	const contender = state.contenders[permit.contender_id];
	if (!contender) return json({ error: "winner_contender_not_found", permit_id }, 409);

	const recomputed = await computePermitId({
		task_hash: permit.task_hash,
		baseline_commit: permit.baseline_commit,
		winning_tree_sha256: permit.winning_tree_sha256,
		evaluation_bundle_hash: permit.evaluation_bundle_hash,
		selector_policy_hash: permit.selector_policy_hash,
		expected_destination_head: permit.expected_destination_head,
	});
	if (recomputed !== permit_id) return json({ error: "permit_id_invalid", permit_id }, 409);

	const storedBundle = state.evaluations[permit.winner_candidate_sha];
	if (!storedBundle || storedBundle.bundle_hash !== permit.evaluation_bundle_hash) {
		return json({
			outcome: "EVAL_BUNDLE_MISMATCH" satisfies PromotionOutcome,
			permit_id,
			permit_bundle_hash: permit.evaluation_bundle_hash,
			stored_bundle_hash: storedBundle?.bundle_hash ?? null,
		}, 409);
	}

	const port = productionPort(env);
	const sourceRepo = await port.get(contender.fork_repo);
	const candidate = await sourceRepo.readCommit(permit.winner_candidate_sha);
	if (candidate === null) {
		return json({ outcome: "TREE_MISMATCH" satisfies PromotionOutcome, permit_id, detail: "candidate commit missing from contender repo" }, 409);
	}
	const destinationRepo = await port.get(permit.destination_repo);
	const currentHead = await destinationRepo.getHead();
	// Pre-check only. The Git push inside the trusted promotion container is
	// the final compare-and-swap and catches a race after this read.
	if (currentHead !== permit.expected_destination_head) {
		// A retry after a successful push is reconciled by the promotion
		// container, so only reject immediately when the permit cannot have
		// been our own previous exact-state write.
		// We do not know that deterministic commit id here; let the container
		// compute it and distinguish ALREADY_WRITTEN from a foreign head move.
	}

	// The only credentials with canonical write authority are minted here and
	// live for at most five minutes. They are never persisted or logged.
	const sourceToken = await sourceRepo.createToken("read", 300);
	const destinationToken = await destinationRepo.createToken("write", 300);
	try {
		const promoRes = await promotionStub(env, permit_id).fetch(
			new Request("https://promotion/run", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					permit_id,
					source_remote: sourceRepo.remote,
					source_token: sourceToken.plaintext,
					candidate_sha: permit.winner_candidate_sha,
					destination_remote: destinationRepo.remote,
					destination_token: destinationToken.plaintext,
					expected_destination_head: permit.expected_destination_head,
					winning_tree_sha256: permit.winning_tree_sha256,
					issued_at: permit.issued_at,
				}),
			}),
		);
		const promotion = (await promoRes.json()) as {
			outcome?: string;
			promoted_sha?: string;
			tree_sha256?: string;
			parent?: string;
			detail?: string;
		};
		if (!promoRes.ok) {
			const status =
				promotion.outcome === "EXPIRED_HEAD_MOVED" ||
				promotion.outcome === "TREE_MISMATCH" ||
				promotion.outcome === "BASELINE_MISMATCH"
					? 409
					: 502;
			return json({ ...promotion, permit_id }, status);
		}
		if (
			(promotion.outcome !== "PROMOTED" && promotion.outcome !== "ALREADY_WRITTEN") ||
			promotion.tree_sha256 !== permit.winning_tree_sha256 ||
			promotion.parent !== permit.expected_destination_head
		) {
			return json({ error: "promotion_container_invalid_result", permit_id, promotion }, 502);
		}

		// Consume the permit only AFTER the canonical write is known to exist.
		// If this RPC is lost after the Git push, retry reconciliation returns
		// ALREADY_WRITTEN and this same finalization safely runs again.
		// The authority consumes the permit and signs the ship record (the
		// promotion bundle) in the same transaction (spec 1 §11).
		const finalized = await doRpc(taskStub(env, taskId), "/promotion/finalize", {
			body: {
				permit_id,
				verified_parent: permit.expected_destination_head,
				tree_sha256: permit.winning_tree_sha256,
				promoted_sha: promotion.promoted_sha,
			},
		});
		if (!finalized.ok) {
			return json({
				error: "promotion_written_but_finalize_pending",
				permit_id,
				promoted_sha: promotion.promoted_sha,
				detail: finalized.body,
			}, 503);
		}
		return json({
			outcome: "PROMOTED" satisfies PromotionOutcome,
			permit_id,
			promoted_sha: promotion.promoted_sha,
			reconciled_existing_write: promotion.outcome === "ALREADY_WRITTEN",
		});
	} finally {
		// Revocation is best-effort but happens even when Git/evaluation fails.
		await Promise.allSettled([
			sourceRepo.revokeToken(sourceToken.id),
			destinationRepo.revokeToken(destinationToken.id),
		]);
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
	const res = await doRpc(taskStub(env, taskId), "/state", { method: "GET" });
	if (!res.ok) return json({ error: "task_not_found", task_id: taskId }, 404);
	const state = res.body as AuthorityState;
	return json({ task_id: taskId, ledger: state.ledger });
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
	const stateRes = await doRpc(taskStub(env, taskId), "/state", { method: "GET" });
	if (!stateRes.ok) return json({ error: "task_not_found", task_id: taskId }, 404);
	const state = stateRes.body as AuthorityState;
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
		currentHead = await (await port.get(permit.destination_repo)).getHead();
	} catch {
		currentHead = null;
	}

	return json({
		permit_id: permitId,
		permit_id_valid: recomputed === permitId,
		consumed: permit.consumed,
		consumed_at: permit.consumed_at,
		expected_destination_head: permit.expected_destination_head,
		current_destination_head: currentHead,
		head_matches: currentHead === permit.expected_destination_head,
		task_hash: permit.task_hash,
		winner_candidate_sha: permit.winner_candidate_sha,
		note: "Platform-level verification only. Full attestation (in-toto + DSSE + Sigstore) is spec 4, protocol-layer.",
	});
}

/* ------------------------------------------------------------------ */
/* Effect execution — the DO returns effects; THIS layer executes them  */
/* ------------------------------------------------------------------ */

/**
 * Execute the effects returned by the task authority's /event RPC.
 * Called by the queue consumer (and, in production, by Workflow steps).
 * The DO itself never executes side effects (spec 5 §3).
 */
export async function executeEffects(port: ArtifactsPort, effects: Effect[]): Promise<void> {
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
				// SKELETON: Workflow instance cancellation belongs to the
				// Workflow layer (workflow instance id → terminate). Logged
				// here so a retry does not silently drop the intent.
				console.warn(
					`executeEffects: cancel_workflow skeleton — contender ${effect.contender_id}: no workflow runtime wired`,
				);
				break;
			}
			case "notify": {
				// SKELETON: production routes to a notification channel.
				console.log(`[notify] to=${effect.to.join(",")}: ${effect.message}`);
				break;
			}
			case "canonical_write": {
				// Canonical writes ONLY happen through the promote route /
				// merge sandbox (spec 3 §2, spec 5 §7). An effect carrying a
				// canonical write is a protocol-layer signal; executing it
				// here would bypass the promotion service. Log and stop.
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

export async function fetch(request: Request, env: Env): Promise<Response> {
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
		await executeEffects(port, effects ?? []);
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
 * Durable wrapper around the exact-state promotion operation. The permit id
 * is the idempotent step name. A retry after a lost response is safe because
 * the promotion container deterministically reconstructs the same commit and
 * reports ALREADY_WRITTEN; the task authority then consumes the same permit.
 */
export class PromotionWorkflow extends WorkflowEntrypoint<Env, PromotionWorkflowParams> {
	async run(event: WorkflowEvent<PromotionWorkflowParams>, step: WorkflowStep) {
		const p = event.payload;
		if (!p || typeof p.task_id !== "string" || typeof p.permit_id !== "string") {
			throw new Error("PromotionWorkflow: invalid payload");
		}
		return step.do(`promote/${p.permit_id}`, async () => {
			const res = await handlePromote(
				this.env,
				p.task_id,
				new Request("https://workflow/promote", {
					method: "POST",
					headers: {
						"content-type": "application/json",
						authorization: `Bearer ${this.env.CONTROL_SERVICE_TOKEN}`,
					},
					body: JSON.stringify({ permit_id: p.permit_id }),
				}),
			);
			const body = await res.text();
			// 5xx means an infrastructure/transient failure: let Workflows retry.
			if (res.status >= 500) {
				throw new Error(`promotion transient failure: HTTP ${res.status} ${body}`);
			}
			// A step result must be Rpc.Serializable: the JSON text is, a parsed
			// `unknown` is not.
			return { status: res.status, body };
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
