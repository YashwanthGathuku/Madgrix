/**
 * Shared domain types for the governed promotion protocol
 * (internal codename: seam — NOT a public brand).
 *
 * This file is the contract between the platform layer
 * (artifacts port, Durable Object wrapper, Worker) and the protocol layer
 * (claims, evaluation, blind verifiers, verdict seam, permits, attestation).
 * It is derived from the FROZEN-v1 specs in ../specs/:
 *   - PROMOTION_PROTOCOL.md (spec 1)
 *   - EVALUATION_THREAT_MODEL.md (spec 3)
 *   - CLOUDFLARE_RUNTIME_MODEL.md (spec 5)
 *   - INTENT_AND_CONFLICT_GRAPH.md (spec 2)
 *   - ATTESTATION_PROTOCOL.md (spec 4)
 *   - BENCHMARK_PROTOCOL.md (spec 6)
 *
 * "Verdict Seam" / "Promotion Seam" are in-architecture terminology.
 */

/* ------------------------------------------------------------------ */
/* Trust zones & caller identity (spec 3 §2, §5 — credential matrix)    */
/* ------------------------------------------------------------------ */

/**
 * The five trust zones (spec 3 §2) plus "unknown" for unauthenticated
 * callers. The authority maps caller identity → zone → allowed actions;
 * transport-level authentication of that identity is the edge's job
 * (marked TODO where it cannot exist locally).
 */
export type TrustZone =
	| "control_plane"
	| "contender"
	| "evaluation_domain"
	| "verdict_plane"
	| "promotion"
	| "unknown";

/** Who is invoking an authority transition. */
export interface CallerIdentity {
	zone: TrustZone;
	/** Optional actor label for audit (contender_id, service name…). Never trusted for authorization. */
	actor?: string;
}

/**
 * A verifier's registered public key, bound to its verifier_id at task
 * freeze (spec 1 §8). The authority rejects any report that is not signed
 * by the registered key.
 */
export interface VerifierPublicKey {
	verifier_id: string;
	/** SHA-256 hex over the SPKI DER — derived from the key material. */
	keyid: string;
	/** SPKI DER of the Ed25519 public key, hex-encoded. */
	public_key_der_hex: string;
}

/* ------------------------------------------------------------------ */
/* Task                                                               */
/* ------------------------------------------------------------------ */

export interface TaskRecord {
	task_id: string;
	/** SHA-256 over the canonical frozen task record (spec 1 §5). */
	task_hash: string;
	intent: string;
	baseline_repo: string;
	baseline_commit: string;
	/** Falsifiable behavior contract text; may be "". */
	behavior_contract: string;
	/** e.g. "seam-policy/0.1.0" */
	policy_version: string;
	/** RFC3339 */
	frozen_at: string;
}

/* ------------------------------------------------------------------ */
/* Work claims & conflict graph (spec 2)                               */
/* ------------------------------------------------------------------ */

export type ClaimStatus = "claimed" | "active" | "submitted" | "released" | "expired";

/** WorkClaim schema — frozen per spec 2 §2. */
export interface WorkClaim {
	work_id: string;
	/** contender identity */
	agent: string;
	/** task_hash this claim attaches to */
	task: string;
	/** baseline commit the claim is built against */
	baseline: string;
	intent: { behavior: string[] };
	scope: { paths: string[]; symbols: string[] };
	contracts: { reads: string[]; modifies: string[] };
	interfaces: string[];
	schema_changes: string[];
	expected_tests: string[];
	lease: { claimed_at: string; expires_at: string };
	status: ClaimStatus;
	version: number;
	/**
	 * SHA-256 (hex) of the per-agent secret that /claim returns once.
	 * Assigned by the authority, never accepted from the caller, never
	 * returned by the Worker's public routes. Absent on claims registered
	 * before agent binding (specs/amendments/contender-agent-binding.md).
	 */
	agent_secret_sha256?: string;
}

export type ConflictRisk = "GREEN" | "AMBER" | "RED" | "BLOCKED";

export interface ConflictLayers {
	text: string[];
	symbol: string[];
	impact: string[];
	contract: string[];
	state: string[];
}

export interface ConflictReport {
	claim_a: string;
	claim_b: string;
	risk: ConflictRisk;
	layers: ConflictLayers;
	/** Deterministic, human-readable explanation of the finding. */
	explanation: string;
}

/* ------------------------------------------------------------------ */
/* Contenders & evaluation                                             */
/* ------------------------------------------------------------------ */

export type ContenderStatus = "forked" | "submitted" | "quarantined" | "revoked" | "released";

