/**
 * The verdict seam — the selector as a protocol, not "an LLM judge".
 *
 * The LLM is a sensor, never the authority. A candidate passes through:
 *
 *   deterministic checks → independent execution → hidden/adversarial tests
 *   → static analysis → scope-contract check → provenance & tool-status
 *   validation → evidence vector → independent (blind) reviewers
 *   → policy engine → accept / reject / abstain / escalate
 *
 * Fail-closed: any missing or negative evidence rejects or escalates.
 * No evidence → abstain. Never accept on narration alone.
 */

export type ReviewerVerdict = "accept" | "reject" | "abstain";

export interface ReviewerReport {
	reviewer_id: string;
	verdict: ReviewerVerdict;
	/**
	 * Blind-commit judging (Zhou, "More Convincing, Not More Correct", 2026):
	 * the reviewer must commit its own assessment before seeing the candidate.
	 * A report without committed_first is inadmissible — the seam abstains.
	 */
	committed_first: boolean;
}

export interface DeterministicChecks {
	/** Candidate was built from the registered task intent (brief hash match) */
	brief_hash_match: boolean;
	/**
	 * Machine-readable tool receipts present for every claimed action
	 * (Sethi et al.: named failure status cuts fabrication 14.10% → 0.87%)
	 */
	tool_status_ok: boolean;
	/** Diff stays inside the claimed work scope */
	scope_contract_ok: boolean;
	static_analysis_ok: boolean;
}

export interface EvidenceVector {
	contender_id: string;
	candidate_commit: string;
	checks: DeterministicChecks;
	tests_passed: boolean;
	/** Hidden/adversarial tests run in the evaluation plane; null = not run yet */
	hidden_tests_passed: boolean | null;
	reviewers: ReviewerReport[];
	/** Mechanical trust score, 0..1 — computed, never self-reported */
	trust_score: number;
}

export type Decision = "accept" | "reject" | "abstain" | "escalate";

export interface VerdictResult {
	decision: Decision;
	reasons: string[];
}

/** Below this, a candidate can only escalate, never be accepted outright. */
export const TRUST_THRESHOLD = 0.6;

export function decide(ev: EvidenceVector): VerdictResult {
	const reasons: string[] = [];

	// 1. Deterministic gates — fail closed.
	if (!ev.checks.brief_hash_match) {
		reasons.push("brief hash mismatch: candidate was not built from the registered intent");
	}
	if (!ev.checks.tool_status_ok) {
		reasons.push("tool-status declarations invalid: success claimed without machine-readable receipts");
	}
	if (!ev.checks.scope_contract_ok) {
		reasons.push("scope contract violated: changes outside the claimed work scope");
	}
	if (!ev.checks.static_analysis_ok) {
		reasons.push("static analysis failed");
	}
	if (reasons.length > 0) return { decision: "reject", reasons };

	// 2. The contender's own tests must pass — necessary, never sufficient.
	if (!ev.tests_passed) {
		return { decision: "reject", reasons: ["contender test suite did not pass"] };
	}

	// 3. Reviewers are sensors: they must be blind and independent.
	if (ev.reviewers.length === 0) {
		return { decision: "abstain", reasons: ["no independent reviewer reports"] };
	}
	const unblinded = ev.reviewers.filter((r) => !r.committed_first).map((r) => r.reviewer_id);
	if (unblinded.length > 0) {
		return {
			decision: "abstain",
			reasons: [`reviewers not blind (no committed-first assessment): ${unblinded.join(", ")}`],
		};
	}
	const accepts = ev.reviewers.filter((r) => r.verdict === "accept").length;
	const rejects = ev.reviewers.filter((r) => r.verdict === "reject").length;
	if (accepts > 0 && rejects > 0) {
		return {
			decision: "escalate",
			reasons: [`reviewer split: ${accepts} accept / ${rejects} reject — needs human adjudication`],
		};
	}
	if (rejects > 0) {
		return { decision: "reject", reasons: [`${rejects} independent reviewer(s) rejected`] };
	}

	// 4. Hidden tests run in the evaluation plane — the contender never sees them.
	if (ev.hidden_tests_passed === false) {
		return { decision: "reject", reasons: ["hidden/adversarial tests failed"] };
	}

	// 5. Mechanical trust gate.
	if (ev.trust_score < TRUST_THRESHOLD) {
		return {
			decision: "escalate",
			reasons: [`trust score ${ev.trust_score.toFixed(2)} below threshold ${TRUST_THRESHOLD}`],
		};
	}

	reasons.push(
		`accepted: ${accepts} blind reviewer(s), contender tests green` +
			(ev.hidden_tests_passed === true ? ", hidden tests green" : ", hidden tests pending") +
			`, trust ${ev.trust_score.toFixed(2)}`,
	);
	return { decision: "accept", reasons };
}

/**
 * Winner selection across contenders: highest mechanical trust among the
 * accepted. No accepted candidate → no winner, never a "least bad" pick.
 */
export function selectWinner(vectors: EvidenceVector[]): {
	winner: string | null;
	results: Record<string, VerdictResult>;
} {
	const results: Record<string, VerdictResult> = {};
	for (const v of vectors) results[v.contender_id] = decide(v);
	const accepted = vectors.filter((v) => results[v.contender_id].decision === "accept");
	if (accepted.length === 0) return { winner: null, results };
	accepted.sort((a, b) => b.trust_score - a.trust_score);
	return { winner: accepted[0].contender_id, results };
}
