/**
 * THE task-authority state machine (spec 5 §4 + spec 1 pipeline).
 *
 * All functions are pure over AuthorityState: they take a state and
 * return a new state, never mutating in place, never touching I/O. The
 * Durable Object wrapper (platform layer) persists the returned state.
 * Every transition appends a ledger entry whose payload hash is
 * sha256Hex(canonicalJson(payload)).
 *
 * Deviation note: several transitions below are async even though a
 * first sketch might declare them sync (registerClaim, commitVerifier,
 * submitVerifierReport, quarantineContender, reviewQuarantine,
 * escalateToOperator). This is deliberate — the ledger invariant
 * ("every transition appends a content-hashed entry") requires async
 * hashing, and a sync signature would force unhashed placeholder
 * entries. Async is the honest encoding.
 */

import {
	canonicalJson,
	joinHashParts,
	randomHex as defaultRandomHex,
	sha256Hex as defaultSha256Hex,
} from "./canonical.ts";
import { checkPromotion, createPermit } from "./permit.ts";
import { classifyPair, validateClaim, type ClaimInput } from "./claims.ts";
import { verifyReveal } from "./verifiers.ts";
import { runVerdict, type RankedCandidate } from "./verdict-seam.ts";
import { SELECTOR_POLICY_VERSION } from "./types.ts";
import type {
	AuthorityState,
	ConflictReport,
	EvaluationBundle,
	LedgerEntry,
	PermitRecord,
	PromotionOutcome,
	QueuePushEvent,
	QuarantineRecord,
	QuarantineTrigger,
	ReferenceReport,
	TaskRecord,
	VerdictRecord,
	VerdictReport,
	VerifierCommitment,
	WorkClaim,
} from "./types.ts";

/** Claim fields the contender supplies (work_id/status/version assigned here). */
export type NewClaimInput = ClaimInput;

export interface Ctx {
	now(): string;
	randomHex(n: number): string;
	sha256Hex(i: string | Uint8Array): Promise<string>;
	selectorPolicyHash: string;
	policyVersion: string;
}

export function defaultCtx(selectorPolicyHash: string): Ctx {
	return {
		now: () => new Date().toISOString(),
		randomHex: defaultRandomHex,
		sha256Hex: defaultSha256Hex,
		selectorPolicyHash,
		policyVersion: SELECTOR_POLICY_VERSION,
	};
}

/** Side effects the authority REQUESTS; the platform layer executes them. */
export type Effect =
	| { kind: "revoke_token"; repo: string; token_id: string }
	| { kind: "cancel_workflow"; contender_id: string }
	| { kind: "notify"; to: string[]; message: string }
	| { kind: "canonical_write"; repo: string; tree_sha256: string; parent: string };

/** Append a content-hashed ledger entry (async — hashing is async). */
export async function appendLedger(
	state: AuthorityState,
	kind: string,
	payload: unknown,
	ctx: Ctx,
): Promise<AuthorityState> {
	const payload_hash = await ctx.sha256Hex(canonicalJson(payload));
	const entry: LedgerEntry = { seq: state.ledger.length, ts: ctx.now(), kind, payload_hash };
	return { ...state, ledger: [...state.ledger, entry] };
}

/**
 * Create the authority for a frozen task. The genesis ledger entry
 * documents task creation; it carries an empty payload hash because
 * hashing is async and this constructor is sync — every subsequent
 * entry is content-hashed via appendLedger.
 */
export function createAuthority(task: TaskRecord): AuthorityState {
	return {
		task,
		task_status: "frozen",
		contenders: {},
		claims: [],
		evaluations: {},
		verifier_commitments: {},
		verifier_reveals: {},
		verdict_reports: [],
		verdicts: [],
		permits: {},
		quarantine: {},
		candidate_labels: {},
		seen_event_keys: [],
		escalations: [],
		ledger: [{ seq: 0, ts: task.frozen_at, kind: "authority_created", payload_hash: "" }],
	};
}

/** task_hash = SHA256(canonical_json(task_record)) (spec 1 §5). */
export async function taskHashFor(
	r: {
		intent: string;
		baseline_repo: string;
		baseline_commit: string;
		behavior_contract: string;
		policy_version: string;
		frozen_at: string;
	},
	sha256Hex: (i: string | Uint8Array) => Promise<string>,
): Promise<string> {
	return sha256Hex(canonicalJson(r));
}