export interface ContenderRecord {
	contender_id: string;
	agent_id: string;
	fork_repo: string;
	fork_lineage: { parent_repo: string; parent_commit: string };
	/** Token id (NOT the plaintext) for auditability. */
	token_id: string;
	/**
	 * Every token id minted for this contender; quarantine revokes all of
	 * them. Absent on records written before this field existed, which
	 * carry only `token_id`.
	 */
	token_ids?: string[];
	status: ContenderStatus;
	claim_work_id: string | null;
	/** Last observed commit SHA on the contender's branch. */
	latest_commit: string | null;
}

/** Admission gates (spec 1 §6). All boolean; evaluated by the control plane. */
export interface AdmissionGates {
	exact_baseline: boolean;
	scope_compliance: boolean;
	valid_tool_states: boolean;
	no_eval_tampering: boolean;
	provenance_complete: boolean;
}

export interface TestSuiteResult {
	passed: boolean;
	total: number;
	failed: string[];
}

export interface StaticAnalysisResult {
	passed: boolean;
	findings: string[];
}

/** The complete, content-addressed record of everything measured about a
 *  candidate (spec 1 §3). Produced ONLY by the evaluation domain. */
export interface EvaluationBundle {
	candidate_sha: string;
	tree_sha256: string;
	contender_id: string;
	task_hash: string;
	admission: AdmissionGates;
	hidden_oracle: TestSuiteResult;
	regressions: TestSuiteResult;
	static_analysis: StaticAnalysisResult;
	semantic_checks: TestSuiteResult;
	security_policy: StaticAnalysisResult;
	bundle_hash: string;
	evaluated_at: string;
	/** Set true when the contender is quarantined (spec 3 §7). */
	tainted: boolean;
}

/* ------------------------------------------------------------------ */
/* Blind verifiers (spec 1 §8 — FROZEN construction)                   */
/* ------------------------------------------------------------------ */

export interface ReferenceReport {
	expected_behavior: string[];
	invariants: string[];
	likely_failure_modes: string[];
	evaluation_plan: string[];
	security_expectations: string[];
}

export interface VerifierCommitment {
	verifier_id: string;
	task_hash: string;
	policy_version: string;
	/**
	 * SHA256(canonical_json(ReferenceReport) || nonce || task_hash ||
	 *         verifier_id || policy_version), with "||" encoded as \x00
	 * separators. Stored in the task authority BEFORE any candidate is shown.
	 */
	commitment: string;
	committed_at: string;
}

export type VerifierVerdict = "accept" | "reject" | "abstain";

export interface VerdictReport {
	verifier_id: string;
	/** Anonymized label, e.g. "candidate-7f31" — NEVER a contender identity. */
	candidate_label: string;
	verdict: VerifierVerdict;
	reasons: string[];
	/** Base64 signature over canonical_json(report minus signature). */
	signature: string;
	keyid: string;
}

/* ------------------------------------------------------------------ */
/* Verdict seam (spec 1 §9)                                            */
/* ------------------------------------------------------------------ */

export type VerdictState = "ACCEPT" | "REJECT" | "ABSTAIN" | "ESCALATE" | "QUARANTINE";

export interface VerdictRecord {
	state: VerdictState;
	candidate_shas: string[];
	evidence_hashes: string[];
	reasons: string[];
	policy_hash: string;
	selector_policy_version: string;
	timestamp: string;
	winner_sha: string | null;
}

/* ------------------------------------------------------------------ */
/* Exact-state permit (spec 1 §10–11)                                  */
/* ------------------------------------------------------------------ */

export interface PermitRecord {
	permit_id: string;
	task_hash: string;
	baseline_commit: string;
	winner_candidate_sha: string;
	contender_id: string;
	winning_tree_sha256: string;
	evaluation_bundle_hash: string;
	selector_policy_hash: string;
	destination_repo: string;
	expected_destination_head: string;
	nonce: string;
	issued_at: string;
	consumed: boolean;
	consumed_at: string | null;
}

export type PromotionOutcome =
	| "PROMOTED"
	| "ALREADY_CONSUMED"
	| "EXPIRED_HEAD_MOVED"
	| "TREE_MISMATCH"
	| "EVAL_BUNDLE_MISMATCH"
	| "QUARANTINED_CANDIDATE"
	| "UNKNOWN_PERMIT";

/* ------------------------------------------------------------------ */
/* Quarantine (spec 1 §9.5, spec 3 §7 — FROZEN lifecycle)               */
/* ------------------------------------------------------------------ */

