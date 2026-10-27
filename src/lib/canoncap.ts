/**
 * CanonCap — canonicalization capability projection.
 *
 * MADGRIX already enforces exact-state, single-use promotion permits. CanonCap
 * names that authority as a first-class agent-era primitive: the right for one
 * reviewed state to become canonical at one exact destination state.
 *
 * This module deliberately does not weaken or replace PermitRecord. It creates
 * a content-addressed, secret-free descriptor from a permit so tooling, UIs and
 * offline evidence can reason about canonicalization authority without needing
 * the permit's random nonce.
 */

import { canonicalJson, sha256Hex as defaultSha256Hex } from "./canonical.ts";
import type { PermitRecord } from "./types.ts";

export const CANONCAP_VERSION = "madgrix-canoncap/v1";

export interface CanonCapBindings {
	task_hash: string;
	baseline_commit: string;
	candidate_sha: string;
	candidate_tree_sha256: string;
	evaluation_bundle_hash: string;
	selector_policy_hash: string;
	destination_repo: string;
	expected_destination_head: string;
}

export interface CanonCap {
	format: typeof CANONCAP_VERSION;
	/** Content address of all canonicalization bindings below. */
	canoncap_id: string;
	/** Existing protocol permit id. The permit remains the enforcement object. */
	permit_id: string;
	bindings: CanonCapBindings;
	single_use: true;
	issued_at: string;
	status: "ACTIVE" | "CONSUMED";
	consumed_at: string | null;
}

export type CanonCapCheck =
	| { ok: true }
	| {
			ok: false;
			error:
				| "CAPABILITY_CONSUMED"
				| "DESTINATION_HEAD_MOVED"
				| "CANDIDATE_CHANGED"
				| "TREE_CHANGED"
				| "EVIDENCE_CHANGED"
				| "POLICY_CHANGED"
				| "DESTINATION_CHANGED";
	  };

function descriptorBody(permit: PermitRecord) {
	return {
		format: CANONCAP_VERSION as typeof CANONCAP_VERSION,
		permit_id: permit.permit_id,
		bindings: {
			task_hash: permit.task_hash,
			baseline_commit: permit.baseline_commit,
			candidate_sha: permit.winner_candidate_sha,
			candidate_tree_sha256: permit.winning_tree_sha256,
			evaluation_bundle_hash: permit.evaluation_bundle_hash,
			selector_policy_hash: permit.selector_policy_hash,
			destination_repo: permit.destination_repo,
			expected_destination_head: permit.expected_destination_head,
		} satisfies CanonCapBindings,
		single_use: true as const,
	};
}

/**
 * Convert an exact-state permit into the stronger public descriptor judges and
 * agent tooling can reason about. The id explicitly binds candidate SHA and
 * destination repo in addition to the existing permit id.
 */
export async function canonCapFromPermit(
	permit: PermitRecord,
	sha256Hex: (input: string | Uint8Array) => Promise<string> = defaultSha256Hex,
): Promise<CanonCap> {
	const body = descriptorBody(permit);
	const canoncap_id = await sha256Hex(canonicalJson(body));
	return {
		...body,
		canoncap_id,
		issued_at: permit.issued_at,
		status: permit.consumed ? "CONSUMED" : "ACTIVE",
		consumed_at: permit.consumed_at,
	};
}

/**
 * Pure world-state check for the public capability descriptor. This mirrors
 * the exact-state idea without replacing the authority's beginPromotion check.
 */
export function checkCanonCap(
	cap: CanonCap,
	world: {
		destination_repo: string;
		destination_head: string;
		candidate_sha: string;
		tree_sha256: string;
		evaluation_bundle_hash: string;
		selector_policy_hash: string;
	},
): CanonCapCheck {
	if (cap.status === "CONSUMED") return { ok: false, error: "CAPABILITY_CONSUMED" };
	if (world.destination_repo !== cap.bindings.destination_repo) return { ok: false, error: "DESTINATION_CHANGED" };
	if (world.destination_head !== cap.bindings.expected_destination_head) return { ok: false, error: "DESTINATION_HEAD_MOVED" };
	if (world.candidate_sha !== cap.bindings.candidate_sha) return { ok: false, error: "CANDIDATE_CHANGED" };
	if (world.tree_sha256 !== cap.bindings.candidate_tree_sha256) return { ok: false, error: "TREE_CHANGED" };
	if (world.evaluation_bundle_hash !== cap.bindings.evaluation_bundle_hash) return { ok: false, error: "EVIDENCE_CHANGED" };
	if (world.selector_policy_hash !== cap.bindings.selector_policy_hash) return { ok: false, error: "POLICY_CHANGED" };
	return { ok: true };
}
