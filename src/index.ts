/**
 * Seam — a governed promotion protocol for autonomous software agents.
 *
 * Pipeline: INTENT → competing implementations → independent evidence
 * → VERDICT → exact-state authorization → promotion → verifiable history.
 *
 * v1 notes (honest):
 * - State is in-memory. Production moves task/claim/ledger state to a
 *   Durable Object; the verdict and attestation logic is already pure and
 *   moves unchanged.
 * - Reviewer agents and hidden-test execution are interfaces here; the seam
 *   treats missing evidence as abstain/reject, never as accept.
 * - Actual git merge into the destination repo lands in v2; v1 records the
 *   exact-state authorization so the merge can be verified offline.
 */

import { detectCollisions, type WorkClaim } from "./lib/intent.ts";
import { decide, selectWinner, type EvidenceVector } from "./lib/verdict.ts";
import { promotionId, sha256Hex } from "./lib/idempotency.ts";
import {
	signAttestation,
	verifyAttestation,
	type PromotionAttestation,
} from "./lib/attestation.ts";

/* ------------------------------------------------------------------ */
/* Artifacts binding surface (per developers.cloudflare.com/artifacts) */
/* ------------------------------------------------------------------ */

interface ArtifactsRepo extends Disposable {
	createToken(
		scope?: "read" | "write",
		ttl?: number,
	): Promise<{ plaintext: string; expiresAt: string }>;
	fork(
		name: string,
		opts?: { description?: string; readOnly?: boolean; defaultBranchOnly?: boolean },
	): Promise<{ name: string; remote: string; token: string }>;
	log(opts?: { ref?: string; limit?: number }): Promise<{ hash: string }[]>;
	readCommit(hash: string): Promise<{ hash: string } | null>;
}

interface Artifacts {
	create(
		name: string,
		opts?: { description?: string; readOnly?: boolean; setDefaultBranch?: string },
	): Promise<{ name: string; remote: string; defaultBranch: string; token: string }>;
	get(name: string): Promise<ArtifactsRepo>;
	list(opts?: { limit?: number }): Promise<{ repos: { name: string; status: string }[] }>;
}

interface Env {
	ARTIFACTS: Artifacts;
	/** v1 signing secret for attestations; production uses a KMS-held key. */
	PROMOTION_SECRET?: string;
}

/* ------------------------------------------------------------------ */
/* Domain state (v1: in-memory; production: Durable Object)            */
/* ------------------------------------------------------------------ */

interface Task {
	task_id: string;
	task_hash: string;
	intent: string;
	baseline_repo: string;
	baseline_commit: string;
	behavior_contract?: string;
	created_at: string;
}

interface Contender {
	contender_id: string;
	task_id: string;
	agent_id: string;
	fork_repo: string;
	remote: string;
	status: "forked" | "submitted";
}

interface LedgerEntry {
	seq: number;
	ts: string;
	task_id: string;
	kind: string;
	payload_hash: string;
}

const tasks = new Map<string, Task>();
const claims = new Map<string, WorkClaim[]>();
const contenders = new Map<string, Contender>();
const evidenceByTask = new Map<string, EvidenceVector[]>();
const ledger: LedgerEntry[] = [];
const promotions = new Map<string, PromotionAttestation>(); // promotion_id -> attestation (single-consume)

export const POLICY_VERSION = "seam-policy/0.1.0";
export const SELECTOR_VERSION = "seam-selector/0.1.0";

async function appendLedger(task_id: string, kind: string, payload: unknown): Promise<LedgerEntry> {
	const entry: LedgerEntry = {
		seq: ledger.length,
		ts: new Date().toISOString(),
		task_id,
		kind,
		payload_hash: await sha256Hex(JSON.stringify(payload)),
	};
	ledger.push(entry);
	return entry;
}

function json(data: unknown, status = 200): Response {
	return Response.json(data, { status });
}