export type QuarantineTrigger =
	| "eval_file_modification"
	/**
	 * Amendment `specs/amendments/evaluator-config-trigger.md`: evaluator-config
	 * modification (spec 3 §6 attack 3, §4.3 evaluator locking) is a DISTINCT
	 * mechanical trigger — a pre-run locked-config hash mismatch — not a
	 * hidden_eval_boundary_violation. The frozen §9.5 trigger list names the
	 * category closed; this member extends it via the amendment mechanism.
	 */
	| "evaluator_config_modification"
	| "unauthorized_canonical_write"
	| "candidate_sha_substitution"
	| "forged_evidence"
	| "tool_status_fabrication"
	| "permit_replay"
	| "credential_scope_violation"
	| "hidden_eval_boundary_violation";

export type QuarantineStatus = "QUARANTINED" | "RELEASED" | "REVOKED";

export interface QuarantineRecord {
	contender_id: string;
	trigger: QuarantineTrigger;
	evidence_hash: string;
	entered_at: string;
	status: QuarantineStatus;
	reviewed_by: string | null;
	review_note: string | null;
}

/* ------------------------------------------------------------------ */
/* Task authority state (spec 5 §4) — the Durable Object's state.       */
/* Pure data; all transitions live in task-state.ts.                   */
/* ------------------------------------------------------------------ */

export interface LedgerEntry {
	seq: number;
	ts: string;
	kind: string;
	payload_hash: string;
	/** entry_hash of the previous entry; 64 zeros for the genesis entry. */
	prev_hash: string;
	/**
	 * SHA-256 over canonical JSON of the five fields above (src/lib/ledger.ts).
	 * "" until sealed: the genesis entry until the first append.
	 */
	entry_hash: string;
}

export interface AuthorityState {
	task: TaskRecord;
	task_status: "frozen" | "verdict_reached" | "promoted" | "escalated" | "rejected";
	contenders: Record<string, ContenderRecord>;
	claims: WorkClaim[];
	/** Keyed by candidate_sha. */
	evaluations: Record<string, EvaluationBundle>;
	/** Keyed by verifier_id. */
	verifier_commitments: Record<string, VerifierCommitment>;
	/** Keyed by verifier_id — revealed ReferenceReport after valid reveal. */
	verifier_reveals: Record<string, ReferenceReport>;
	/**
	 * verifier_id → reason participation ended (invalid reveal; spec 1 §8:
	 * no retry with a rewritten opinion). Optional for forward
	 * compatibility; absent means no verifier has been ended.
	 */
	ended_verifiers?: Record<string, string>;
	/** Admissible verifier reports (valid prior commitment + reveal). */
	verdict_reports: VerdictReport[];
	verdicts: VerdictRecord[];
	/** Keyed by permit_id. */
	permits: Record<string, PermitRecord>;
	/** Keyed by contender_id. */
	quarantine: Record<string, QuarantineRecord>;
	/**
	 * Verifier public keys, keyed by verifier_id, registered at task freeze
	 * (spec 1 §8). Every submitted VerdictReport must carry a valid
	 * signature from the registered key — unsigned/forged reports are
	 * rejected. Keys are immutable once registered.
	 */
	verifier_keys: Record<string, VerifierPublicKey>;
	/**
	 * Operator-of-record public keys, keyed by keyid, registered at task
	 * freeze (spec 1 §9.4). Quarantine determinations (RELEASED/REVOKED)
	 * must carry a valid signature from a registered operator key.
	 */
	operator_keys: Record<string, string>;
	/**
	 * Anonymized candidate label → candidate_sha, assigned by the control
	 * plane when handing candidates to blind verifiers (spec 1 §8).
	 * The verdict seam resolves verifier reports' anonymized
	 * `candidate_label`s through this map; verifiers never see SHAs.
	 */
	candidate_labels: Record<string, string>;
	seen_event_keys: string[];
	escalations: { reason: string; at: string; resolved: boolean }[];
	ledger: LedgerEntry[];
	/**
	 * Authority-signed promotion bundles (ship records), keyed by the
	 * consumed permit_id (spec 1 §11; amendment authority-signing-v1).
	 * Absent until the task's first promotion.
	 */
	promotion_bundles?: Record<string, import("./attestation.ts").PromotionBundle>;
}

/** Queue push event (spec 5 §3). NOTE: event_key is derived from content,
 *  never from Queue metadata. */
export interface QueuePushEvent {
	namespace: string;
	repo: string;
	ref: string;
	before: string;
	after: string;
}

/* ------------------------------------------------------------------ */
/* Policy                                                              */
/* ------------------------------------------------------------------ */

export const SELECTOR_POLICY_VERSION = "seam-policy/0.1.0";
export const SELECTOR_VERSION = "seam-selector/0.1.0";
