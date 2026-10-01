/**
 * Verifier + operator public-key registry primitives (spec 1 §8, spec 3 §7).
 *
 * The task authority holds REGISTERED public keys — verifier keys bound to
 * verifier_id at task freeze, operator keys for the operator-of-record —
 * and verifies Ed25519 signatures against them. This is what makes a
 * verifier report unforgeable: without the registered private key, an
 * attacker can commit, reveal, and submit all day, but the report is
 * rejected at submission.
 *
 * Portability: implemented over WebCrypto (`crypto.subtle`), the same
 * primitive canonical.ts uses — it works identically in Workers and in
 * Node. (The slice's *signing* side uses node:crypto in signer-node.ts;
 * verification here never needs the private key.)
 *
 * keyid convention: SHA-256 hex over the SPKI DER of the public key —
 * the same convention as the slice signer (signer-node.ts), so a keyid
 * always identifies key material, never a bare label.
 */

import { canonicalJson } from "./canonical.ts";
import type { QuarantineTrigger } from "./types.ts";

export type Sha256Hex = (input: string | Uint8Array) => Promise<string>;

/** A verifier's registered public key, bound to its verifier_id. */
export interface VerifierPublicKey {
	verifier_id: string;
	/** SHA-256 hex over the SPKI DER — always derived from the key material. */
	keyid: string;
	/** SPKI DER of the Ed25519 public key, hex-encoded. */
	public_key_der_hex: string;
}

function derBytes(spkiDerHex: string): Uint8Array {
	if (!/^[0-9a-fA-F]+$/.test(spkiDerHex) || spkiDerHex.length % 2 !== 0) {
		throw new Error("verifier-keys: public_key_der_hex is not valid hex");
	}
	const bytes = new Uint8Array(spkiDerHex.length / 2);
	for (let i = 0; i < bytes.length; i++) {
		bytes[i] = parseInt(spkiDerHex.slice(i * 2, i * 2 + 2), 16);
	}
	return bytes;
}

/** Import an Ed25519 SPKI public key. Throws on malformed input (fail closed). */
export async function importEd25519PublicKey(spkiDerHex: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"spki",
		derBytes(spkiDerHex) as BufferSource,
		{ name: "Ed25519" },
		false,
		["verify"],
	);
}

/** keyid = SHA-256 hex over the SPKI DER bytes. */
export async function keyidForPublicKey(
	spkiDerHex: string,
	sha256Hex: Sha256Hex,
): Promise<string> {
	// Validates the hex encoding; key import happens at registration.
	return sha256Hex(derBytes(spkiDerHex));
}

function base64ToBytes(s: string): Uint8Array {
	// base64 (not base64url): matches the DSSE signature encoding used by
	// the slice signer (commit ece1601).
	const bin = atob(s);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return bytes;
}

/**
 * Verify a base64 Ed25519 signature over `payload` with the given SPKI DER
 * public key. Returns false (never throws) on any verification failure —
 * malformed signature, wrong key, tampered payload.
 */
export async function verifyEd25519Signature(
	publicKeyDerHex: string,
	payload: Uint8Array,
	signatureBase64: string,
): Promise<boolean> {
	try {
		const key = await importEd25519PublicKey(publicKeyDerHex);
		const sig = base64ToBytes(signatureBase64);
		return await crypto.subtle.verify(
			{ name: "Ed25519" },
			key,
			sig as BufferSource,
			payload as BufferSource,
		);
	} catch {
		return false;
	}
}

/**
 * The exact bytes a verifier signs: canonical_json(report minus
 * signature), per the VerdictReport contract ("Base64 signature over
 * canonical_json(report minus signature)"). The authority recomputes this
 * from the SUBMITTED report fields — a tampered payload fails verification.
 */
export function verifierReportPayload(report: {
	verifier_id: string;
	candidate_label: string;
	verdict: string;
	reasons: string[];
	keyid: string;
}): string {
	return canonicalJson({
		verifier_id: report.verifier_id,
		candidate_label: report.candidate_label,
		verdict: report.verdict,
		reasons: report.reasons,
		keyid: report.keyid,
	});
}

/**
 * The exact bytes the operator-of-record signs for a quarantine
 * determination: canonical_json({contender_id, trigger, decision, note}).
 * The signature binds the determination to the sanctioned contender, the
 * mechanical trigger that fired, the decision, and the operator's note —
 * none of them can be swapped after signing.
 */
export function quarantineDeterminationPayload(input: {
	contender_id: string;
	trigger: QuarantineTrigger;
	decision: "RELEASED" | "REVOKED";
	note: string;
}): string {
	return canonicalJson({
		contender_id: input.contender_id,
		trigger: input.trigger,
		decision: input.decision,
		note: input.note,
	});
}