/* ------------------------------------------------------------------ */
/* Queue ingestion: at-least-once, unordered → event_key dedupe.        */
/* ------------------------------------------------------------------ */

export type IngestOutcome = "ACK_DUP" | "APPLIED_NEW" | "REJECTED_OUT_OF_ORDER";

/**
 * Ingest a Cloudflare Queue push event (spec 5 §3). event_key is derived
 * from content only — never from Queue metadata.
 *
 * - Seen key → ACK_DUP (idempotent; no state change, no effects).
 * - New key + repo matches a known contender fork → latest_commit=after, APPLIED_NEW.
 * - New key + unknown repo → REJECTED_OUT_OF_ORDER: ledgered, NOT applied.
 *   (Out-of-order delivery for a known repo is absorbed by
 *   latest_commit=after being the newest observed; unknown repos are not
 *   silently adopted.)
 */
export async function ingestQueueEvent(
	state: AuthorityState,
	event: QueuePushEvent,
	ctx: Ctx,
): Promise<{ state: AuthorityState; outcome: IngestOutcome; effects: Effect[]; event_key: string }> {
	const event_key = await ctx.sha256Hex(
		joinHashParts(event.namespace, event.repo, event.ref, event.before, event.after),
	);
	if (state.seen_event_keys.includes(event_key)) {
		return { state, outcome: "ACK_DUP", effects: [], event_key };
	}
	const withKey: AuthorityState = {
		...state,
		seen_event_keys: [...state.seen_event_keys, event_key],
	};
	const contenderId = Object.keys(withKey.contenders).find(
		(id) => withKey.contenders[id].fork_repo === event.repo,
	);
	if (contenderId === undefined) {
		const s2 = await appendLedger(
			withKey,
			"queue_event_rejected_out_of_order",
			{ event_key, repo: event.repo, ref: event.ref },
			ctx,
		);
		return { state: s2, outcome: "REJECTED_OUT_OF_ORDER", effects: [], event_key };
	}
	const updated = {
		...withKey.contenders[contenderId],
		latest_commit: event.after,
	};
	const s2 = await appendLedger(
		{ ...withKey, contenders: { ...withKey.contenders, [contenderId]: updated } },
		"queue_event_applied",
		{ event_key, contender_id: contenderId, after: event.after },
		ctx,
	);
	return { state: s2, outcome: "APPLIED_NEW", effects: [], event_key };
}

/* ------------------------------------------------------------------ */
/* Claims                                                              */
/* ------------------------------------------------------------------ */

/**
 * Register a contender's WorkClaim BEFORE forking or writing code
 * (spec 2 §2). Validates via claims.ts (task/baseline must match the
 * frozen task; empty scope.paths rejected), assigns work_id, version 1,
 * status "claimed", and classifies against all live claims.
 * Throws on validation failure — registration rejection is not a state.
 */
export async function registerClaim(
	state: AuthorityState,
	input: NewClaimInput,
	ctx: Ctx,
): Promise<{ state: AuthorityState; claim: WorkClaim; reports: ConflictReport[] }> {
	const v = validateClaim(input);
	if (!v.ok) throw new Error(`claim rejected: ${v.error}`);
	if (input.task !== state.task.task_hash)
		throw new Error(
			`claim rejected: task mismatch (claim references ${input.task}, task is ${state.task.task_hash}) — stale work (spec 1 §5)`,
		);
	if (input.baseline !== state.task.baseline_commit)
		throw new Error(
			`claim rejected: baseline mismatch (claim ${input.baseline} != frozen ${state.task.baseline_commit})`,
		);
	const claim: WorkClaim = {
		...input,
		work_id: "W-" + ctx.randomHex(4),
		status: "claimed",
		version: 1,
	};
	const live = state.claims.filter((c) => c.status === "claimed" || c.status === "active");
	const reports = live.map((c) => classifyPair(claim, c));
	const s2 = await appendLedger(
		{ ...state, claims: [...state.claims, claim] },
		"claim_registered",
		{ work_id: claim.work_id, agent: claim.agent, risk: reports.map((r) => r.risk) },
		ctx,
	);
	return { state: s2, claim, reports };
}

/* ------------------------------------------------------------------ */
/* Evaluations (submitted by the evaluation domain only)                */
/* ------------------------------------------------------------------ */

