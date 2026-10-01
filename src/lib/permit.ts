/**
 * Exact-state, single-use, destination-bound promotion permits
 * (spec 1 §§10–11).
 *
 * The permit authorizes ONE exact tree, evaluated under ONE exact
 * evidence and policy, to be promoted onto ONE exact destination state —
 * once. It is deliberately NOT a generic "candidate approved" flag.
 *
 * Pure logic — no I/O, no network. Hashing/randomness are injected via
 * the `deps` parameter so the slice stays deterministic in tests and
 * the Durable Object wrapper can supply the platform bindings.
 */

import { joinHashParts } from "./canonical.ts";
import type { PermitRecord } from "./types.ts";

export type Sha256Hex = (input: string | Uint8Array) => Promise<string>;

export interface PermitIdParts {
	task_hash: string;
	baseline_commit: string;
	winning_tree_sha256: string;
	evaluation_bundle_hash: string;
	selector_policy_hash: string;
	expected_destination_head: string;
}

/**
 * permit_id = SHA256(
 *   task_hash || baseline_commit || winning_tree_sha256 ||
 *   evaluation_bundle_hash || selector_policy_hash ||
 *   expected_destination_head
 * )
 * with "||" encoded as NUL separators (see canonical.ts joinHashParts).
 */
export async function buildPermitId(
	p: PermitIdParts,
	sha256Hex: Sha256Hex,
): Promise<string> {
	return sha256Hex(
		joinHashParts(
			p.task_hash,
			p.baseline_commit,
			p.winning_tree_sha256,
			p.evaluation_bundle_hash,
			p.selector_policy_hash,
			p.expected_destination_head,
		),
	);
}

export interface PermitDeps {
	now(): string;
	randomHex(n: number): string;
	sha256Hex: Sha256Hex;
}

export interface CreatePermitInput extends PermitIdParts {
	winner_candidate_sha: string;
	contender_id: string;
	destination_repo: string;
}

/** Issue exactly one permit for an ACCEPT verdict. single_use is always
 *  true; there is no multi-use promotion authority (spec 4 §4). */
export async function createPermit(
	input: CreatePermitInput,
	deps: PermitDeps,
): Promise<PermitRecord> {
	const permit_id = await buildPermitId(input, deps.sha256Hex);
	return {
		permit_id,
		task_hash: input.task_hash,
		baseline_commit: input.baseline_commit,
		winner_candidate_sha: input.winner_candidate_sha,
		contender_id: input.contender_id,
		winning_tree_sha256: input.winning_tree_sha256,
		evaluation_bundle_hash: input.evaluation_bundle_hash,
		selector_policy_hash: input.selector_policy_hash,
		destination_repo: input.destination_repo,
		expected_destination_head: input.expected_destination_head,
		nonce: deps.randomHex(32),
		issued_at: deps.now(),
		consumed: false,
		consumed_at: null,
	};
}

export type PromotionCheck =
	| { ok: true }
	| {
			ok: false;
			error: "ALREADY_CONSUMED" | "EXPIRED_HEAD_MOVED" | "TREE_MISMATCH" | "QUARANTINED_CANDIDATE";
	  };

/**
 * Verify the permit against the CURRENT world state, in the spec 1 §11
 * order. NEVER consumes the permit on failure — consumption is the task
 * authority's job (task-state.ts), and only on success.
 */
export function checkPromotion(
	permit: PermitRecord,
	current_head: string,
	tree_sha256: string,
	winnerQuarantined: boolean,
): PromotionCheck {
	if (permit.consumed) return { ok: false, error: "ALREADY_CONSUMED" };
	if (permit.expected_destination_head !== current_head)
		return { ok: false, error: "EXPIRED_HEAD_MOVED" };
	if (permit.winning_tree_sha256 !== tree_sha256)
		return { ok: false, error: "TREE_MISMATCH" };
	if (winnerQuarantined) return { ok: false, error: "QUARANTINED_CANDIDATE" };
	return { ok: true };
}
