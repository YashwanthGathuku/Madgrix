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
	EscalationRecord,
	EvaluationBundle,
	LedgerEntry,
	PermitRecord,
	PromotionOutcome,
	RebaseConflictData,
	RebaseRecord,
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
	CompositionRecord,
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
	/** Stop the contender's pending promotions: the PromotionWorkflow
	 *  instances of its unconsumed permits (instance id = permit_id). */
	| { kind: "cancel_workflow"; contender_id: string; permit_ids: string[] }
	| { kind: "notify"; to: string[]; message: string }
	/** Fast-forward `repo`'s main from `base` to `commit` (the reviewed
	 *  candidate, unchanged). Only the promotion service performs it. */
	| { kind: "canonical_write"; repo: string; commit: string; tree_sha256: string; base: string };

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
	readonly code: "agent_secret_required" | "agent_secret_invalid" | "agent_not_enrolled";
	constructor(code: "agent_secret_required" | "agent_secret_invalid" | "agent_not_enrolled", message: string) {
		super(message);
		this.name = "AgentSecretError";
		this.code = code;
	}
}

/** Agent ids the control plane may enroll. */
export const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Record the agents the control plane enrolled at task creation, each by
 * the SHA-256 of the secret it was issued (specs/amendments/agent-enrollment-v1.md).
 * Once only, and before any claim.
 */
