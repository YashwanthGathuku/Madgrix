/**
 * TaskAuthority — THIN Durable Object wrapper over the pure protocol logic
 * in `src/lib/task-state.ts` (sibling-owned; internal codename: seam —
 * NOT a public brand).
 *
 * Design rules (spec 5 §3–§4):
 * - One Durable Object per task id. It is the AUTHORITATIVE state machine:
 *   every transition runs inside a storage transaction; no component may
 *   hold competing authoritative state.
 * - The DO NEVER executes side effects. `ingestQueueEvent` returns `Effect[]`
 *   values; they are RETURNED to the caller (the queue consumer / Workflow
 *   layer in the Worker) which executes them. A duplicated Queue delivery
 *   therefore converges to ACK-without-effect via the `event_key` seen-set.
 * - All state transitions go through the pure functions in
 *   `src/lib/task-state.ts` inside a storage transaction: `/event` →
 *   `ingestQueueEvent`; `/claim` → `registerClaim` (validates the claim,
 *   assigns work_id, classifies conflicts against live claims);
 *   `/evidence` → `submitEvaluation` (rejects bundles for a different
 *   task). `/contender` remains a provisional record-ingestion endpoint
 *   (the control plane inserts contender records after forking); verdict,
 *   permit, and quarantine logic lives in task-state.ts.
 *
 * Structural typing note: this class does NOT extend a real DurableObject
 * (no base class importable here; see workers.d.ts). The runtime only needs
 * the `(state, env)` constructor and `fetch(request)`.
 */

import {
	createAuthority,
	ingestQueueEvent,
	registerClaim,
	registerOperatorKeys,
	registerVerifierKeys,
	submitEvaluation,
	type Ctx,
	type Effect,
	type NewClaimInput,
} from "../lib/task-state.ts";
import type {
	AuthorityState,
	CallerIdentity,
	ContenderRecord,
	EvaluationBundle,
	QueuePushEvent,
	TaskRecord,
} from "../lib/types.ts";
import { joinHashParts, randomHex, sha256Hex } from "../lib/canonical.ts";
import { SELECTOR_POLICY_VERSION } from "../lib/types.ts";

/** Frozen spec 1 §10: permit = SHA256(task_hash || baseline || winning_tree
 *  || eval_bundle || policy || expected_destination_head), with "||"
 *  encoded as NUL separators per canonical.ts convention. Re-exported so
 *  the Worker and the Node harness share ONE implementation. */
export async function computePermitId(args: {
	task_hash: string;
	baseline_commit: string;
	winning_tree_sha256: string;
	evaluation_bundle_hash: string;
	selector_policy_hash: string;
	expected_destination_head: string;
}): Promise<string> {
	return sha256Hex(
		joinHashParts(
			args.task_hash,
			args.baseline_commit,
			args.winning_tree_sha256,
			args.evaluation_bundle_hash,
			args.selector_policy_hash,
			args.expected_destination_head,
		),
	);
}

/**
 * The exact policy input hashed into `selectorPolicyHash` for the production
 * Ctx. This string is the frozen selector policy identity (gates v1,
 * dominance ranking v1, 2-of-3 blind verifier vote); changing it changes
 * every downstream hash, which is intentional.
 */
export const SELECTOR_POLICY_INPUT = "seam-policy/0.1.0|gates:v1|dominance:v1|vote:2of3";

let cachedSelectorPolicyHash: string | null = null;

async function selectorPolicyHash(): Promise<string> {
	if (cachedSelectorPolicyHash === null) {
		cachedSelectorPolicyHash = await sha256Hex(SELECTOR_POLICY_INPUT);
	}
	return cachedSelectorPolicyHash;
}

/** Production Ctx for ingestQueueEvent: real wall-clock time, real
 *  randomness, WebCrypto SHA-256, frozen policy identity. */
async function productionCtx(): Promise<Ctx> {
	return {
		now: () => new Date().toISOString(),
		randomHex,
		sha256Hex,
		selectorPolicyHash: await selectorPolicyHash(),
		policyVersion: SELECTOR_POLICY_VERSION,
	};
}

const STATE_KEY = "authority-state";

function json(data: unknown, status: number = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});
}

async function readJsonBody(request: Request): Promise<{ ok: true; body: unknown } | { ok: false; response: Response }> {
	try {
		return { ok: true, body: await request.json() };
	} catch {
		return { ok: false, response: json({ error: "invalid_json" }, 400) };
	}
}

export class TaskAuthority {
	private doState: DurableObjectState;
	private doEnv: DurableObjectEnv;

	constructor(state: DurableObjectState, env: DurableObjectEnv) {
		this.doState = state;
		this.doEnv = env;
	}