/** Store an evaluation bundle. Bundles arrive only from the evaluation
 *  domain; contender-supplied "evidence" is inadmissible by construction
 *  (spec 3 §6 attack #6). Rejects bundles for a different task. */
export async function submitEvaluation(
	state: AuthorityState,
	bundle: EvaluationBundle,
	ctx: Ctx,
): Promise<AuthorityState> {
	if (bundle.task_hash !== state.task.task_hash)
		throw new Error("evaluation rejected: task_hash mismatch");
	const s2: AuthorityState = {
		...state,
		evaluations: { ...state.evaluations, [bundle.candidate_sha]: bundle },
	};
	return appendLedger(
		s2,
		"evaluation_submitted",
		{
			candidate_sha: bundle.candidate_sha,
			bundle_hash: bundle.bundle_hash,
			contender_id: bundle.contender_id,
			eligible_hint: bundle.admission.exact_baseline,
		},
		ctx,
	);
}

/* ------------------------------------------------------------------ */
/* Blind verifiers: commit → reveal.                                   */
/* ------------------------------------------------------------------ */

/**
 * Store a verifier's commitment BEFORE any candidate is shown
 * (spec 1 §8). One commitment per verifier; commitments bind the task.
 */
export async function commitVerifier(
	state: AuthorityState,
	vc: VerifierCommitment,
	ctx: Ctx,
): Promise<AuthorityState> {
	if (state.verifier_commitments[vc.verifier_id])
		throw new Error(`duplicate commitment for verifier ${vc.verifier_id}: one commitment, one reveal, one report`);
	if (vc.task_hash !== state.task.task_hash)
		throw new Error("commitment rejected: task_hash mismatch");
	const s2: AuthorityState = {
		...state,
		verifier_commitments: { ...state.verifier_commitments, [vc.verifier_id]: vc },
	};
	return appendLedger(s2, "verifier_committed", { verifier_id: vc.verifier_id }, ctx);
}

/**
 * Reveal ReferenceReport + nonce. Returns admissibility as a STATUS, not
 * an exception, so the caller can record it. Invalid reveal →
 * INADMISSIBLE and the verifier's participation ENDS: no retry with a
 * rewritten opinion (spec 1 §8). Also inadmissible: no prior commitment,
 * or a second reveal attempt.
 */
export async function revealVerifier(
	state: AuthorityState,
	verifier_id: string,
	report: ReferenceReport,
	nonce: string,
	ctx: Ctx,
): Promise<{ state: AuthorityState; admissible: boolean; reason: string | null }> {
	if (state.ended_verifiers?.[verifier_id]) {
		return {
			state,
			admissible: false,
			reason: `verifier ${verifier_id}: participation ended after invalid reveal — no retry with a rewritten opinion`,
		};
	}
	const vc = state.verifier_commitments[verifier_id];
	if (!vc) {
		return {
			state,
			admissible: false,
			reason: `verifier ${verifier_id}: no prior commitment — report INADMISSIBLE (treated as abstain)`,
		};
	}
	if (state.verifier_reveals[verifier_id]) {
		return {
			state,
			admissible: false,
			reason: `verifier ${verifier_id}: already revealed — one reveal per commitment`,
		};
	}
	const ok = await verifyReveal(
		vc.commitment,
		report,
		nonce,
		vc.task_hash,
		vc.verifier_id,
		vc.policy_version,
		ctx.sha256Hex,
	);
	if (!ok) {
		const ended: AuthorityState = {
			...state,
			ended_verifiers: { ...(state.ended_verifiers ?? {}), [verifier_id]: "invalid reveal" },
		};
		const s2 = await appendLedger(ended, "verifier_reveal_invalid", { verifier_id }, ctx);
		return {
			state: s2,
			admissible: false,
			reason: `verifier ${verifier_id}: commitment mismatch — VERIFIER_REPORT_INADMISSIBLE; no retry with a rewritten opinion`,
		};
	}
	const s2: AuthorityState = {
		...state,
		verifier_reveals: { ...state.verifier_reveals, [verifier_id]: report },
	};
	const s3 = await appendLedger(s2, "verifier_revealed", { verifier_id }, ctx);
	return { state: s3, admissible: true, reason: null };
}

/**
 * Submit a signed VerdictReport. Requires a revealed (valid) commitment
 * for vr.verifier_id — a report without one is rejected outright.
 * One report per verifier.
 */