function bad(message: string, status = 400): Response {
	return json({ error: message }, status);
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const parts = url.pathname.split("/").filter(Boolean);
		const parsed: unknown = await request.json().catch(() => ({}));
		const body: Record<string, unknown> =
			typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};

		// POST /tasks — register intent. Everything downstream binds to task_hash.
		if (request.method === "POST" && parts.length === 1 && parts[0] === "tasks") {
			const intent = body.intent;
			const baseline_repo = body.baseline_repo;
			const baseline_commit = body.baseline_commit;
			if (typeof intent !== "string" || typeof baseline_repo !== "string" || typeof baseline_commit !== "string") {
				return bad("intent, baseline_repo and baseline_commit are required");
			}
			const task_id = crypto.randomUUID();
			const task_hash = await sha256Hex(`${intent}|${baseline_repo}|${baseline_commit}`);
			const task: Task = {
				task_id,
				task_hash,
				intent,
				baseline_repo,
				baseline_commit,
				behavior_contract: typeof body.behavior_contract === "string" ? body.behavior_contract : undefined,
				created_at: new Date().toISOString(),
			};
			tasks.set(task_id, task);
			claims.set(task_id, []);
			await appendLedger(task_id, "task_created", { task_hash, baseline_repo, baseline_commit });
			return json({ task_id, task_hash });
		}

		// All routes below need a task.
		if (parts[0] !== "tasks" || parts.length < 2) {
			return bad("unknown route", 404);
		}
		const task = tasks.get(parts[1]);
		if (!task) return bad("unknown task", 404);
		const taskId = task.task_id;

		// POST /tasks/:id/claim — register a work claim; get collision report.
		if (request.method === "POST" && parts[2] === "claim") {
			const scope = body.claimed_scope as WorkClaim["claimed_scope"] | undefined;
			if (typeof body.agent_id !== "string" || !scope || !Array.isArray(scope.paths)) {
				return bad("agent_id and claimed_scope.paths are required");
			}
			const claim: WorkClaim = {
				work_id: crypto.randomUUID(),
				agent_id: body.agent_id,
				task_intent: task.intent,
				baseline_commit: task.baseline_commit,
				claimed_scope: scope,
				behavior_contract: typeof body.behavior_contract === "string" ? body.behavior_contract : "",
				expected_tests: Array.isArray(body.expected_tests) ? (body.expected_tests as string[]) : [],
				status: "claimed",
				claimed_at: new Date().toISOString(),
			};
			const live = claims.get(taskId) ?? [];
			const collisions = detectCollisions(claim, live);
			live.push(claim);
			claims.set(taskId, live);
			await appendLedger(taskId, "work_claimed", {
				work_id: claim.work_id,
				agent_id: claim.agent_id,
				collisions: collisions.length,
			});
			return json({ work_id: claim.work_id, collisions });
		}

		// POST /tasks/:id/contenders — fork the baseline repo for one agent.
		// One repo per agent when work should stay isolated (the platform's
		// blessed pattern); the fork gets a short-lived write token only.
		if (request.method === "POST" && parts[2] === "contenders") {
			if (typeof body.agent_id !== "string") return bad("agent_id is required");
			const contender_id = crypto.randomUUID();
			const forkName = `task-${taskId.slice(0, 8)}-${body.agent_id}-${contender_id.slice(0, 8)}`;
			using repo = await env.ARTIFACTS.get(task.baseline_repo);
			const forked = await repo.fork(forkName, {
				description: `Contender fork for task ${taskId} (agent ${body.agent_id})`,
				defaultBranchOnly: true,
			});
			// Short-lived, write-scoped token minted on the FORK only: the
			// contender can push to its fork and nothing else. The baseline
			// repo never gets a contender-held token.
			using forkHandle = await env.ARTIFACTS.get(forked.name);
			const writeToken = await forkHandle.createToken("write", 3600);
			const contender: Contender = {
				contender_id,
				task_id: taskId,
				agent_id: body.agent_id,
				fork_repo: forked.name,
				remote: forked.remote,
				status: "forked",
			};
			contenders.set(contender_id, contender);
			await appendLedger(taskId, "contender_forked", {
				contender_id,
				agent_id: body.agent_id,
				fork_repo: forked.name,
			});
			// The plaintext token is returned once, at fork time, like the
			// binding's own create() flow. Callers must not log or persist it.
			return json({
				contender_id,
				fork_repo: forked.name,
				remote: forked.remote,
				token: writeToken.plaintext,
				expires_at: writeToken.expiresAt,
			});
		}

		// POST /tasks/:id/evidence — submit an evidence vector for a contender.
		if (request.method === "POST" && parts[2] === "evidence") {
			const ev = body as unknown as EvidenceVector;
			if (typeof ev.contender_id !== "string" || typeof ev.candidate_commit !== "string") {
				return bad("contender_id and candidate_commit are required");
			}
			if (!contenders.has(ev.contender_id)) return bad("unknown contender", 404);
			const list = evidenceByTask.get(taskId) ?? [];
			const ix = list.findIndex((e) => e.contender_id === ev.contender_id);
			if (ix >= 0) list[ix] = ev;
			else list.push(ev);
			evidenceByTask.set(taskId, list);
			const c = contenders.get(ev.contender_id)!;
			c.status = "submitted";
			await appendLedger(taskId, "evidence_submitted", {
				contender_id: ev.contender_id,
				candidate_commit: ev.candidate_commit,
			});
			// Run the seam immediately so the verdict is deterministic and auditable.
			return json({ verdict: decide(ev) });
		}

		// POST /tasks/:id/verdict — run the selector over all contenders.
		if (request.method === "POST" && parts[2] === "verdict") {
			const vectors = evidenceByTask.get(taskId) ?? [];
			if (vectors.length === 0) return bad("no evidence submitted yet", 409);
			const { winner, results } = selectWinner(vectors);
			await appendLedger(taskId, "verdict_reached", { winner, decisions: results });
			return json({ winner, results, policy_version: POLICY_VERSION });
		}

		// POST /tasks/:id/promote — exact-state, single-consume promotion.
		if (request.method === "POST" && parts[2] === "promote") {
			const secret = env.PROMOTION_SECRET;
			if (!secret) return bad("promotion is not configured (PROMOTION_SECRET missing)", 500);
			const { winner_commit, candidate_commit, destination_repo } = body as Record<string, unknown>;
			if (
				typeof winner_commit !== "string" ||
				typeof candidate_commit !== "string" ||
				typeof destination_repo !== "string"
			) {
				return bad("winner_commit, candidate_commit and destination_repo are required");
			}
			// Exact-state: the shipped commit must be the reviewed candidate.
			if (winner_commit !== candidate_commit) {
				return bad("exact-state violation: winner_commit differs from the reviewed candidate_commit", 409);
			}
			const vectors = evidenceByTask.get(taskId) ?? [];
			const { winner } = selectWinner(vectors);
			if (!winner) return bad("no accepted contender to promote", 409);
			const winnerEv = vectors.find((v) => v.contender_id === winner)!;
			if (winnerEv.candidate_commit !== candidate_commit) {
				return bad("candidate_commit does not match the winning evidence vector", 409);
			}
			// Idempotency: same inputs → same key → single consume.
			const pid = await promotionId(taskId, task.baseline_commit, candidate_commit, POLICY_VERSION);
			const existing = promotions.get(pid);
			if (existing) {
				return json({ promotion_id: pid, status: "already_promoted", attestation: existing });
			}
			const contender = contenders.get(winner)!;
			const attestation = await signAttestation(
				{
					task_hash: task.task_hash,
					baseline_commit: task.baseline_commit,
					candidate_commit,
					candidate_repo: contender.fork_repo,
					agent_identity: contender.agent_id,
					harness_version: SELECTOR_VERSION,
					tool_receipts_hash: await sha256Hex(JSON.stringify(winnerEv.checks)),
					evaluation_bundle_hash: await sha256Hex(JSON.stringify(winnerEv)),
					reviewer_verdict_hashes: await Promise.all(
						winnerEv.reviewers.map((r) => sha256Hex(JSON.stringify(r))),
					),
					policy_version: POLICY_VERSION,
					selector_version: SELECTOR_VERSION,
					winner_commit,
					destination_repo,
					destination_parent_commit: task.baseline_commit,
					final_tree_hash: candidate_commit, // v1: tree hash resolution lands with the merge agent
				},
				secret,
			);
			promotions.set(pid, attestation);
			await appendLedger(taskId, "promoted", { promotion_id: pid, winner_commit });
			return json({ promotion_id: pid, status: "promoted", attestation });
		}

		// GET /tasks/:id/ledger — the verifiable history for this task.
		if (request.method === "GET" && parts[2] === "ledger") {
			return json({ task_id: taskId, entries: ledger.filter((e) => e.task_id === taskId) });
		}

		// GET /tasks/:id/attestation/:pid/verify — offline verification hook.
		if (request.method === "GET" && parts[2] === "attestation" && parts[4] === "verify") {
			const secret = env.PROMOTION_SECRET;
			if (!secret) return bad("verification is not configured (PROMOTION_SECRET missing)", 500);
			const att = promotions.get(parts[3]);
			if (!att) return bad("unknown promotion", 404);
			const failure = await verifyAttestation(att, secret);
			return json({ valid: failure === null, failure });
		}

		return bad("unknown route", 404);
	},
} satisfies ExportedHandler<Env>;