	private async loadState(): Promise<AuthorityState | null> {
		const st = await this.doState.storage.get<AuthorityState>(STATE_KEY);
		return st ?? null;
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;

		/* ---------------- POST /init — seed the authority ---------------- */
		if (request.method === "POST" && path === "/init") {
			const parsed = await readJsonBody(request);
			if (!parsed.ok) return parsed.response;
			const task = (parsed.body as { task?: TaskRecord }).task;
			if (!task || typeof task.task_id !== "string" || typeof task.task_hash !== "string") {
				return json({ error: "invalid_task", detail: "body.task must be a TaskRecord" }, 400);
			}
			// Optional: verifier + operator public keys, registered at task
			// freeze (spec 1 §8, §9.4). Keys are immutable once registered.
			const body = parsed.body as {
				verifier_keys?: { verifier_id: string; public_key_der_hex: string }[];
				operator_keys?: { public_key_der_hex: string }[];
			};
			const ctx = await productionCtx();
			return this.doState.storage.transaction(async () => {
				const existing = await this.loadState();
				if (existing !== null) {
					return json({ error: "already_initialized", task_id: existing.task.task_id }, 404);
				}
				let state = createAuthority(task);
				try {
					state = await registerVerifierKeys(state, body.verifier_keys ?? [], ctx);
					state = await registerOperatorKeys(state, body.operator_keys ?? [], ctx);
				} catch (err) {
					return json({ error: "key_registration_failed", detail: (err as Error).message }, 400);
				}
				await this.doState.storage.put(STATE_KEY, state);
				return json({ task_id: task.task_id, task_hash: task.task_hash, initialized: true });
			});
		}

		/* --------- POST /event — the ONLY state-transition entrypoint ----- */
		if (request.method === "POST" && path === "/event") {
			const parsed = await readJsonBody(request);
			if (!parsed.ok) return parsed.response;
			const event = (parsed.body as { event?: QueuePushEvent }).event;
			if (!event || typeof event.repo !== "string" || typeof event.after !== "string") {
				return json({ error: "invalid_event", detail: "body.event must be a QueuePushEvent" }, 400);
			}
			const ctx = await productionCtx();
			return this.doState.storage.transaction(async () => {
				const state = await this.loadState();
				if (state === null) {
					return json({ error: "not_initialized" }, 404);
				}
				const result = await ingestQueueEvent(state, event, ctx);
				await this.doState.storage.put(STATE_KEY, result.state);
				// NOTE: effects are RETURNED, not executed. The caller
				// (queue consumer / Workflow) executes them. The DO never
				// performs side effects itself.
				const effects: Effect[] = result.effects;
				return json({ outcome: result.outcome, effects, event_key: result.event_key });
			});
		}

		/* ---- POST /claim — WorkClaim registration (real transition) -------- */
		if (request.method === "POST" && path === "/claim") {
			const parsed = await readJsonBody(request);
			if (!parsed.ok) return parsed.response;
			// The contender supplies the claim INPUT; the authority assigns
			// work_id/status/version via registerClaim (task-state.ts).
			// A body that already carries work_id is rejected — the
			// authority is the sole assigner of claim identity.
			const input = (parsed.body as { claim?: Record<string, unknown> }).claim;
			if (!input || typeof input !== "object" || "work_id" in input) {
				return json(
					{
						error: "invalid_claim",
						detail: "body.claim must be a claim input (no work_id; the authority assigns it)",
					},
					400,
				);
			}
			const ctx = await productionCtx();
			return this.doState.storage.transaction(async () => {
				const state = await this.loadState();
				if (state === null) return json({ error: "not_initialized" }, 404);
				try {
					const r = await registerClaim(state, input as NewClaimInput, ctx);
					await this.doState.storage.put(STATE_KEY, r.state);
					return json({
						recorded: true,
						work_id: r.claim.work_id,
						conflicts: r.reports.map((rep) => ({
							with: rep.claim_b,
							risk: rep.risk,
							explanation: rep.explanation,
						})),
					});
				} catch (err) {
					return json({ error: "claim_rejected", detail: (err as Error).message }, 422);
				}
			});
		}

		/* -- POST /contender — PROVISIONAL contender record ingestion ----- */
		if (request.method === "POST" && path === "/contender") {
			const parsed = await readJsonBody(request);
			if (!parsed.ok) return parsed.response;
			const contender = (parsed.body as { contender?: ContenderRecord }).contender;
			if (!contender || typeof contender.contender_id !== "string") {
				return json({ error: "invalid_contender" }, 400);
			}
			return this.doState.storage.transaction(async () => {
				const state = await this.loadState();
				if (state === null) return json({ error: "not_initialized" }, 404);
				state.contenders[contender.contender_id] = contender;
				await this.doState.storage.put(STATE_KEY, state);
				return json({ recorded: true, contender_id: contender.contender_id });
			});
		}

		/* -- POST /evidence — evaluation bundle from the evaluation domain -- */
		if (request.method === "POST" && path === "/evidence") {
			const parsed = await readJsonBody(request);
			if (!parsed.ok) return parsed.response;
			const body = parsed.body as { bundle?: EvaluationBundle; caller?: CallerIdentity };
			if (!body.bundle || typeof body.bundle.candidate_sha !== "string") {
				return json({ error: "invalid_bundle" }, 400);
			}
			// Caller identity is enforced INSIDE the authority (the zone
			// check in submitEvaluation is what actually decides). Transport-
			// level authentication of this claim is NOT yet verified here —
			// TODO: bind to mTLS / service-token auth at the edge before
			// production. Until then, an unauthenticated local caller defaults
			// to "unknown", which submitEvaluation rejects (fail closed).
			const caller: CallerIdentity = body.caller ?? { zone: "unknown" };
			const ctx = await productionCtx();
			return this.doState.storage.transaction(async () => {
				const state = await this.loadState();
				if (state === null) return json({ error: "not_initialized" }, 404);
				try {
					const { state: next, outcome } = await submitEvaluation(state, body.bundle!, caller, ctx);
					if (outcome === "ACK_DUP")
						return json({ recorded: true, candidate_sha: body.bundle!.candidate_sha, outcome: "ACK_DUP" });
					await this.doState.storage.put(STATE_KEY, next);
					return json({ recorded: true, candidate_sha: body.bundle!.candidate_sha });
				} catch (err) {
					return json({ error: "evidence_rejected", detail: (err as Error).message }, 422);
				}
			});
		}

		/* ---------------- GET /state — debug/introspection ---------------- */
		if (request.method === "GET" && path === "/state") {
			const state = await this.loadState();
			if (state === null) return json({ error: "not_initialized" }, 404);
			return json(state);
		}

		return json({ error: "not_found", path }, 404);
	}
}
