/**
 * The verdict seam (spec 1 §9): non-compensatory eligibility AND-gates,
 * then objective dominance, then blind 2-of-3 verifier vote.
 *
 * THERE IS NO COMPENSATING TRUST SCORE IN THIS FILE. The construction
 *   score = 0.40*tests + 0.25*reviewer + … = PASS
 * is explicitly FORBIDDEN by spec 1 §9.1, because it permits
 * "security failure = -10, beautiful code = +20, TOTAL = PASS".
 * A security or provenance violation MUST NEVER be outweighed by code
 * quality. The word "score" does not appear as a mechanism anywhere here.
 *
 * The selection rule is deterministic given the evidence and the frozen
 * selector_policy_hash, and it can only ever select within the eligible
 * set — it is incapable of promoting an ineligible candidate.
 */

import { canonicalJson } from "./canonical.ts";
import { hasUnresolvedMergeArtifacts, mergeArtifactScanComplete } from "./merge-artifacts.ts";
import type {
	EvaluationBundle,
	VerdictRecord,
	VerdictReport,
} from "./types.ts";

export type Sha256Hex = (input: string | Uint8Array) => Promise<string>;

export interface RankedCandidate {
	contender_id: string;
	candidate_sha: string;
	tree_sha256: string;
	bundle: EvaluationBundle;
	/** Semantic blast radius (spec 2 risk profile), lower is better. */
	blast_radius: number;
	/** Unnecessary change surface (minimality), lower is better. */
	change_surface: number;
}

/* ------------------------------------------------------------------ */
/* 9.1 Eligibility: the non-compensatory AND conjuncts.                 */
/* Passing tests do not outweigh an unresolved merge artifact.          */
/* ------------------------------------------------------------------ */

const ELIGIBILITY_CHECKS: {
	name: string;
	evidence: (b: EvaluationBundle) => boolean;
}[] = [
	{ name: "baseline_valid", evidence: (b) => b.admission.exact_baseline },
	{ name: "scope_valid", evidence: (b) => b.admission.scope_compliance },
	{
		// no_eval_tampering, and a merge-artifact scan that is complete and
		// bound to this candidate and this tree. A missing or malformed scan
		// is an integrity failure. It is not treated as "no artifacts found".
		name: "evaluation_integrity_valid",
		evidence: (b) => b.admission.no_eval_tampering && mergeArtifactScanComplete(b),
	},
	{
		name: "provenance_valid",
		evidence: (b) => b.admission.provenance_complete && b.admission.valid_tool_states,
	},
	{
		name: "required_tests_pass",
		evidence: (b) => b.regressions.passed && b.hidden_oracle.passed,
	},
	{
		name: "policy_valid",
		evidence: (b) => b.security_policy.passed && b.static_analysis.passed,
	},
	{
		// A non-empty path list is the evaluator's report of marker pairs or
		// an unmerged index. Passing tests do not compensate. An empty list
		// passes this gate only. Completeness is evaluation_integrity_valid.
		name: "no_unresolved_merge_artifacts",
		evidence: (b) => !hasUnresolvedMergeArtifacts(b),
	},
];

/**
 * Recompute bundle_hash first: a mismatch means the bundle is not the
 * measured evidence it claims to be → ineligible, full stop.
 */
export async function eligibility(
	bundle: EvaluationBundle,
	sha256Hex: Sha256Hex,
): Promise<{ eligible: boolean; failed: string[] }> {
	const { bundle_hash, ...rest } = bundle;
	const recomputed = await sha256Hex(canonicalJson(rest));
	if (recomputed !== bundle_hash) {
		return { eligible: false, failed: ["evaluation_bundle_hash mismatch"] };
	}
	const failed = ELIGIBILITY_CHECKS.filter((c) => !c.evidence(bundle)).map((c) => c.name);
	return { eligible: failed.length === 0, failed };
}

/* ------------------------------------------------------------------ */
/* 9.2 Objective dominance (correctness → regressions → security →     */
/*     blast radius → change surface).                                 */
/* ------------------------------------------------------------------ */

interface Dims {
	/** hidden-oracle pass ratio, higher better */
	correctness: number;
	/** regression failures, lower better */
	regressionFailures: number;
	/** security findings, lower better */
	securityFindings: number;
	/** lower better */
	blastRadius: number;
	/** lower better */
	changeSurface: number;
}

