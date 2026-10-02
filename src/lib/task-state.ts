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
import { checkPromotion, buildPermitId, createPermit } from "./permit.ts";
import { LEDGER_GENESIS_PREV_HASH, ledgerEntryHash, sealLedger } from "./ledger.ts";
import {
	buildLinkStatement,
	buildPromotionAuthority,
	buildTestResultStatement,
	buildVerificationResultStatement,
	signEnvelope,
	type PromotionBundle,
	type Signer,
} from "./attestation.ts";
import { classifyPair, validateClaim, type ClaimInput } from "./claims.ts";
import { verifyReveal } from "./verifiers.ts";
import {
	importEd25519PublicKey,
	keyidForPublicKey,
	quarantineDeterminationPayload,
	verifierReportPayload,
	verifyEd25519Signature,
} from "./verifier-keys.ts";
import { runVerdict, type RankedCandidate } from "./verdict-seam.ts";
import { SELECTOR_POLICY_VERSION } from "./types.ts";
import type {
	AuthorityState,
	CallerIdentity,
	ConflictReport,
	ContenderRecord,
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
	VerifierPublicKey,
	TrustZone,
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

/**
 * Append a content-hashed ledger entry linked to the previous one
 * (async — hashing is async). Seals any not-yet-hashed entries first.
 */
export async function appendLedger(
	state: AuthorityState,
	kind: string,
	payload: unknown,
	ctx: Ctx,
): Promise<AuthorityState> {
	const ledger = await sealLedger(state.ledger, ctx.sha256Hex);
	const fields = {
		seq: ledger.length,
		ts: ctx.now(),
		kind,
		payload_hash: await ctx.sha256Hex(canonicalJson(payload)),
		prev_hash: ledger.length === 0 ? LEDGER_GENESIS_PREV_HASH : ledger[ledger.length - 1].entry_hash,
	};
	const entry: LedgerEntry = { ...fields, entry_hash: await ledgerEntryHash(fields, ctx.sha256Hex) };
	return { ...state, ledger: [...ledger, entry] };
}

/**
 * Create the authority for a frozen task. The genesis ledger entry
 * documents task creation; it carries an empty payload hash because
 * hashing is async and this constructor is sync — every subsequent
 * entry is content-hashed via appendLedger, which also seals (hashes)
 * the genesis entry on the first append.
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
		verifier_keys: {},
		operator_keys: {},
		candidate_labels: {},
		seen_event_keys: [],
		escalations: [],
		ledger: [
			{
				seq: 0,
				ts: task.frozen_at,
				kind: "authority_created",
				payload_hash: "",
				prev_hash: LEDGER_GENESIS_PREV_HASH,
				entry_hash: "",
			},
		],
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
/* Verifier + operator key registration (spec 1 §8, spec 1 §9.4).       */
/*                                                                     */
/* Keys are registered at TASK FREEZE, bound to verifier_id (verifiers) */
/* or keyid (operator-of-record), and are IMMUTABLE afterwards: a       */
/* second registration for the same id throws. Key-swap after           */
/* registration would let an attacker replace a verifier's key and      */
/* then forge that verifier's reports, so immutability is load-bearing. */
/* ------------------------------------------------------------------ */

/** Public-key material a caller supplies at registration (keyid is derived). */
export interface NewVerifierKey {
	verifier_id: string;
	public_key_der_hex: string;
}

/**
 * Register verifier public keys at task freeze. Each key is validated
 * (must import as an Ed25519 SPKI key — fail closed on garbage) and bound
 * to its verifier_id; the keyid is derived from the key material, never
 * caller-supplied. Re-registering a verifier_id throws: keys are
 * immutable once the task is frozen.
 */
export async function registerVerifierKeys(
	state: AuthorityState,
	keys: NewVerifierKey[],
	ctx: Ctx,
): Promise<AuthorityState> {
	const registered: Record<string, VerifierPublicKey> = { ...(state.verifier_keys ?? {}) };
	const seen = new Set<string>();
	for (const k of keys) {
		if (typeof k.verifier_id !== "string" || k.verifier_id === "")
			throw new Error("registerVerifierKeys: verifier_id must be a non-empty string");
		if (seen.has(k.verifier_id))
			throw new Error(`registerVerifierKeys: duplicate verifier_id ${k.verifier_id} in one registration`);
		seen.add(k.verifier_id);
		if (registered[k.verifier_id])
			throw new Error(
				`registerVerifierKeys: key for verifier ${k.verifier_id} is already registered — keys are immutable once the task is frozen`,
			);
		let keyid: string;
		try {
			keyid = await keyidForPublicKey(k.public_key_der_hex, ctx.sha256Hex);
			// Import validation: garbage that is not an Ed25519 SPKI key
			// must not become a registered verifier key.
			await importEd25519PublicKey(k.public_key_der_hex);
		} catch (err) {
			throw new Error(
				`registerVerifierKeys: invalid public key for verifier ${k.verifier_id}: ${(err as Error).message}`,
			);
		}
		registered[k.verifier_id] = {
			verifier_id: k.verifier_id,
			keyid,
			public_key_der_hex: k.public_key_der_hex,
		};
	}
	const s2: AuthorityState = { ...state, verifier_keys: registered };
	return appendLedger(
		s2,
		"verifier_keys_registered",
		{
			verifiers: keys.map((k) => ({
				verifier_id: k.verifier_id,
				keyid: registered[k.verifier_id].keyid,
			})),
		},
		ctx,
	);
}

/**
 * Register operator-of-record public keys at task freeze (spec 1 §9.4).
 * Quarantine determinations (RELEASED/REVOKED) must carry a valid
 * signature from a registered operator key. Same immutability rule as
 * verifier keys. Stored keyed by keyid (derived from the key material).
 */
export async function registerOperatorKeys(
	state: AuthorityState,
	keys: { public_key_der_hex: string }[],
	ctx: Ctx,
): Promise<AuthorityState> {
	const registered: Record<string, string> = { ...(state.operator_keys ?? {}) };
	for (const k of keys) {
		let keyid: string;
		try {
			keyid = await keyidForPublicKey(k.public_key_der_hex, ctx.sha256Hex);
			await importEd25519PublicKey(k.public_key_der_hex);
		} catch (err) {
			throw new Error(`registerOperatorKeys: invalid public key: ${(err as Error).message}`);
		}
		if (registered[keyid])
			throw new Error(
				`registerOperatorKeys: operator key ${keyid.slice(0, 12)}… is already registered — keys are immutable once the task is frozen`,
			);
		registered[keyid] = k.public_key_der_hex;
	}
	const s2: AuthorityState = { ...state, operator_keys: registered };
	return appendLedger(
		s2,
		"operator_keys_registered",
		{ keyids: Object.keys(registered) },
		ctx,
	);
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
 * A claim named an agent whose identity is already bound to a secret, and
 * the caller did not present that secret. The edge maps this to 403.
 */
export class AgentSecretError extends Error {
	readonly code: "agent_secret_required" | "agent_secret_invalid";
	constructor(code: "agent_secret_required" | "agent_secret_invalid", message: string) {
		super(message);
		this.name = "AgentSecretError";
		this.code = code;
	}
}

/** String equality without an early exit (for secret hashes). */
function constantTimeEqual(a: string, b: string): boolean {
	let diff = a.length ^ b.length;
	for (let i = 0; i < Math.min(a.length, b.length); i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/**
 * Register a contender's WorkClaim BEFORE forking or writing code
 * (spec 2 §2). Validates via claims.ts (task/baseline must match the
 * frozen task; empty scope.paths rejected), assigns work_id, version 1,
 * status "claimed", and classifies against all live claims.
 *
 * Agent binding (specs/amendments/contender-agent-binding.md): an agent's
 * first claim mints its secret (32 random bytes, hex), stores only
 * SHA-256(secret) on the claim and returns the plaintext once as
 * `agent_secret`. A later claim naming the same agent must present that
 * secret (AgentSecretError otherwise); it gets the same hash and no secret.
 *
 * Throws on validation failure — registration rejection is not a state.
 */
export async function registerClaim(
	state: AuthorityState,
	input: NewClaimInput,
	ctx: Ctx,
	presentedAgentSecret?: string,
): Promise<{ state: AuthorityState; claim: WorkClaim; reports: ConflictReport[]; agent_secret: string | null }> {
	const v = validateClaim(input);
	if (!v.ok) throw new Error(`claim rejected: ${v.error}`);
	if (typeof input.agent !== "string" || input.agent === "") {
		throw new Error("claim rejected: claim.agent (agent identity) is required");
	}
	if ("agent_secret_sha256" in input) {
		throw new Error("claim rejected: agent_secret_sha256 is assigned by the authority");
	}
	if (input.task !== state.task.task_hash)
		throw new Error(
			`claim rejected: task mismatch (claim references ${input.task}, task is ${state.task.task_hash}) — stale work (spec 1 §5)`,
		);
	if (input.baseline !== state.task.baseline_commit)
		throw new Error(
			`claim rejected: baseline mismatch (claim ${input.baseline} != frozen ${state.task.baseline_commit})`,
		);
	const boundHash = state.claims.find(
		(c) => c.agent === input.agent && typeof c.agent_secret_sha256 === "string",
	)?.agent_secret_sha256;
	let agent_secret: string | null = null;
	let agent_secret_sha256: string;
	if (boundHash !== undefined) {
		if (presentedAgentSecret === undefined) {
			throw new AgentSecretError("agent_secret_required", `claim rejected: agent ${input.agent} requires its secret`);
		}
		if (!constantTimeEqual(await ctx.sha256Hex(presentedAgentSecret), boundHash)) {
			throw new AgentSecretError("agent_secret_invalid", `claim rejected: secret does not match agent ${input.agent}`);
		}
		agent_secret_sha256 = boundHash;
	} else {
		agent_secret = ctx.randomHex(32);
		agent_secret_sha256 = await ctx.sha256Hex(agent_secret);
	}
	const claim: WorkClaim = {
		...input,
		work_id: "W-" + ctx.randomHex(4),
		status: "claimed",
		version: 1,
		agent_secret_sha256,
	};
	const live = state.claims.filter((c) => c.status === "claimed" || c.status === "active");
	const reports = live.map((c) => classifyPair(claim, c));
	const s2 = await appendLedger(
		{ ...state, claims: [...state.claims, claim] },
		"claim_registered",
		{ work_id: claim.work_id, agent: claim.agent, risk: reports.map((r) => r.risk) },
		ctx,
	);
	return { state: s2, claim, reports, agent_secret };
}

/**
 * The agent whose claims carry SHA-256(`secret`), with those claims'
 * work_ids, or null when the secret matches no claim. Also null (fail
 * closed) if the hash were ever bound to more than one agent.
 */
export async function resolveAgentBySecret(
	state: AuthorityState,
	secret: string,
	ctx: Pick<Ctx, "sha256Hex">,
): Promise<{ agent: string; work_ids: string[] } | null> {
	const hash = await ctx.sha256Hex(secret);
	const matching = state.claims.filter(
		(c) => typeof c.agent_secret_sha256 === "string" && constantTimeEqual(c.agent_secret_sha256, hash),
	);
	if (new Set(matching.map((c) => c.agent)).size !== 1) return null;
	return { agent: matching[0].agent, work_ids: matching.map((c) => c.work_id) };
}

/* ------------------------------------------------------------------ */
/* Contenders                                                          */
/* ------------------------------------------------------------------ */

/** Every token id minted for a contender (records that predate
 *  `token_ids` carry only `token_id`). */
export function contenderTokenIds(contender: ContenderRecord): string[] {
	return [...new Set([...(contender.token_ids ?? []), contender.token_id])];
}

/**
 * Record a contender the edge has forked and credentialed. Create-only: an
 * existing record for the same contender_id is returned unchanged
 * (`created: false`) and the state is untouched, so a retry, a race or
 * another agent's request can never replace the bound agent, fork or token
 * ids. The caller must revoke any token it minted for a registration that
 * was not recorded.
 */
export async function registerContender(
	state: AuthorityState,
	contender: ContenderRecord,
	ctx: Ctx,
): Promise<{ state: AuthorityState; record: ContenderRecord; created: boolean }> {
	const existing = state.contenders[contender.contender_id];
	if (existing) return { state, record: existing, created: false };
	const s2 = await appendLedger(
		{ ...state, contenders: { ...state.contenders, [contender.contender_id]: contender } },
		"contender_registered",
		{
			contender_id: contender.contender_id,
			agent_id: contender.agent_id,
			fork_repo: contender.fork_repo,
			token_ids: contenderTokenIds(contender),
		},
		ctx,
	);
	return { state: s2, record: contender, created: true };
}

/* ------------------------------------------------------------------ */
/* Evaluations (submitted by the evaluation domain only)                */
/* ------------------------------------------------------------------ */

/**
 * Zones allowed to submit evidence, per the spec 3 §5 credential matrix.
 * Evidence is admissible ONLY from the evaluation domain (and committed
 * verifiers submit their own reports through the separate verifier path).
 * Contender-supplied "evidence" is inadmissible by construction
 * (spec 3 §6 attack #6).
 */
const EVIDENCE_SUBMITTER_ZONES: ReadonlySet<TrustZone> = new Set(["evaluation_domain"]);

export type SubmitEvaluationOutcome = "RECORDED" | "ACK_DUP";

/**
 * Store an evaluation bundle. The caller identity is checked against the
 * credential matrix IN THE AUTHORITY (spec 3 §5): only the evaluation
 * domain may submit evidence. Transport-level authentication of that
 * identity is the edge's job — the DO/worker routes carry an explicit
 * TODO where mTLS/service-token auth cannot exist locally — but the zone
 * check itself is enforced here, so a misrouted or forged caller identity
 * fails closed even if the edge is naive.
 *
 * Idempotency: re-submitting the identical bundle (same candidate_sha +
 * bundle_hash, e.g. an evaluation-domain retry) is an ACK_DUP — no state
 * change, no ledger entry. Submitting a DIFFERENT bundle for the same
 * candidate_sha is a re-evaluation: it overwrites (RECORDED). A permit
 * issued against the superseded bundle no longer verifies at promotion
 * (spec 1 §11 check 4 → EVAL_BUNDLE_MISMATCH).
 *
 * Rejects bundles for a different task.
 */
export async function submitEvaluation(
	state: AuthorityState,
	bundle: EvaluationBundle,
	caller: CallerIdentity,
	ctx: Ctx,
): Promise<{ state: AuthorityState; outcome: SubmitEvaluationOutcome }> {
	const zone = caller?.zone ?? "unknown";
	if (!EVIDENCE_SUBMITTER_ZONES.has(zone)) {
		if (zone === "contender") {
			throw new Error(
				"evidence rejected: caller zone 'contender' is not the evaluation domain — " +
					"contender-supplied evidence is inadmissible by construction " +
					"(spec 3 §5 credential matrix; spec 3 §6 attack #6)",
			);
		}
		throw new Error(
			`evidence rejected: caller zone '${zone}' is not authorized to submit evidence — ` +
				"only the evaluation domain may submit (spec 3 §5 credential matrix)",
		);
	}
	if (bundle.task_hash !== state.task.task_hash)
		throw new Error("evaluation rejected: task_hash mismatch");
	const existing = state.evaluations[bundle.candidate_sha];
	if (existing && existing.bundle_hash === bundle.bundle_hash) {
		// Idempotent retry of the same evaluation: converge, don't duplicate.
		return { state, outcome: "ACK_DUP" };
	}
	const s2: AuthorityState = {
		...state,
		evaluations: { ...state.evaluations, [bundle.candidate_sha]: bundle },
	};
	const s3 = await appendLedger(
		s2,
		"evaluation_submitted",
		{
			candidate_sha: bundle.candidate_sha,
			bundle_hash: bundle.bundle_hash,
			contender_id: bundle.contender_id,
			eligible_hint: bundle.admission.exact_baseline,
			submitted_by_zone: zone,
		},
		ctx,
	);
	return { state: s3, outcome: "RECORDED" };
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
 *
 * SIGNATURE ENFORCEMENT (spec 1 §8; spec 3 §6 attack #11): the authority
 * holds the verifier's public key registered at task freeze
 * (registerVerifierKeys) and verifies EVERY report:
 *   - unknown verifier_id (no registered key) → rejected
 *   - keyid not matching the registered key → rejected (wrong key)
 *   - empty signature → rejected (unsigned)
 *   - signature not verifying over canonical_json(report minus signature)
 *     → rejected (forged or tampered payload)
 * Each failure is a DISTINCT error so forensics can tell "never
 * registered" from "forged". An attacker who squats a commitment or
 * replays the commit→reveal dance without the private key gets no further:
 * the report is inadmissible without a valid signature.
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
	const registered: VerifierPublicKey | undefined = (state.verifier_keys ?? {})[vr.verifier_id];
	if (!registered)
		throw new Error(
			`report rejected: unknown verifier_id "${vr.verifier_id}" — no verifier key registered for this task; ` +
				`reports must be signed by a registered verifier key (spec 1 §8)`,
		);
	if (vr.keyid !== registered.keyid)
		throw new Error(
			`report rejected: keyid mismatch for verifier ${vr.verifier_id} — report carries keyid ` +
				`${vr.keyid.slice(0, 12)}… but the registered key is ${registered.keyid.slice(0, 12)}… (wrong key)`,
		);
	if (!vr.signature)
		throw new Error(
			`report rejected: unsigned report from verifier ${vr.verifier_id} — verifier reports must be signed (spec 1 §8)`,
		);
	const payload = new TextEncoder().encode(
		verifierReportPayload({
			verifier_id: vr.verifier_id,
			candidate_label: vr.candidate_label,
			verdict: vr.verdict,
			reasons: vr.reasons,
			keyid: vr.keyid,
		}),
	);
	const valid = await verifyEd25519Signature(registered.public_key_der_hex, payload, vr.signature);
	if (!valid)
		throw new Error(
			`report rejected: signature verification failed for verifier ${vr.verifier_id} — forged or tampered report`,
		);
	const s2: AuthorityState = {
		...state,
		verdict_reports: [...state.verdict_reports, vr],
	};
	return appendLedger(
		s2,
		"verifier_report_submitted",
		{
			verifier_id: vr.verifier_id,
			candidate_label: vr.candidate_label,
			verdict: vr.verdict,
			keyid: vr.keyid,
			signature_valid: true,
		},
		ctx,
	);
}

/**
 * Assign collision-free anonymized labels after verifier commitments are
 * recorded and before candidates are shown to verifiers (spec 1 §8).
 *
 * Labels are authority-owned and stable for the task lifetime. Repeating
 * the same assignment is idempotent; attempting to bind an existing label
 * to a different candidate fails closed.
 */
export async function assignCandidateLabels(
	state: AuthorityState,
	candidateShas: string[],
	ctx: Ctx,
): Promise<{ state: AuthorityState; labels: Record<string, string> }> {
	if (candidateShas.length === 0) throw new Error("assignCandidateLabels: at least one candidate is required");
	const registered = Object.keys(state.verifier_keys ?? {});
	for (const verifierId of registered) {
		if (!state.verifier_commitments[verifierId]) {
			throw new Error(
				`assignCandidateLabels: verifier ${verifierId} has not committed — candidates cannot be exposed before commit (spec 1 §8)`,
			);
		}
	}
	const nextLabels: Record<string, string> = { ...state.candidate_labels };
	const assigned: Record<string, string> = {};
	for (let i = 0; i < candidateShas.length; i++) {
		const sha = candidateShas[i];
		if (typeof sha !== "string" || sha === "") throw new Error("assignCandidateLabels: invalid candidate sha");
		const label = `candidate-${i}`;
		const existing = nextLabels[label];
		if (existing !== undefined && existing !== sha) {
			throw new Error(`assignCandidateLabels: label ${label} is already bound to a different candidate`);
		}
		nextLabels[label] = sha;
		assigned[label] = sha;
	}
	const unchanged =
		Object.keys(assigned).every((label) => state.candidate_labels[label] === assigned[label]) &&
		Object.keys(assigned).length > 0;
	if (unchanged) return { state, labels: assigned };
	const s2: AuthorityState = { ...state, candidate_labels: nextLabels };
	const s3 = await appendLedger(
		s2,
		"candidate_labels_assigned",
		{ labels: Object.keys(assigned), candidate_count: candidateShas.length },
		ctx,
	);
	return { state: s3, labels: assigned };
}

/* ------------------------------------------------------------------ */
/* Verdict seam                                                        */
/* ------------------------------------------------------------------ */

export interface CandidateEvidence {
	contender_id: string;
	candidate_sha: string;
	blast_radius: number;
	change_surface: number;
}

/**
 * Run the verdict seam over candidate evidence (spec 1 §9). Quarantined
 * contenders are excluded from selection (spec 3 §7). Records the verdict
 * and routes task_status: ACCEPT/ABSTAIN → verdict_reached,
 * REJECT → rejected, ESCALATE → escalated (+ escalation record;
 * promotion BLOCKED while escalated).
 *
 * TRUST BOUNDARY: the caller names candidates (contender_id,
 * candidate_sha) and supplies the control-plane-computed dominance
 * dimensions (blast_radius, change_surface). The EVIDENCE ITSELF — the
 * evaluation bundle — is resolved from the authority's own stored state,
 * never taken from the caller. Evidence enters the authority only via
 * submitEvaluation (zone-gated to the evaluation domain); the seam cannot
 * be fed a caller-forged bundle, even by a compromised caller. A
 * candidate with no stored evaluation, or whose stored bundle names a
 * different contender, is a fail-closed error, not a silent skip.
 */
export async function runVerdictSeam(
	state: AuthorityState,
	candidates: CandidateEvidence[],
	ctx: Ctx,
): Promise<{ state: AuthorityState; record: VerdictRecord }> {
	const ranked: RankedCandidate[] = candidates.map((c) => {
		const bundle = state.evaluations[c.candidate_sha];
		if (!bundle)
			throw new Error(
				`runVerdictSeam: no stored evaluation for candidate ${c.candidate_sha} — ` +
					`evidence must be submitted by the evaluation domain before the verdict (spec 3 §6)`,
			);
		if (bundle.contender_id !== c.contender_id)
			throw new Error(
				`runVerdictSeam: stored evaluation for ${c.candidate_sha} names contender ` +
					`${bundle.contender_id}, not ${c.contender_id} — refusing to mix evidence across contenders`,
			);
		return {
			contender_id: c.contender_id,
			candidate_sha: c.candidate_sha,
			tree_sha256: bundle.tree_sha256,
			bundle,
			blast_radius: c.blast_radius,
			change_surface: c.change_surface,
		};
	});
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
	// Idempotent issuance: the permit_id is deterministic over the bound
	// fields (spec 5 §5: promote = permit_id is the idempotent operation
	// id), so a retry of the issue step converges to the SAME record.
	// CRITICAL: never overwrite an existing permit — a fresh record would
	// reset consumed=false and resurrect a consumed permit, breaking
	// single-use. Return the stored record unchanged (no ledger entry: an
	// idempotent no-op is not a transition, mirroring ingestQueueEvent's
	// ACK_DUP).
	const permitId = await buildPermitId(
		{
			task_hash: state.task.task_hash,
			baseline_commit: state.task.baseline_commit,
			winning_tree_sha256: ev.tree_sha256,
			evaluation_bundle_hash: ev.bundle_hash,
			selector_policy_hash: ctx.selectorPolicyHash,
			expected_destination_head: destination_head,
		},
		ctx.sha256Hex,
	);
	const existing = state.permits[permitId];
	if (existing) return { state, permit: existing };
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
 * EXPIRED_HEAD_MOVED; tree mismatch → TREE_MISMATCH; stored evaluation
 * bundle hash != the permit's bound bundle hash → EVAL_BUNDLE_MISMATCH
 * (spec 1 §11 check 4: the permit authorizes promotion under THIS exact
 * evidence — a re-evaluation after issuance supersedes the old permit);
 * winner's contender quarantined → QUARANTINED_CANDIDATE (quarantine
 * registry consulted per spec 3 §7). Any failure → promotion ABORTED,
 * permit NOT consumed, so a legitimate retry after re-evaluation remains
 * possible.
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
	// Spec 1 §11 check (4): the permit binds evaluation_bundle_hash. If the
	// candidate was re-evaluated after the permit was issued, the stored
	// bundle no longer matches the bound evidence — the permit authorizes
	// promotion under the OLD evidence only. Abort WITHOUT consuming, so a
	// fresh permit issued after the re-evaluation can promote.
	const storedBundle = state.evaluations[permit.winner_candidate_sha];
	if (!storedBundle || storedBundle.bundle_hash !== permit.evaluation_bundle_hash) {
		const s2 = await appendLedger(
			state,
			"promotion_aborted",
			{
				permit_id,
				error: "EVAL_BUNDLE_MISMATCH",
				permit_bundle_hash: permit.evaluation_bundle_hash,
				stored_bundle_hash: storedBundle?.bundle_hash ?? null,
			},
			ctx,
		);
		return { state: s2, outcome: "EVAL_BUNDLE_MISMATCH", effects: [] };
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

/**
 * Record the ship record for a consumed permit (spec 1 §11; amendment
 * authority-signing-v1). The four attestation statements are built from
 * this authority's own state: the permit (every value it binds), the
 * stored evaluation bundle, the winner's verdict, the contender's fork and
 * the promoted commit the promotion service reported. The authority
 * statement also carries the current ledger head, so the signature covers
 * the ledger the bundle ships with. The bundle is stored under the permit
 * id; it adds no ledger entry of its own, so its head stays the ledger's
 * head at promotion. Throws if the permit is not consumed or its evidence
 * is missing.
 */
export async function recordPromotionBundle(
	state: AuthorityState,
	permit_id: string,
	promoted_sha: string,
	signer: Signer & { publicKeyDerHex: string },
	ctx: Ctx,
): Promise<{ state: AuthorityState; bundle: PromotionBundle }> {
	const permit = state.permits[permit_id];
	if (!permit?.consumed) throw new Error(`promotion bundle: permit ${permit_id} is not consumed`);
	const evaluation = state.evaluations[permit.winner_candidate_sha];
	if (!evaluation || evaluation.bundle_hash !== permit.evaluation_bundle_hash) {
		throw new Error(`promotion bundle: permit ${permit_id}'s evaluation bundle is not stored`);
	}
	const contender = state.contenders[permit.contender_id];
	if (!contender) throw new Error(`promotion bundle: contender ${permit.contender_id} is unknown`);
	const verification = state.verdicts.some(
		(v) => v.state === "ACCEPT" && v.winner_sha === permit.winner_candidate_sha,
	)
		? "PASSED"
		: "FAILED";
	const ledger = await sealLedger(state.ledger, ctx.sha256Hex);
	const head = ledger[ledger.length - 1].entry_hash;
	const tree = permit.winning_tree_sha256;
	const candidateCommit = permit.winner_candidate_sha;
	const statements = [
		await buildLinkStatement({ baselineCommit: permit.baseline_commit, candidateCommit, treeSha256: tree }),
		await buildTestResultStatement({
			treeSha256: tree,
			candidateCommit,
			// The authority holds the content-addressed evaluation record, not
			// the evaluator's command lines.
			testConfigDigest: evaluation.bundle_hash,
			result: evaluation.hidden_oracle.passed && evaluation.regressions.passed ? "PASS" : "FAIL",
		}),
		await buildVerificationResultStatement({
			treeSha256: tree,
			candidateCommit,
			policySha256: permit.selector_policy_hash,
			result: verification,
		}),
		await buildPromotionAuthority({
			taskHash: permit.task_hash,
			baselineCommit: permit.baseline_commit,
			candidateRepo: contender.fork_repo,
			candidateCommit,
			treeSha256: tree,
			evaluationBundleHash: permit.evaluation_bundle_hash,
			verificationResult: verification,
			policySha256: permit.selector_policy_hash,
			destinationRepo: permit.destination_repo,
			expectedParent: permit.expected_destination_head,
			nonce: permit.nonce,
			permitId: permit.permit_id,
			issuedAt: permit.issued_at,
			ledgerHeadSha256: head,
		}),
	];
	const envelopes = [];
	for (const statement of statements) envelopes.push(await signEnvelope(statement, signer));
	const bundle: PromotionBundle = {
		version: 2,
		statements: envelopes,
		ship: {
			repo: permit.destination_repo,
			commit: promoted_sha,
			tree_sha256: tree,
			parent: permit.expected_destination_head,
			permit_id,
		},
		ledger: { head_sha256: head, entries: ledger },
		authority_pubkey_der_hex: signer.publicKeyDerHex,
	};
	return {
		state: { ...state, ledger, promotion_bundles: { ...(state.promotion_bundles ?? {}), [permit_id]: bundle } },
		bundle,
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
		// Every token ever minted for this contender, not only the latest.
		...contenderTokenIds(contender).map(
			(token_id): Effect => ({ kind: "revoke_token", repo: contender.fork_repo, token_id }),
		),
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
 * The control plane's re-run of the mechanical check that fired the
 * quarantine trigger (spec 1 §9.5: RELEASED requires "a determination of
 * mechanical false positive plus passing re-verification"). Produced by
 * the control plane re-executing the check — e.g. recomputing the locked
 * evaluator-config digest, re-reading the test manifest, re-checking token
 * scope — NOT by agent testimony.
 */
export interface QuarantineRecheck {
	/** MUST equal the quarantine record's trigger. */
	trigger: QuarantineTrigger;
	/** true = the mechanical check now passes (the trigger was a false positive). */
	passed: boolean;
	detail: string;
	checked_at: string;
}

/**
 * The operator-of-record's signed determination on a quarantine review.
 * The signature (Ed25519, base64) is over
 * canonical_json({contender_id, trigger, decision, note}) and must verify
 * against a key registered via registerOperatorKeys.
 */
export interface SignedDetermination {
	note: string;
	keyid: string;
	signature: string;
}

/**
 * Operator-of-record review of a quarantine (spec 1 §9.5, spec 3 §7).
 *
 * RELEASED requires BOTH:
 *   (a) the re-run mechanical check passes (recheck.passed === true AND
 *       recheck.trigger === the quarantine record's trigger — the
 *       re-verification must re-run the check that actually fired), AND
 *   (b) a valid operator-signed determination.
 * If the re-check reproduces the violation, RELEASED is DENIED — the
 * false-positive determination is contradicted by measurement, and the
 * only honest path is REVOKED.
 *
 * REVOKED requires a valid operator-signed determination (the recheck must
 * still name the firing trigger, so the review is anchored to the
 * mechanical finding). Revocation terminates the contender and keeps the
 * evidence taint.
 *
 * A quarantined candidate state can NEVER be promoted; salvage is a new
 * SHA with full re-evaluation (spec 1 §9.5).
 */
export async function reviewQuarantine(
	state: AuthorityState,
	contender_id: string,
	decision: "RELEASED" | "REVOKED",
	recheck: QuarantineRecheck,
	determination: SignedDetermination,
	ctx: Ctx,
): Promise<{ state: AuthorityState }> {
	const record = state.quarantine[contender_id];
	if (!record) throw new Error(`review: no quarantine record for ${contender_id}`);
	if (record.status !== "QUARANTINED")
		throw new Error(
			`review: quarantine record for ${contender_id} is already ${record.status} — reviews are single-shot`,
		);
	if (recheck.trigger !== record.trigger)
		throw new Error(
			`review: recheck trigger "${recheck.trigger}" does not match the quarantine trigger ` +
				`"${record.trigger}" — the re-verification must re-run the mechanical check that fired`,
		);
	const operatorKey: string | undefined = (state.operator_keys ?? {})[determination.keyid];
	if (!operatorKey)
		throw new Error(
			`review: unknown operator keyid ${determination.keyid.slice(0, 12)}… — ` +
				`determinations must be signed by a registered operator-of-record key (spec 1 §9.4)`,
		);
	if (!determination.note || determination.note.trim() === "")
		throw new Error("review: a determination note is required — the operator must state the basis for the decision");
	const payload = new TextEncoder().encode(
		quarantineDeterminationPayload({
			contender_id,
			trigger: record.trigger,
			decision,
			note: determination.note,
		}),
	);
	const sigValid = await verifyEd25519Signature(operatorKey, payload, determination.signature);
	if (!sigValid)
		throw new Error(
			`review: operator determination signature invalid for ${contender_id} — refusing to act on an unsigned determination`,
		);
	if (decision === "RELEASED" && !recheck.passed)
		throw new Error(
			`review: RELEASED denied — the mechanical re-check reproduced the violation ` +
				`(trigger: ${record.trigger}; detail: ${recheck.detail}); the false-positive ` +
				`determination is contradicted by measurement. The honest path is REVOKED.`,
		);
	const updated: QuarantineRecord = {
		...record,
		status: decision,
		reviewed_by: determination.keyid,
		review_note: determination.note,
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
		{
			contender_id,
			decision,
			reviewed_by_keyid: determination.keyid,
			trigger: record.trigger,
			recheck_passed: recheck.passed,
			recheck_detail: recheck.detail,
		},
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