export async function submitVerifierReport(
	state: AuthorityState,
	vr: VerdictReport,
	ctx: Ctx,
): Promise<AuthorityState> {
	if (!state.verifier_reveals[vr.verifier_id])
		throw new Error(
			`report rejected: no revealed commitment for verifier ${vr.verifier_id} — non-committed reports are inadmissible (spec 1 §8)`,
		);
	if (state.verdict_reports.some((r) => r.verifier_id === vr.verifier_id))
		throw new Error(`report rejected: verifier ${vr.verifier_id} already reported (one report per verifier)`);
	const s2: AuthorityState = {
		...state,
		verdict_reports: [...state.verdict_reports, vr],
	};
	return appendLedger(
		s2,
		"verifier_report_submitted",
		{ verifier_id: vr.verifier_id, candidate_label: vr.candidate_label, verdict: vr.verdict },
		ctx,
	);
}

/* ------------------------------------------------------------------ */
/* Verdict seam                                                        */
/* ------------------------------------------------------------------ */

export interface CandidateEvidence {
	contender_id: string;
	candidate_sha: string;
	tree_sha256: string;
	bundle: EvaluationBundle;
	blast_radius: number;
	change_surface: number;
}

/**
 * Run the verdict seam over candidate evidence (spec 1 §9). Quarantined
 * contenders are excluded from selection (spec 3 §7). Records the verdict
 * and routes task_status: ACCEPT/ABSTAIN → verdict_reached,
 * REJECT → rejected, ESCALATE → escalated (+ escalation record;
 * promotion BLOCKED while escalated).
 */
export async function runVerdictSeam(
	state: AuthorityState,
	candidates: CandidateEvidence[],
	ctx: Ctx,
): Promise<{ state: AuthorityState; record: VerdictRecord }> {
	const ranked: RankedCandidate[] = candidates.map((c) => ({
		contender_id: c.contender_id,
		candidate_sha: c.candidate_sha,
		tree_sha256: c.tree_sha256,
		bundle: c.bundle,
		blast_radius: c.blast_radius,
		change_surface: c.change_surface,
	}));
	const quarantinedContenderIds = Object.values(state.quarantine)
		.filter((q) => q.status === "QUARANTINED")
		.map((q) => q.contender_id);
	const record = await runVerdict({
		candidates: ranked,
		reports: state.verdict_reports,
		quarantinedContenderIds,
		policyHash: ctx.selectorPolicyHash,
		policyVersion: ctx.policyVersion,
		now: ctx.now(),
		sha256Hex: ctx.sha256Hex,
		labelToSha: state.candidate_labels,
	});
	let task_status = state.task_status;
	let escalations = state.escalations;
	if (record.state === "ACCEPT" || record.state === "ABSTAIN") {
		task_status = "verdict_reached";
	} else if (record.state === "REJECT") {
		task_status = "rejected";
	} else if (record.state === "ESCALATE") {
		task_status = "escalated";
		escalations = [
			...escalations,
			{ reason: record.reasons.join("; "), at: ctx.now(), resolved: false },
		];
	}
	const s2: AuthorityState = {
		...state,
		verdicts: [...state.verdicts, record],
		task_status,
		escalations,
	};
	const s3 = await appendLedger(
		s2,
		"verdict_reached",
		{ state: record.state, winner_sha: record.winner_sha, policy_hash: record.policy_hash },
		ctx,
	);
	return { state: s3, record };
}

/* ------------------------------------------------------------------ */
/* Permits + promotion                                                 */
/* ------------------------------------------------------------------ */

/**
 * Issue the exact-state, single-use permit for an ACCEPT verdict
 * (spec 1 §10). Requires the LATEST verdict record to be ACCEPT with
 * winner_sha. Throws if the task is escalated — promotion is BLOCKED
 * while escalated (spec 1 §9.4); the operator must create a new
 * policy/task state and re-evaluate, never override.
 */