export async function enrollAgents(
	state: AuthorityState,
	enrollment: Record<string, string>,
	ctx: Ctx,
): Promise<AuthorityState> {
	if (state.agent_enrollment !== undefined) throw new Error("enrollAgents: agents are already enrolled");
	if (state.claims.length > 0) throw new Error("enrollAgents: claims exist; enrollment must precede them");
	const ids = Object.keys(enrollment);
	if (ids.length === 0) throw new Error("enrollAgents: at least one agent is required");
	for (const id of ids) {
		if (!AGENT_ID_PATTERN.test(id)) throw new Error(`enrollAgents: invalid agent id ${JSON.stringify(id)}`);
		if (typeof enrollment[id] !== "string" || !/^[0-9a-f]{64}$/.test(enrollment[id])) {
			throw new Error(`enrollAgents: agent ${id} needs a SHA-256 hex digest`);
		}
	}
	return appendLedger({ ...state, agent_enrollment: { ...enrollment } }, "agents_enrolled", { agent_ids: ids.sort() }, ctx);
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
 * Enrolled tasks (specs/amendments/agent-enrollment-v1.md): the control
 * plane issued each agent its secret at task creation. Only enrolled agents
 * may claim (agent_not_enrolled), every claim, the first included, must
 * present the agent's own secret, and nothing is minted.
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
	const enrolled = state.agent_enrollment;
	const boundHash =
		enrolled !== undefined
			? Object.hasOwn(enrolled, input.agent)
				? enrolled[input.agent]
				: undefined
			: state.claims.find((c) => c.agent === input.agent && typeof c.agent_secret_sha256 === "string")
					?.agent_secret_sha256;
	if (enrolled !== undefined && boundHash === undefined) {
		throw new AgentSecretError("agent_not_enrolled", `claim rejected: agent ${input.agent} is not enrolled in this task`);
	}
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
		{
			...state,
			claims: [...state.claims, claim],
			conflict_reports: [...(state.conflict_reports ?? []), ...reports],
		},
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
 * was not recorded. A new record's fork_base must be the task's baseline
 * commit (specs/amendments/rebase-ancestry-v1.md).
 */
export async function registerContender(
	state: AuthorityState,
	contender: ContenderRecord,
	ctx: Ctx,
): Promise<{ state: AuthorityState; record: ContenderRecord; created: boolean }> {
	const existing = state.contenders[contender.contender_id];
	if (existing) return { state, record: existing, created: false };
	// A permit may bind the fork base as the destination head
	// (rebase-ancestry-v1), so it must be the commit every fork starts at.
	if (contender.fork_base !== state.task.baseline_commit)
		throw new Error(
			`registerContender: fork_base ${JSON.stringify(contender.fork_base)} is not the task's baseline commit ${state.task.baseline_commit}`,
		);
	const s2 = await appendLedger(
		{ ...state, contenders: { ...state.contenders, [contender.contender_id]: contender } },
		"contender_registered",
		{
			contender_id: contender.contender_id,
			agent_id: contender.agent_id,
			fork_repo: contender.fork_repo,
			fork_base: contender.fork_base,
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

export type SubmitEvaluationOutcome = "RECORDED" | "ACK_DUP" | "REPLACEMENT_REJECTED";

/**
 * Store an evaluation bundle. The caller identity is checked against the
 * credential matrix IN THE AUTHORITY (spec 3 §5): only the evaluation
 * domain may submit evidence. Authenticating that identity is the edge's
 * job — the Worker's /evidence route requires EVALUATION_SERVICE_TOKEN (a
 * bearer secret, not mTLS) and sets the zone itself — but the zone check is
 * enforced here too, so a misrouted or forged caller identity fails closed
 * even if the edge is naive.
 *
 * Binding (specs/amendments/evidence-integrity-v1.md): the bundle must name
 * a known contender, and its candidate_sha must be that contender's
 * latest_commit — the newest push the authority observed. Anything else
 * throws: evidence for a commit the contender has moved past, or never
 * pushed, is not evidence about its candidate. An evaluation_base, when
 * present, must be one of the contender's known bases (rebase-ancestry-v1).
 *
 * Idempotency: re-submitting the identical bundle (same candidate_sha +
 * bundle_hash, e.g. an evaluation-domain retry) is an ACK_DUP — no state
 * change, no ledger entry. Submitting a DIFFERENT bundle for the same
 * candidate_sha before verifiers' candidate labels exist for it is a
 * re-evaluation: it overwrites (RECORDED). A permit issued against the
 * superseded bundle no longer verifies at promotion (spec 1 §11 check 4 →
 * EVAL_BUNDLE_MISMATCH). Once a label is bound to that SHA, its evidence
 * is final: a different bundle is REPLACEMENT_REJECTED — the stored bundle
 * stands and the attempt is recorded as an `evidence_replacement_rejected`
 * ledger entry, which the caller persists.
 *
 * Tamper quarantine (specs/amendments/tamper-quarantine-v1.md): a RECORDED
 * bundle whose eval_file_changes names any changed evaluation file (runner
 * configuration or test material) is mechanical evidence of an
 * evaluation-file modification attempt (spec 1 §6, §9.5). The contender is
 * quarantined in the same transition (trigger eval_file_modification,
 * evidence = the bundle hash) unless it is already QUARANTINED or REVOKED,
 * and the quarantine's effects are returned for the caller to execute.
 * Other tampering findings (paths outside the claim scope, unsafe paths)
 * fail the gate without quarantine (spec 3 §6 attack 5: REJECT).
 *
 * Rejects bundles for a different task.
 */
export async function submitEvaluation(
	state: AuthorityState,
	bundle: EvaluationBundle,
	caller: CallerIdentity,
	ctx: Ctx,
): Promise<{ state: AuthorityState; outcome: SubmitEvaluationOutcome; effects: Effect[] }> {
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
	if (
		bundle.evaluation_config_sha256 !== undefined &&
		(typeof bundle.evaluation_config_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(bundle.evaluation_config_sha256))
	)
		throw new Error("evaluation rejected: evaluation_config_sha256 is not a SHA-256 hex digest");
	const evalFileChanges = bundle.eval_file_changes;
	if (evalFileChanges !== undefined) {
		if (!Array.isArray(evalFileChanges) || !evalFileChanges.every((p) => typeof p === "string" && p !== ""))
			throw new Error("evaluation rejected: eval_file_changes must be a list of paths");
		if (evalFileChanges.length > 0 && bundle.admission?.no_eval_tampering !== false)
			throw new Error(
				"evaluation rejected: eval_file_changes names changed evaluation files but admission.no_eval_tampering is not false",
			);
	}
	const contender = Object.hasOwn(state.contenders, bundle.contender_id)
		? state.contenders[bundle.contender_id]
		: undefined;
	if (contender === undefined)
		throw new Error(`evaluation rejected: unknown contender ${JSON.stringify(bundle.contender_id)}`);
	if (compositionBlocks(state, bundle.contender_id, bundle.candidate_sha)) {
		const composition = state.composition;
		throw new Error(
			composition?.status === "CONFLICTED"
				? `evaluation rejected: contender ${bundle.contender_id} is CONFLICTED — an unresolved composition is not a candidate`
				: `evaluation rejected: ${bundle.candidate_sha} is a contributing SHA, not the composition candidate ${composition?.candidate_sha ?? "none"}`,
		);
	}
	if (contender.latest_commit !== bundle.candidate_sha)
		throw new Error(
			`evaluation rejected: candidate ${bundle.candidate_sha} is not the latest observed commit of ` +
				`${bundle.contender_id} (${contender.latest_commit ?? "no push observed"})`,
		);
	if (bundle.evaluation_base !== undefined && !evaluationBases(contender).includes(bundle.evaluation_base))
		throw new Error(
			`evaluation rejected: evaluation_base ${JSON.stringify(bundle.evaluation_base)} is neither ` +
				`${bundle.contender_id}'s fork base nor a recorded rebase head`,
		);
	const existing = state.evaluations[bundle.candidate_sha];
	if (existing && existing.bundle_hash === bundle.bundle_hash) {
		// Idempotent retry of the same evaluation: converge, don't duplicate.
		return { state, outcome: "ACK_DUP", effects: [] };
	}
	if (existing && Object.values(state.candidate_labels).includes(bundle.candidate_sha)) {
		// Verifiers can see this candidate under its label: its evidence is
		// final. Record the attempt; never swap the bundle.
		const rejected = await appendLedger(
			state,
			"evidence_replacement_rejected",
			{
				candidate_sha: bundle.candidate_sha,
				contender_id: bundle.contender_id,
				recorded_bundle_hash: existing.bundle_hash,
				rejected_bundle_hash: bundle.bundle_hash,
				submitted_by_zone: zone,
			},
			ctx,
		);
		return { state: rejected, outcome: "REPLACEMENT_REJECTED", effects: [] };
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
	const sanction = state.quarantine[bundle.contender_id]?.status;
	if ((evalFileChanges?.length ?? 0) > 0 && sanction !== "QUARANTINED" && sanction !== "REVOKED") {
		const q = await quarantineContender(s3, bundle.contender_id, "eval_file_modification", bundle.bundle_hash, ctx);
		return { state: q.state, outcome: "RECORDED", effects: q.effects };
	}
	return { state: s3, outcome: "RECORDED", effects: [] };
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
 * The destination heads a permit for `candidate_sha` may bind
 * (specs/amendments/rebase-ancestry-v1.md): the contender's fork base, which
 * every candidate on its fork descends from, then each head a recorded
 * rebase put under that SHA. promote.sh fast-forwards the destination to
 * the candidate, so any other head is one it cannot promote from.
 */
export function permitBases(contender: ContenderRecord, candidate_sha: string): string[] {
	const bases: string[] = typeof contender.fork_base === "string" && contender.fork_base !== "" ? [contender.fork_base] : [];
	for (const r of contender.rebases ?? []) {
		if (r.new_sha === candidate_sha && !bases.includes(r.onto)) bases.push(r.onto);
	}
	return bases;
}

/**
 * Every base the contender's work is known to sit on, oldest first: the
 * fork base, then each recorded rebase head. The evaluator compares a
 * candidate with the newest of these it descends from
 * (specs/amendments/rebase-ancestry-v1.md).
 */
export function evaluationBases(contender: ContenderRecord): string[] {
	const bases: string[] = typeof contender.fork_base === "string" && contender.fork_base !== "" ? [contender.fork_base] : [];
	for (const r of contender.rebases ?? []) if (!bases.includes(r.onto)) bases.push(r.onto);
	return bases;
}

/**
 * CONFLICTED blocks every evidence submission and permit for that contender.
 * A permit for a contributing SHA is also blocked once a COMPOSED or RESOLVED
 * candidate exists, so an earlier side cannot ship in place of the new SHA.
 * A later SHA (an empty republish of the composed tree, for example) is not
 * in `contributing_shas` and is not blocked here; it still needs its own evaluation.
 */
export function compositionBlocks(state: AuthorityState, contenderId: string, sha?: string): boolean {
	const composition = state.composition;
	if (!composition || composition.contender_id !== contenderId) return false;
	if (composition.status === "CONFLICTED") return true;
	if (sha === undefined) return false;
	return sha !== composition.candidate_sha && composition.contributing_shas.includes(sha);
}

function normalizeComposition(input: CompositionRecord): CompositionRecord {
	if (input.status !== "COMPOSED" && input.status !== "CONFLICTED" && input.status !== "RESOLVED") {
		throw new Error("recordComposition: status must be COMPOSED, CONFLICTED, or RESOLVED");
	}
	if (typeof input.contender_id !== "string" || input.contender_id === "") {
		throw new Error("recordComposition: contender_id is required");
	}
	if (typeof input.baseline !== "string" || input.baseline === "") {
		throw new Error("recordComposition: baseline is required");
	}
	if (!Array.isArray(input.contributing_shas) || input.contributing_shas.length < 2) {
		throw new Error("recordComposition: at least two contributing SHAs are required");
	}
	if (!Array.isArray(input.agents) || input.agents.length < 2) {
		throw new Error("recordComposition: at least two agents are required");
	}
	if (input.status === "CONFLICTED") {
		if (input.candidate_sha !== null) throw new Error("recordComposition: CONFLICTED has no candidate SHA");
		if (!Array.isArray(input.files) || input.files.length === 0) {
			throw new Error("recordComposition: CONFLICTED names no files");
		}
	} else if (typeof input.candidate_sha !== "string" || input.candidate_sha === "") {
		throw new Error("recordComposition: COMPOSED and RESOLVED require a candidate SHA");
	} else if (input.contributing_shas.includes(input.candidate_sha)) {
		throw new Error("recordComposition: the candidate SHA must be new, not a contributing SHA");
	}
	const files = (input.files ?? []).map((file) => {
		if (typeof file.path !== "string" || file.path === "" || file.path.includes("..")) {
			throw new Error("recordComposition: conflict path is invalid");
		}
		if (file.classification !== "textual-line-overlap") {
			throw new Error("recordComposition: unknown conflict classification");
		}
		return {
			path: file.path,
			classification: "textual-line-overlap" as const,
			sides: file.sides.map((side) => ({
				agent_id: side.agent_id,
				role: side.role,
				intent: side.intent,
				sha: side.sha,
				excerpt: typeof side.excerpt === "string" ? side.excerpt.slice(0, 400) : "",
			})),
		};
	});
	return {
		status: input.status,
		contender_id: input.contender_id,
		baseline: input.baseline,
		agents: input.agents.map((agent) => ({
			id: agent.id,
			role: agent.role,
			intent: agent.intent,
			sha: agent.sha,
			paths: agent.paths,
			claim_work_id: agent.claim_work_id,
		})),
		contributing_shas: [...input.contributing_shas],
		files,
		candidate_sha: input.status === "CONFLICTED" ? null : input.candidate_sha,
	};
}

/**
 * Record a fork-crew composition. Only the control plane calls this.
 * CONFLICTED cannot be replaced by COMPOSED. The same record is an idempotent no-op.
 */
export async function recordComposition(
	state: AuthorityState,
	input: CompositionRecord,
	ctx: Ctx,
): Promise<AuthorityState> {
	const composition = normalizeComposition(input);
	const contender = state.contenders[composition.contender_id];
	if (!contender) throw new Error(`recordComposition: unknown contender ${composition.contender_id}`);
	if (composition.baseline !== state.task.baseline_commit) {
		throw new Error("recordComposition: baseline is not the frozen task baseline");
	}
	const current = state.composition;
	if (current) {
		if (current.contender_id !== composition.contender_id) {
			throw new Error("recordComposition: this task already has a composition for another contender");
		}
		if (canonicalJson(current) === canonicalJson(composition)) return state;
		if (current.status === "CONFLICTED" && composition.status !== "RESOLVED") {
			throw new Error("recordComposition: CONFLICTED cannot become an ordinary candidate");
		}
		if (current.status !== "CONFLICTED" && composition.status === "CONFLICTED") {
			throw new Error("recordComposition: a candidate cannot be turned back into CONFLICTED");
		}
		if (
			current.status !== "CONFLICTED" &&
			composition.candidate_sha !== current.candidate_sha
		) {
			throw new Error("recordComposition: the candidate SHA is already bound");
		}
	}
	return appendLedger({ ...state, composition }, "composition_recorded", {
		status: composition.status,
		contender_id: composition.contender_id,
		candidate_sha: composition.candidate_sha,
		contributing_shas: composition.contributing_shas,
		files: composition.files.map((file) => file.path),
	}, ctx);
}

export type IssuePermitResult =
	| { state: AuthorityState; outcome: "ISSUED"; permit: PermitRecord }
	| {
			state: AuthorityState;
			outcome: "REBASE_REQUIRED";
			permit: null;
			contender_id: string;
			/** The heads a permit for this candidate could bind. */
			bases: string[];
	  }
	| {
			state: AuthorityState;
			outcome: "UNRESOLVED_CONFLICT";
			permit: null;
			contender_id: string;
	  };

/**
 * Issue the exact-state, single-use permit for an ACCEPT verdict
 * (spec 1 §10). Requires the LATEST verdict record to be ACCEPT with
 * winner_sha. Throws if the task is escalated — promotion is BLOCKED
 * while escalated (spec 1 §9.4); the operator must create a new
 * policy/task state and re-evaluate, never override.
 *
 * Ancestry (specs/amendments/rebase-ancestry-v1.md): the destination head
 * must be one the candidate is known to descend from — the contender's
 * fork base, or a head a recorded rebase put under this SHA. Any other
 * head is REBASE_REQUIRED: no permit is stored, the refusal is ledgered
 * (`permit_refused`), and the caller rebases the candidate onto the head
 * (container/rebase.sh), which yields a new SHA that must be evaluated
 * again before it can get a permit.
 */
export async function issuePermit(
	state: AuthorityState,
	winner_sha: string,
	destination_repo: string,
	destination_head: string,
	ctx: Ctx,
): Promise<IssuePermitResult> {
	const latest = state.verdicts[state.verdicts.length - 1];
	if (!latest || latest.state !== "ACCEPT" || latest.winner_sha !== winner_sha)
		throw new Error(
			`issuePermit: no ACCEPT verdict for ${winner_sha} (latest: ${latest ? latest.state : "none"}) — no permit without eligibility`,
		);
	if (state.task_status === "escalated")
		throw new Error("issuePermit: promotion BLOCKED — task is escalated (spec 1 §9.4)");
	const ev = state.evaluations[winner_sha];
	if (!ev) throw new Error(`issuePermit: no evaluation bundle for winner ${winner_sha}`);
	const contender = Object.hasOwn(state.contenders, ev.contender_id) ? state.contenders[ev.contender_id] : undefined;
	if (!contender) throw new Error(`issuePermit: the winner's contender ${ev.contender_id} is unknown`);
	if (compositionBlocks(state, ev.contender_id, winner_sha)) {
		const refused = await appendLedger(
			state,
			"permit_refused",
			{ outcome: "UNRESOLVED_CONFLICT", winner_sha, contender_id: ev.contender_id },
			ctx,
		);
		return { state: refused, outcome: "UNRESOLVED_CONFLICT", permit: null, contender_id: ev.contender_id };
	}
	const bases = permitBases(contender, winner_sha);
	if (!bases.includes(destination_head)) {
		const refused = await appendLedger(
			state,
			"permit_refused",
			{
				outcome: "REBASE_REQUIRED",
				winner_sha,
				contender_id: ev.contender_id,
				destination_repo,
				destination_head,
				bases,
			},
			ctx,
		);
		return { state: refused, outcome: "REBASE_REQUIRED", permit: null, contender_id: ev.contender_id, bases };
	}
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
	if (existing) return { state, outcome: "ISSUED", permit: existing };
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
	return { state: s3, outcome: "ISSUED", permit };
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
 * single canonical_write effect: fast-forward the destination from the
 * permit-bound head (`base`) to the reviewed candidate commit.
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
	if (compositionBlocks(state, permit.contender_id, permit.winner_candidate_sha)) {
		const blocked = await appendLedger(
			state,
			"promotion_aborted",
			{ permit_id, error: "UNRESOLVED_CONFLICT", winner_sha: permit.winner_candidate_sha },
			ctx,
		);
		return { state: blocked, outcome: "UNRESOLVED_CONFLICT", effects: [] };
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
				commit: permit.winner_candidate_sha,
				tree_sha256,
				base: permit.expected_destination_head,
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
 * is missing, or if the promoted commit is not the permit's candidate:
 * promotion fast-forwards to the reviewed commit itself.
 *
 * The ship record's `base` is the permit-bound destination head; its
 * `parent` is the promoted commit's own first parent as git reported it
 * (promote.sh's PARENT; "" for a root commit). The two differ whenever the
 * candidate is more than one commit above the base
 * (specs/amendments/rebase-ancestry-v1.md).
 */
export async function recordPromotionBundle(
	state: AuthorityState,
	permit_id: string,
	promoted: { commit: string; parent: string },
	signer: Signer & { publicKeyDerHex: string },
	ctx: Ctx,
): Promise<{ state: AuthorityState; bundle: PromotionBundle }> {
	const permit = state.permits[permit_id];
	if (!permit?.consumed) throw new Error(`promotion bundle: permit ${permit_id} is not consumed`);
	if (promoted.commit !== permit.winner_candidate_sha)
		throw new Error(
			`promotion bundle: the promoted commit ${promoted.commit} is not permit ${permit_id}'s candidate ${permit.winner_candidate_sha}`,
		);
	if (typeof promoted.parent !== "string") throw new Error("promotion bundle: the promoted commit's parent is missing");
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
			// The evaluation domain's configuration digest. A bundle without one
			// (slice harness, older records) falls back to its own hash.
			testConfigDigest: evaluation.evaluation_config_sha256 ?? evaluation.bundle_hash,
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
			destinationBase: permit.expected_destination_head,
			nonce: permit.nonce,
			permitId: permit.permit_id,
			issuedAt: permit.issued_at,
			ledgerHeadSha256: head,
		}),
	];
	const envelopes = [];
	for (const statement of statements) envelopes.push(await signEnvelope(statement, signer));
	const bundle: PromotionBundle = {
		version: 3,
		statements: envelopes,
		ship: {
			repo: permit.destination_repo,
			commit: promoted.commit,
			tree_sha256: tree,
			base: permit.expected_destination_head,
			parent: promoted.parent,
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
		{
			kind: "cancel_workflow",
			contender_id,
			permit_ids: Object.values(state.permits)
				.filter((p) => p.contender_id === contender_id && !p.consumed)
				.map((p) => p.permit_id),
		},
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
	data?: RebaseConflictData,
): Promise<{ state: AuthorityState }> {
	const escalation: EscalationRecord = { reason, at: ctx.now(), resolved: false, ...(data === undefined ? {} : { data }) };
	const s2: AuthorityState = {
		...state,
		task_status: "escalated",
		escalations: [...state.escalations, escalation],
	};
	const s3 = await appendLedger(s2, "escalated", data === undefined ? { reason } : { reason, data }, ctx);
	return { state: s3 };
}

/* ------------------------------------------------------------------ */
/* Rebase reports (specs/amendments/rebase-ancestry-v1.md)              */
/* ------------------------------------------------------------------ */

/** What container/rebase.sh reported, as the Worker forwards it. */
export interface RebaseReport {
	contender_id: string;
	outcome: "REBASED" | "UP_TO_DATE" | "CONFLICT";
	/** The candidate the rebase service was asked to rebase. */
	from_sha: string;
	/** The destination head it rebased onto. */
	onto: string;
	/** REBASED only: the commit pushed to the contender's fork. */
	new_sha?: string;
	/** CONFLICT only: the conflicting paths. */
	paths?: string[];
}

export type RecordRebaseOutcome = "RECORDED" | "ESCALATED" | "ACK_DUP";

/** Conflict paths kept on an escalation; the total is recorded beside them. */
const MAX_CONFLICT_PATHS = 1000;

function nonEmptyString(v: unknown): v is string {
	return typeof v === "string" && v !== "";
}

/**
 * Record what the rebase service reported for a contender's candidate
 * (specs/amendments/rebase-ancestry-v1.md).
 *
 * - REBASED: `onto` is now an ancestor of `new_sha`, the commit the service
 *   pushed to the contender's fork. If the authority's latest observed
 *   commit for the contender is still `from_sha`, it becomes `new_sha`: the
 *   rebased commit re-enters evaluation and has no evidence until the
 *   evaluation domain submits some. A newer observed push is never moved
 *   back.
 * - UP_TO_DATE: `from_sha` already descended from `onto`; the record says so
 *   and nothing else changes.
 * - CONFLICT: the task is escalated to the operator-of-record (spec 1
 *   §9.4). The conflicting paths are kept as structured data on the
 *   escalation, never in its reason text: the contender chose them.
 *
 * A report identical to one already recorded is ACK_DUP (no state change).
 * Throws for an unknown, quarantined or revoked contender, or a malformed
 * report. The caller (the Worker's rebase route) is the control plane;
 * the report comes from the trusted promotion container.
 */
export async function recordRebase(
	state: AuthorityState,
	report: RebaseReport,
	ctx: Ctx,
): Promise<{ state: AuthorityState; outcome: RecordRebaseOutcome; effects: Effect[] }> {
	const contender = Object.hasOwn(state.contenders, report?.contender_id) ? state.contenders[report.contender_id] : undefined;
	if (contender === undefined) throw new Error(`recordRebase: unknown contender ${JSON.stringify(report?.contender_id)}`);
	const sanction = state.quarantine[report.contender_id]?.status;
	if (sanction === "QUARANTINED" || sanction === "REVOKED")
		throw new Error(`recordRebase: contender ${report.contender_id} is ${sanction.toLowerCase()}`);
	if (!nonEmptyString(report.from_sha) || !nonEmptyString(report.onto))
		throw new Error("recordRebase: from_sha and onto are required");

	if (report.outcome === "CONFLICT") {
		const paths = report.paths;
		if (!Array.isArray(paths) || paths.length === 0 || !paths.every(nonEmptyString))
			throw new Error("recordRebase: a CONFLICT report needs its conflicting paths");
		const data: RebaseConflictData = {
			kind: "rebase_conflict",
			contender_id: report.contender_id,
			candidate_sha: report.from_sha,
			onto: report.onto,
			paths: paths.slice(0, MAX_CONFLICT_PATHS),
			paths_total: paths.length,
		};
		const open = state.escalations.some(
			(e) => !e.resolved && e.data !== undefined && canonicalJson(e.data) === canonicalJson(data),
		);
		if (open && state.task_status === "escalated") return { state, outcome: "ACK_DUP", effects: [] };
		const escalated = await escalateToOperator(state, "rebase conflict: the candidate does not apply cleanly onto the destination head", ctx, data);
		return { state: escalated.state, outcome: "ESCALATED", effects: [] };
	}

	let record: RebaseRecord;
	if (report.outcome === "REBASED") {
		if (!nonEmptyString(report.new_sha) || report.new_sha === report.from_sha || report.new_sha === report.onto)
			throw new Error("recordRebase: a REBASED report needs the new_sha it pushed, distinct from from_sha and onto");
		record = { outcome: "REBASED", from_sha: report.from_sha, onto: report.onto, new_sha: report.new_sha, at: ctx.now() };
	} else if (report.outcome === "UP_TO_DATE") {
		if (report.new_sha !== undefined && report.new_sha !== report.from_sha)
			throw new Error("recordRebase: an UP_TO_DATE report's new_sha, if any, is its from_sha");
		record = { outcome: "UP_TO_DATE", from_sha: report.from_sha, onto: report.onto, new_sha: report.from_sha, at: ctx.now() };
	} else {
		throw new Error(`recordRebase: unknown outcome ${JSON.stringify((report as { outcome?: unknown }).outcome)}`);
	}
	const same = (r: RebaseRecord) =>
		r.outcome === record.outcome && r.from_sha === record.from_sha && r.onto === record.onto && r.new_sha === record.new_sha;
	if ((contender.rebases ?? []).some(same)) return { state, outcome: "ACK_DUP", effects: [] };
	const updated: ContenderRecord = {
		...contender,
		rebases: [...(contender.rebases ?? []), record],
		latest_commit:
			record.outcome === "REBASED" && contender.latest_commit === record.from_sha ? record.new_sha : contender.latest_commit,
	};
	const s2 = await appendLedger(
		{ ...state, contenders: { ...state.contenders, [report.contender_id]: updated } },
		"rebase_recorded",
		{
			contender_id: report.contender_id,
			outcome: record.outcome,
			from_sha: record.from_sha,
			onto: record.onto,
			new_sha: record.new_sha,
		},
		ctx,
	);
	return { state: s2, outcome: "RECORDED", effects: [] };
}
