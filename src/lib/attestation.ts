/**
 * The promotion attestation — the intent ledger's ship record.
 *
 * Instead of inventing provenance primitives, this binds the established
 * shape (SLSA/in-toto style: exact subjects, builder identity, inputs) to
 * one new idea: exact-state authorization for autonomous promotion.
 *
 *   PromotionAuthority = Sign(task_hash + exact_candidate_commit
 *                             + evaluation_bundle_hash + destination_state)
 *
 * Any change invalidates the authorization: the code that passed review
 * must be *exactly* the code that ships.
 */

import { sha256Hex } from "./idempotency.ts";

export interface PromotionAttestation {
	task_hash: string;
	baseline_commit: string;

	candidate_commit: string;
	candidate_repo: string;

	agent_identity: string;
	model?: string;
	harness_version: string;

	tool_receipts_hash: string;
	evaluation_bundle_hash: string;
	hidden_test_result_hash?: string;
	reviewer_verdict_hashes: string[];

	policy_version: string;
	selector_version: string;

	winner_commit: string;
	destination_repo: string;
	destination_parent_commit: string;
	final_tree_hash: string;

	timestamp: string;
	/** v1: HMAC-SHA256 over the canonical body with the promotion secret.
	 *  Production: Ed25519 via a KMS-held key; the verification procedure
	 *  (canonical JSON → hash → verify) is unchanged. */
	signature: string;
}

export type AttestationInput = Omit<PromotionAttestation, "timestamp" | "signature">;

function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, v]) => v !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** Hash of the canonical attestation body — commits to every field. */
export function attestationHash(input: AttestationInput): Promise<string> {
	return sha256Hex(canonicalJson(input));
}

async function hmacSign(secret: string, message: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
	return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function signAttestation(
	input: AttestationInput,
	promotionSecret: string,
): Promise<PromotionAttestation> {
	const bodyHash = await attestationHash(input);
	const timestamp = new Date().toISOString();
	const signature = await hmacSign(promotionSecret, `${bodyHash}|${timestamp}`);
	return { ...input, timestamp, signature };
}

/**
 * Verify an attestation offline: recompute the body hash, recompute the
 * signature, and confirm the winner commit equals the evaluated candidate.
 * Returns the failure reason, or null when the attestation is valid.
 */
export async function verifyAttestation(
	att: PromotionAttestation,
	promotionSecret: string,
): Promise<string | null> {
	const { timestamp, signature, ...input } = att;
	const bodyHash = await attestationHash(input as AttestationInput);
	const expected = await hmacSign(promotionSecret, `${bodyHash}|${timestamp}`);
	if (expected !== signature) return "signature mismatch: attestation was altered or mis-signed";
	if (att.winner_commit !== att.candidate_commit) {
		return "exact-state violation: shipped commit differs from the reviewed candidate";
	}
	return null;
}