function dimsOf(c: RankedCandidate): Dims {
	const h = c.bundle.hidden_oracle;
	const passedCount = h.total - h.failed.length;
	return {
		correctness: h.total > 0 ? passedCount / h.total : 1,
		regressionFailures: c.bundle.regressions.failed.length,
		securityFindings: c.bundle.security_policy.findings.length,
		blastRadius: c.blast_radius,
		changeSurface: c.change_surface,
	};
}

/** A dominates B: no worse on every dimension, strictly better on ≥1. */
export function dominates(a: RankedCandidate, b: RankedCandidate): boolean {
	const da = dimsOf(a);
	const db = dimsOf(b);
	let strictlyBetter = false;
	if (da.correctness < db.correctness) return false;
	if (da.correctness > db.correctness) strictlyBetter = true;
	if (da.regressionFailures > db.regressionFailures) return false;
	if (da.regressionFailures < db.regressionFailures) strictlyBetter = true;
	if (da.securityFindings > db.securityFindings) return false;
	if (da.securityFindings < db.securityFindings) strictlyBetter = true;
	if (da.blastRadius > db.blastRadius) return false;
	if (da.blastRadius < db.blastRadius) strictlyBetter = true;
	if (da.changeSurface > db.changeSurface) return false;
	if (da.changeSurface < db.changeSurface) strictlyBetter = true;
	return strictlyBetter;
}

/**
 * dominant = the unique candidate dominating ALL others, else null.
 * frontier = the non-dominated set.
 */
export function dominanceRank(candidates: RankedCandidate[]): {
	dominant: RankedCandidate | null;
	frontier: RankedCandidate[];
} {
	const dominators = candidates.filter((c) =>
		candidates.every((o) => o === c || dominates(c, o)),
	);
	const frontier = candidates.filter(
		(c) => !candidates.some((o) => o !== c && dominates(o, c)),
	);
	return {
		dominant: dominators.length === 1 ? dominators[0] : null,
		frontier,
	};
}

/* ------------------------------------------------------------------ */
/* Blind verifier vote. Reports carry the ANONYMIZED candidate_label    */
/* (e.g. "candidate-7f31" — never a contender identity or SHA). The     */
/* caller resolves labels to SHAs through `labelToSha`, the             */
/* authority-held mapping assigned when candidates were handed to the   */
/* verifiers (spec 1 §8). A report whose label is already a SHA resolves */
/* to itself, so callers that pre-map keep working. Labels that resolve */
/* to nothing are not eligible candidates under consideration — ignored.*/
/* Only admissible reports (valid prior commitment + reveal) are       */
/* passed in.                                                           */
/* ------------------------------------------------------------------ */

export interface VoteTally {
	accepts: number;
	rejects: number;
	abstains: number;
}

export function tallyVotes(
	reports: VerdictReport[],
	candidateShas: string[],
	labelToSha: Record<string, string> = {},
): Record<string, VoteTally> {
	const tally: Record<string, VoteTally> = {};
	for (const sha of candidateShas) tally[sha] = { accepts: 0, rejects: 0, abstains: 0 };
	for (const r of reports) {
		const sha = labelToSha[r.candidate_label] ?? r.candidate_label;
		const t = tally[sha];
		if (!t) continue; // not an eligible candidate under consideration — ignore
		if (r.verdict === "accept") t.accepts++;
		else if (r.verdict === "reject") t.rejects++;
		else t.abstains++;
	}
	return tally;
}

/* ------------------------------------------------------------------ */
/* The seam.                                                           */
/* ------------------------------------------------------------------ */

export interface RunVerdictInput {
	candidates: RankedCandidate[];
	reports: VerdictReport[];
	quarantinedContenderIds: string[];
	policyHash: string;
	policyVersion: string;
	now: string;
	sha256Hex: Sha256Hex;
	/**
	 * Authority-held anonymized-label → candidate_sha mapping
	 * (spec 1 §8). The seam resolves each report's `candidate_label`
	 * through it before tallying; without it, admissible votes on
	 * anonymized labels would be silently dropped.
	 */
	labelToSha?: Record<string, string>;
}

