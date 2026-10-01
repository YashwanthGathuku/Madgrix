/**
 * Blind verifier mechanics: commit → evaluate → reveal (spec 1 §8, FROZEN).
 *
 * The empirical mandate (Zhou 2026): a candidate-conditioned judge has
 * false-positive rate 0.719; forcing the judge to commit its own
 * ReferenceReport BEFORE seeing the candidate drops it to 0.012.
 *
 * Invalid commitment or reveal → VERIFIER_REPORT_INADMISSIBLE, and a
 * verifier gets NO retry with a rewritten opinion: one commitment, one
 * reveal, one report. A failed reveal ends that verifier's participation
 * for the candidate. Inadmissibility is encoded as a returned status, not
 * an exception, so callers can record it in the ledger.
 */

import { canonicalJson, joinHashParts } from "./canonical.ts";
import type {
	EvaluationBundle,
	ReferenceReport,
	TaskRecord,
	VerifierVerdict,
} from "./types.ts";

export type Sha256Hex = (input: string | Uint8Array) => Promise<string>;

/**
 * commitment = SHA256(
 *   canonical_json(ReferenceReport)
 *   || nonce || task_hash || verifier_id || policy_version
 * )
 * with "||" encoded as NUL separators (see canonical.ts joinHashParts).
 * The commitment is stored by the task authority BEFORE any candidate is
 * shown to the verifier.
 */
export async function createCommitment(
	report: ReferenceReport,
	nonce: string,
	task_hash: string,
	verifier_id: string,
	policy_version: string,
	sha256Hex: Sha256Hex,
): Promise<string> {
	return sha256Hex(
		joinHashParts(canonicalJson(report), nonce, task_hash, verifier_id, policy_version),
	);
}

/** Recompute and compare — true only for a valid reveal. */
export async function verifyReveal(
	commitment: string,
	report: ReferenceReport,
	nonce: string,
	task_hash: string,
	verifier_id: string,
	policy_version: string,
	sha256Hex: Sha256Hex,
): Promise<boolean> {
	const recomputed = await createCommitment(
		report,
		nonce,
		task_hash,
		verifier_id,
		policy_version,
		sha256Hex,
	);
	return recomputed === commitment;
}

/**
 * A deterministic, aspect-specific verifier (correctness / security /
 * minimality …). Verifiers are independent: they MUST NOT deliberate with
 * each other or with contenders. produceReference runs BEFORE the
 * candidate is shown; judge runs on an ANONYMIZED candidate label
 * (e.g. "candidate-7f31"), never a contender identity.
 */
export interface DeterministicVerifier {
	verifier_id: string;
	/** Aspect this verifier judges: "correctness" | "security" | "minimality" | … */
	aspect: string;
	produceReference(task: TaskRecord): ReferenceReport;
	judge(
		candidateLabel: string,
		bundle: EvaluationBundle,
	): { verdict: VerifierVerdict; reasons: string[] };
}
