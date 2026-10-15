/**
 * Conflict Capsule — a content-addressed conflict object for agent workflows.
 *
 * Textual conflict markers are a human terminal convention and dangerous
 * machine state: an agent can accidentally commit them. MADGRIX instead turns
 * a CONFLICTED composition into an immutable object that records the competing
 * states and explicitly requires a new resolved SHA + re-evaluation.
 */

import { canonicalJson, sha256Hex as defaultSha256Hex } from "./canonical.ts";
import type { CompositionRecord } from "./types.ts";

export const CONFLICT_CAPSULE_VERSION = "madgrix-conflict-capsule/v1";

export interface ConflictCapsuleSide {
	agent_id: string;
	role: string;
	intent: string;
	sha: string;
	/** Digest of the authority-stored excerpt; raw source is not exported. */
	excerpt_sha256: string;
}

export interface ConflictCapsuleConflict {
	path: string;
	classification: "textual-line-overlap";
	sides: ConflictCapsuleSide[];
}

export interface ConflictCapsule {
	format: typeof CONFLICT_CAPSULE_VERSION;
	capsule_id: string;
	task_hash: string;
	contender_id: string;
	baseline: string;
	contributing_shas: string[];
	conflicts: ConflictCapsuleConflict[];
	resolution_requirements: {
		candidate_sha: null;
		new_candidate_required: true;
		re_evaluation_required: true;
		old_authority_invalid: true;
	};
}

export async function buildConflictCapsule(
	taskHash: string,
	composition: CompositionRecord,
	sha256Hex: (input: string | Uint8Array) => Promise<string> = defaultSha256Hex,
): Promise<ConflictCapsule> {
	if (composition.status !== "CONFLICTED") {
		throw new Error("buildConflictCapsule requires CONFLICTED composition");
	}
	if (composition.candidate_sha !== null) {
		throw new Error("CONFLICTED composition cannot name a candidate SHA");
	}

	const conflicts: ConflictCapsuleConflict[] = [];
	for (const file of [...composition.files].sort((a, b) => a.path.localeCompare(b.path))) {
		const sides: ConflictCapsuleSide[] = [];
		for (const side of [...file.sides].sort((a, b) => `${a.agent_id}\0${a.sha}`.localeCompare(`${b.agent_id}\0${b.sha}`))) {
			sides.push({
				agent_id: side.agent_id,
				role: side.role,
				intent: side.intent,
				sha: side.sha,
				excerpt_sha256: await sha256Hex(side.excerpt),
			});
		}
		conflicts.push({ path: file.path, classification: file.classification, sides });
	}

	const body = {
		format: CONFLICT_CAPSULE_VERSION as typeof CONFLICT_CAPSULE_VERSION,
		task_hash: taskHash,
		contender_id: composition.contender_id,
		baseline: composition.baseline,
		contributing_shas: [...composition.contributing_shas].sort(),
		conflicts,
		resolution_requirements: {
			candidate_sha: null,
			new_candidate_required: true as const,
			re_evaluation_required: true as const,
			old_authority_invalid: true as const,
		},
	};
	const capsule_id = await sha256Hex(canonicalJson(body));
	return { ...body, capsule_id };
}