export async function issuePermit(
	state: AuthorityState,
	winner_sha: string,
	destination_repo: string,
	destination_head: string,
	ctx: Ctx,
): Promise<{ state: AuthorityState; permit: PermitRecord }> {
	const latest = state.verdicts[state.verdicts.length - 1];
	if (!latest || latest.state !== "ACCEPT" || latest.winner_sha !== winner_sha)
		throw new Error(
			`issuePermit: no ACCEPT verdict for ${winner_sha} (latest: ${latest ? latest.state : "none"}) — no permit without eligibility`,
		);
	if (state.task_status === "escalated")
		throw new Error("issuePermit: promotion BLOCKED — task is escalated (spec 1 §9.4)");
	const ev = state.evaluations[winner_sha];
	if (!ev) throw new Error(`issuePermit: no evaluation bundle for winner ${winner_sha}`);
	const permit = await createPermit(
		{
			task_hash: state.task.task_hash,
			baseline_commit: state.task.baseline_commit,
			winner_candidate_sha: winner_sha,
			contender_id: ev.contender_id,
			winning_tree_sha256: ev.tree_sha256,
			evaluation_bundle_hash: ev.bundle_hash,
			selector_policy_hash: ctx.selectorPolicyHash,
			destination_repo,
			expected_destination_head: destination_head,
		},
		ctx,
	);
	const s2: AuthorityState = {
		...state,
		permits: { ...state.permits, [permit.permit_id]: permit },
	};
	const s3 = await appendLedger(s2, "permit_issued", { permit_id: permit.permit_id, winner_sha }, ctx);
	return { state: s3, permit };
}

/**
 * Attempt promotion with a permit (spec 1 §11), in order:
 * unknown → UNKNOWN_PERMIT; consumed → ALREADY_CONSUMED (no-op ACK, not
 * an error); expected_destination_head != current HEAD →
 * EXPIRED_HEAD_MOVED; tree mismatch → TREE_MISMATCH; winner's contender
 * quarantined → QUARANTINED_CANDIDATE (quarantine registry consulted per
 * spec 3 §7). Any failure → promotion ABORTED, permit NOT consumed, so a
 * legitimate retry after re-evaluation remains possible.
 * On success: permit consumed (+consumed_at), task promoted, and the
 * single canonical_write effect for the platform layer to execute.
 */
export async function attemptPromotion(
	state: AuthorityState,
	permit_id: string,
	current_head: string,
	tree_sha256: string,
	ctx: Ctx,
): Promise<{ state: AuthorityState; outcome: PromotionOutcome; effects: Effect[] }> {
	const permit = state.permits[permit_id];
	if (!permit) {
		return { state, outcome: "UNKNOWN_PERMIT", effects: [] };
	}
	if (permit.consumed) {
		// Single-consume idempotency: a second presentation is a no-op ACK.
		return { state, outcome: "ALREADY_CONSUMED", effects: [] };
	}
	const winnerQuarantined = state.quarantine[permit.contender_id]?.status === "QUARANTINED";
	const check = checkPromotion(permit, current_head, tree_sha256, winnerQuarantined);
	if (!check.ok) {
		const s2 = await appendLedger(state, "promotion_aborted", { permit_id, error: check.error }, ctx);
		return { state: s2, outcome: check.error, effects: [] };
	}
	const consumed: PermitRecord = { ...permit, consumed: true, consumed_at: ctx.now() };
	const s2: AuthorityState = {
		...state,
		permits: { ...state.permits, [permit_id]: consumed },
		task_status: "promoted",
	};
	const s3 = await appendLedger(s2, "promotion_succeeded", { permit_id, tree_sha256 }, ctx);
	return {
		state: s3,
		outcome: "PROMOTED",
		effects: [
			{
				kind: "canonical_write",
				repo: permit.destination_repo,
				tree_sha256,
				parent: permit.expected_destination_head,
			},
		],
	};
}

/* ------------------------------------------------------------------ */
/* Quarantine (spec 1 §9.5, spec 3 §7 — FROZEN lifecycle).              */
/*                                                                     */
/* Mechanical triggers ONLY. There is deliberately NO code path for     */
/* agent accusation: the trigger parameter's type is the closed union   */
/* of mechanically-verified violations, so a caller cannot express     */
/* "agent X accused agent Y" as a trigger at all. Sanctions fire on     */
/* mechanical findings only — never on one agent's claim about another. */
/* ------------------------------------------------------------------ */

/**
 * Quarantine a contender: status → quarantined, QuarantineRecord added,
 * that contender's evaluations tainted, effects: revoke the fork's write
 * token, cancel pending workflows, notify the operator-of-record.
 * Evidence is frozen (content-addressed bundles are immutable); the fork
 * stays read-only for forensics (platform enforces).
 */
