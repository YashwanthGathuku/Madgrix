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
	/** Hex signature over canonical_json(report minus signature). */
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
	| "QUARANTINED_CANDIDATE"
	| "UNKNOWN_PERMIT";

/* ------------------------------------------------------------------ */
/* Quarantine (spec 1 §9.5, spec 3 §7 — FROZEN lifecycle)               */
/* ------------------------------------------------------------------ */

export type QuarantineTrigger =
	| "eval_file_modification"
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
	 * Anonymized candidate label → candidate_sha, assigned by the control
	 * plane when handing candidates to blind verifiers (spec 1 §8).
	 * The verdict seam resolves verifier reports' anonymized
	 * `candidate_label`s through this map; verifiers never see SHAs.
	 */
	candidate_labels: Record<string, string>;
	seen_event_keys: string[];
	escalations: { reason: string; at: string; resolved: boolean }[];
	ledger: LedgerEntry[];
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
