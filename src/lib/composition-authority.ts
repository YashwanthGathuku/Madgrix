/**
 * The one composition rule for evaluation, verdict, permit, and promotion
 * (specs/amendments/composition-result-v1.md,
 * specs/amendments/exact-composition-candidate-v1.md).
 *
 * A task has one composition record (specs/amendments/task-composition-owner-v1.md).
 * Once it exists, only composition.contender_id is promotable. That owner has
 * at most one promotable SHA: composition.candidate_sha, and only while the
 * status is COMPOSED or RESOLVED, and only when that SHA is not a crew
 * contribution. Every other SHA, and every other contender, is refused.
 */

import type { AuthorityState, CompositionRecord } from "./types.ts";

function addSha(into: Set<string>, sha: unknown): void {
	if (typeof sha === "string" && sha.length > 0) into.add(sha);
}

/**
 * Every crew contribution SHA: contributing_shas, each agent sha, and each
 * conflict-side sha. Omission from contributing_shas does not drop an agent
 * or side SHA.
 */
export function compositionMemberShas(composition: {
	contributing_shas?: unknown;
	agents?: unknown;
	files?: unknown;
}): string[] {
	const shas = new Set<string>();
	if (Array.isArray(composition.contributing_shas)) {
		for (const sha of composition.contributing_shas) addSha(shas, sha);
	}
	if (Array.isArray(composition.agents)) {
		for (const agent of composition.agents) {
			if (agent && typeof agent === "object") addSha(shas, (agent as { sha?: unknown }).sha);
		}
	}
	if (Array.isArray(composition.files)) {
		for (const file of composition.files) {
			if (!file || typeof file !== "object") continue;
			const sides = (file as { sides?: unknown }).sides;
			if (!Array.isArray(sides)) continue;
			for (const side of sides) {
				if (side && typeof side === "object") addSha(shas, (side as { sha?: unknown }).sha);
			}
		}
	}
	return [...shas];
}

/** The one SHA promotion may use, or null when this record names none. */
export function promotableCompositionSha(composition: CompositionRecord | null | undefined): string | null {
	if (!composition) return null;
	if (composition.status !== "COMPOSED" && composition.status !== "RESOLVED") return null;
	const sha = composition.candidate_sha;
	if (typeof sha !== "string" || sha.length === 0) return null;
	if (compositionMemberShas(composition).includes(sha)) return null;
	return sha;
}

/**
 * True when this task's composition record forbids `sha` for this contender.
 * No composition record → false. A record owned by someone else forbids every
 * SHA, including the owner's candidate. The owner's promotable record forbids
 * every SHA except that exact candidate. Every other owner status forbids
 * every SHA.
 */
export function compositionBlocks(state: AuthorityState, contenderId: string, sha?: string): boolean {
	const composition = state.composition;
	if (!composition) return false;
	if (composition.contender_id !== contenderId) return true;
	const promotable = promotableCompositionSha(composition);
	if (promotable === null) return true;
	return sha !== promotable;
}

/** The submitEvaluation error for a blocked SHA, or null when it is allowed. */
export function compositionEvidenceError(state: AuthorityState, contenderId: string, sha: string): string | null {
	if (!compositionBlocks(state, contenderId, sha)) return null;
	const composition = state.composition;
	if (!composition || composition.contender_id !== contenderId) {
		return (
			`evaluation rejected: contender ${contenderId} is not the composition owner ` +
			`${composition?.contender_id ?? "unknown"}`
		);
	}
	const promotable = promotableCompositionSha(composition);
	if (promotable === null) {
		const status = composition?.status;
		if (status === "COMPOSED" || status === "RESOLVED") {
			return (
				`evaluation rejected: contender ${contenderId} has no promotable candidate ` +
				`(${sha} is not a new composition SHA)`
			);
		}
		return (
			`evaluation rejected: contender ${contenderId} is ${status ?? "CONFLICTED"} — ` +
			"an unresolved composition is not a candidate"
		);
	}
	if (composition && compositionMemberShas(composition).includes(sha)) {
		return (
			`evaluation rejected: ${sha} is a contributing SHA, not the composition candidate ${promotable}`
		);
	}
	return `evaluation rejected: ${sha} is not the composition candidate ${promotable}`;
}