export async function quarantineContender(
	state: AuthorityState,
	contender_id: string,
	trigger: QuarantineTrigger,
	evidence_hash: string,
	ctx: Ctx,
): Promise<{ state: AuthorityState; effects: Effect[] }> {
	const contender = state.contenders[contender_id];
	if (!contender) throw new Error(`quarantine: unknown contender ${contender_id}`);
	const record: QuarantineRecord = {
		contender_id,
		trigger,
		evidence_hash,
		entered_at: ctx.now(),
		status: "QUARANTINED",
		reviewed_by: null,
		review_note: null,
	};
	const evaluations: AuthorityState["evaluations"] = Object.fromEntries(
		Object.entries(state.evaluations).map(([sha, b]) => [
			sha,
			b.contender_id === contender_id ? { ...b, tainted: true } : b,
		]),
	);
	const s2: AuthorityState = {
		...state,
		contenders: { ...state.contenders, [contender_id]: { ...contender, status: "quarantined" } },
		quarantine: { ...state.quarantine, [contender_id]: record },
		evaluations,
	};
	const effects: Effect[] = [
		{ kind: "revoke_token", repo: contender.fork_repo, token_id: contender.token_id },
		{ kind: "cancel_workflow", contender_id },
		{
			kind: "notify",
			to: ["operator-of-record"],
			message: `contender ${contender_id} QUARANTINED (trigger: ${trigger}, evidence: ${evidence_hash})`,
		},
	];
	const s3 = await appendLedger(s2, "contender_quarantined", { contender_id, trigger, evidence_hash }, ctx);
	return { state: s3, effects };
}

/**
 * Operator-of-record review of a quarantine. RELEASED requires a note
 * that non-trivially asserts a mechanical false positive (enforced:
 * note.length >= 20 — a bare "ok" is not a determination) AND passing
 * re-verification (the platform re-runs verification; the release only
 * records the determination). REVOKED terminates the contender.
 * A quarantined candidate state can NEVER be promoted; salvage is a new
 * SHA with full re-evaluation (spec 1 §9.5).
 */
export async function reviewQuarantine(
	state: AuthorityState,
	contender_id: string,
	reviewed_by: string,
	decision: "RELEASED" | "REVOKED",
	note: string,
	ctx: Ctx,
): Promise<{ state: AuthorityState }> {
	const record = state.quarantine[contender_id];
	if (!record) throw new Error(`review: no quarantine record for ${contender_id}`);
	if (decision === "RELEASED" && note.length < 20)
		throw new Error(
			"review: RELEASED requires a note of >= 20 characters asserting a mechanical false positive (spec 1 §9.5)",
		);
	const updated: QuarantineRecord = {
		...record,
		status: decision,
		reviewed_by,
		review_note: note,
	};
	const contender = state.contenders[contender_id];
	const contenders = contender
		? {
				...state.contenders,
				[contender_id]: {
					...contender,
					status: decision === "RELEASED" ? ("released" as const) : ("revoked" as const),
				},
			}
		: state.contenders;
	// False-positive release un-taints; revocation keeps the taint.
	const evaluations =
		decision === "RELEASED"
			? Object.fromEntries(
					Object.entries(state.evaluations).map(([sha, b]) => [
						sha,
						b.contender_id === contender_id ? { ...b, tainted: false } : b,
					]),
				)
			: state.evaluations;
	const s2: AuthorityState = {
		...state,
		quarantine: { ...state.quarantine, [contender_id]: updated },
		contenders,
		evaluations,
	};
	const s3 = await appendLedger(
		s2,
		"quarantine_reviewed",
		{ contender_id, decision, reviewed_by },
		ctx,
	);
	return { state: s3 };
}

/**
 * Escalate to the operator-of-record (spec 1 §9.4). Promotion is BLOCKED
 * while escalated (enforced in issuePermit). The human may resolve
 * preference/ambiguity/trade-offs but may NEVER override integrity
 * gates — those require a new policy/task state + reevaluation.
 */
export async function escalateToOperator(
	state: AuthorityState,
	reason: string,
	ctx: Ctx,
): Promise<{ state: AuthorityState }> {
	const s2: AuthorityState = {
		...state,
		task_status: "escalated",
		escalations: [...state.escalations, { reason, at: ctx.now(), resolved: false }],
	};
	const s3 = await appendLedger(s2, "escalated", { reason }, ctx);
	return { state: s3 };
}
