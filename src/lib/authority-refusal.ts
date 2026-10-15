/**
 * The one authority refusal for a contender SHA (and, when present, a permit).
 * submitEvaluation, runVerdictSeam, issuePermit, attemptPromotion, and
 * runPromotion all call this. They do not each invent a narrower check.
 *
 * specs/amendments/exact-composition-candidate-v1.md
 * specs/amendments/quarantine-authority-epoch-v1.md
 * specs/amendments/quarantine-decision-v1.md
 * specs/amendments/task-composition-owner-v1.md
 */

import { compositionBlocks } from "./composition-authority.ts";
import type { AuthorityState, QuarantineRecord } from "./types.ts";

export type AuthorityRefusal =
	| "UNRESOLVED_CONFLICT"
	| "QUARANTINED_CANDIDATE"
	| "REVOKED_CANDIDATE"
	| "AUTHORITY_EPOCH";

function epochBlocksPermit(record: QuarantineRecord, permitId: string | undefined): boolean {
	if (!permitId || record.status !== "RELEASED") return false;
	// A RELEASED record without the epoch list cannot prove the permit is fresh.
	if (!Array.isArray(record.voided_permit_ids)) return true;
	return record.voided_permit_ids.includes(permitId);
}

function epochBlocksSha(record: QuarantineRecord, sha: string): boolean {
	if (record.status !== "RELEASED") return false;
	if (!Array.isArray(record.blocked_candidate_shas)) return true;
	return record.blocked_candidate_shas.includes(sha);
}

/**
 * Why this SHA (and permit, if given) must not be selected, permitted, or
 * promoted. Null means this helper does not refuse it.
 *
 * QUARANTINED and REVOKED refuse the contender outright. Any other stored
 * status except exact RELEASED is corrupt and refuses too: it must not fall
 * through to promotion. After RELEASED, a permit that existed at quarantine
 * entry, and any SHA that was a candidate then or that was submitted while
 * quarantined, stays refused. Composition then refuses every SHA except the
 * one promotable candidate of the composition owner.
 */
export function authorityRefusal(
	state: AuthorityState,
	contenderId: string,
	sha: string,
	permitId?: string,
): AuthorityRefusal | null {
	const record = Object.hasOwn(state.quarantine, contenderId) ? state.quarantine[contenderId] : undefined;
	if (record?.status === "QUARANTINED") return "QUARANTINED_CANDIDATE";
	if (record?.status === "REVOKED") return "REVOKED_CANDIDATE";
	// Legacy or corrupt JSON can store a status outside the union. Fail closed.
	if (record && record.status !== "RELEASED") return "QUARANTINED_CANDIDATE";
	if (record && epochBlocksPermit(record, permitId)) return "AUTHORITY_EPOCH";
	if (record && epochBlocksSha(record, sha)) return "AUTHORITY_EPOCH";
	if (compositionBlocks(state, contenderId, sha)) return "UNRESOLVED_CONFLICT";
	return null;
}