/**
 * Run the verdict seam. NOTE: this is async (not the sync signature a
 * first sketch might suggest) because eligibility MUST recompute
 * bundle_hash inside the seam — hashing is async.
 *
 * (a) drop quarantined contenders' candidates
 * (b) eligibility filter; none eligible → REJECT
 * (c) unique dominant → ACCEPT
 * (d) else vote: ≥2 accepts AND strictly more than any other → ACCEPT
 * (e) conflicting admissible evidence → ESCALATE
 * (f) otherwise ABSTAIN
 */
export async function runVerdict(input: RunVerdictInput): Promise<VerdictRecord> {
	const considered = input.candidates.filter(
		(c) => !input.quarantinedContenderIds.includes(c.contender_id),
	);
	const candidate_shas = considered.map((c) => c.candidate_sha);
	const evidence_hashes = considered.map((c) => c.bundle.bundle_hash);
	const reasons: string[] = [];

	const base: Omit<VerdictRecord, "state" | "reasons" | "winner_sha"> = {
		candidate_shas,
		evidence_hashes,
		policy_hash: input.policyHash,
		selector_policy_version: input.policyVersion,
		timestamp: input.now,
	};

	// (b) eligibility
	const checks = await Promise.all(
		considered.map(async (c) => ({ c, ...(await eligibility(c.bundle, input.sha256Hex)) })),
	);
	const eligible = checks.filter((x) => x.eligible).map((x) => x.c);

	if (eligible.length === 0) {
		if (considered.length === 0) {
			reasons.push("no candidates under consideration (all quarantined or none submitted)");
		} else {
			for (const x of checks) {
				reasons.push(
					`candidate ${x.c.candidate_sha}: ineligible — failed gates [${x.failed.join(", ")}]`,
				);
			}
		}
		return { ...base, state: "REJECT", reasons, winner_sha: null };
	}

	// (c) unique dominance
	const { dominant } = dominanceRank(eligible);
	if (dominant) {
		reasons.push(
			`unique dominant candidate ${dominant.candidate_sha}: no worse than any other ` +
				`eligible candidate on all dimensions (correctness → regressions → security → ` +
				`blast radius → change surface) and strictly better on at least one`,
		);
		return { ...base, state: "ACCEPT", reasons, winner_sha: dominant.candidate_sha };
	}

	// (d) blind verifier vote, 2-of-3
	const shas = eligible.map((c) => c.candidate_sha);
	const tally = tallyVotes(input.reports, shas, input.labelToSha ?? {});
	let voteWinner: string | null = null;
	for (const sha of shas) {
		const a = tally[sha].accepts;
		if (a >= 2 && shas.every((o) => o === sha || a > tally[o].accepts)) {
			voteWinner = sha;
		}
	}
	if (voteWinner) {
		reasons.push(
			`blind verifier vote: ${voteWinner} received ${tally[voteWinner].accepts} accepts, ` +
				`strictly more than any other eligible candidate`,
		);
		return { ...base, state: "ACCEPT", reasons, winner_sha: voteWinner };
	}

	// (e) conflicting admissible evidence → ESCALATE (promotion BLOCKED)
	const anyMixed = shas.some((s) => tally[s].accepts >= 1 && tally[s].rejects >= 1);
	const shasWithAccepts = shas.filter((s) => tally[s].accepts > 0);
	const totalRejects = shas.reduce((n, s) => n + tally[s].rejects, 0);
	if (anyMixed || (shasWithAccepts.length >= 2 && totalRejects > 0)) {
		for (const s of shas) {
			const t = tally[s];
			if (t.accepts > 0 || t.rejects > 0) {
				reasons.push(
					`conflicting admissible evidence for ${s}: ${t.accepts} accept(s), ` +
						`${t.rejects} reject(s), ${t.abstains} abstain(s)`,
				);
			}
		}
		reasons.push("escalated to operator-of-record; promotion is BLOCKED (NO MERGE)");
		return { ...base, state: "ESCALATE", reasons, winner_sha: null };
	}

	// (f) ABSTAIN — not inventing confidence is a selling point.
	reasons.push(
		`no unique dominant candidate and no verifier majority among ${eligible.length} ` +
			`eligible candidates; evidence insufficient — abstaining rather than coin-flipping`,
	);
	return { ...base, state: "ABSTAIN", reasons, winner_sha: null };
}
