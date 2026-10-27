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
export const CONFLICT_CAPSULE_V2_VERSION = "madgrix-conflict-capsule/v2";

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

/* ------------------------------------------------------------------ */
/* Conflict Capsule v2 (specs/amendments/governed-resolution-v1.md).   */
/* ------------------------------------------------------------------ */

export interface ConflictCapsuleV2Hunk {
	index: number;
	base_sha256: string;
	sides: Array<{ agent_id: string; sha256: string }>;
}

export interface ConflictCapsuleV2Conflict {
	path: string;
	classification: "textual-line-overlap";
	/** "hunk": only the hunks are leased; "file": the whole file is leased. */
	lease: "hunk" | "file";
	sides: ConflictCapsuleSide[];
	hunks: ConflictCapsuleV2Hunk[];
}

export interface ConflictCapsuleV2 {
	format: typeof CONFLICT_CAPSULE_V2_VERSION;
	capsule_id: string;
	task_hash: string;
	contender_id: string;
	baseline: string;
	contributing_shas: string[];
	/** The crew's frozen witness manifest; null when the crew declared none. */
	witness_manifest_sha256: string | null;
	conflicts: ConflictCapsuleV2Conflict[];
	resolution_requirements: {
		candidate_sha: null;
		new_candidate_required: true;
		re_evaluation_required: true;
		old_authority_invalid: true;
		writes_limited_to_lease: true;
		witnesses_frozen_before_resolution: true;
	};
}

/**
 * The v2 capsule of a CONFLICTED composition: v1 plus the leased hunks (digests
 * only) and the digest of the witness manifest frozen before any resolver ran.
 * `capsule_id` is SHA-256 over the canonical JSON of everything else, so the
 * same conflict state always yields the same id. The authority computes it
 * when CONFLICTED is recorded, and a RESOLVED record must name it.
 */
export async function buildConflictCapsuleV2(
	taskHash: string,
	composition: CompositionRecord,
	sha256Hex: (input: string | Uint8Array) => Promise<string> = defaultSha256Hex,
): Promise<ConflictCapsuleV2> {
	if (composition.status !== "CONFLICTED") {
		throw new Error("buildConflictCapsuleV2 requires CONFLICTED composition");
	}
	if (composition.candidate_sha !== null) {
		throw new Error("CONFLICTED composition cannot name a candidate SHA");
	}
	const conflicts: ConflictCapsuleV2Conflict[] = [];
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
		const hunks = [...(file.hunks ?? [])]
			.sort((a, b) => a.index - b.index)
			.map((hunk) => ({
				index: hunk.index,
				base_sha256: hunk.base_sha256,
				sides: [...hunk.sides]
					.sort((a, b) => a.agent_id.localeCompare(b.agent_id))
					.map((side) => ({ agent_id: side.agent_id, sha256: side.sha256 })),
			}));
		conflicts.push({
			path: file.path,
			classification: file.classification,
			lease: hunks.length > 0 ? "hunk" : "file",
			sides,
			hunks,
		});
	}
	const body = {
		format: CONFLICT_CAPSULE_V2_VERSION as typeof CONFLICT_CAPSULE_V2_VERSION,
		task_hash: taskHash,
		contender_id: composition.contender_id,
		baseline: composition.baseline,
		contributing_shas: [...composition.contributing_shas].sort(),
		witness_manifest_sha256: composition.witness_manifest_sha256 ?? null,
		conflicts,
		resolution_requirements: {
			candidate_sha: null,
			new_candidate_required: true as const,
			re_evaluation_required: true as const,
			old_authority_invalid: true as const,
			writes_limited_to_lease: true as const,
			witnesses_frozen_before_resolution: true as const,
		},
	};
	const capsule_id = await sha256Hex(canonicalJson(body));
	return { ...body, capsule_id };
}
