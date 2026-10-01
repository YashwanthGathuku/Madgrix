/// <reference types="node" />
/**
 * LOCAL SLICE SIGNER — Ed25519 over node:crypto, keypair held in memory.
 *
 * Production uses Sigstore/DSSE per spec 4 §6 (offline-verifiable
 * bundles, key transparency); the envelope shape is IDENTICAL, only the
 * key backend differs. The signing key lives in the control plane only
 * (SLSA trust boundary, spec 3 §2) — contender sandboxes, evaluators,
 * reviewers, and the verdict plane MUST NOT have access to it.
 */

import {
	createHash,
	generateKeyPairSync,
	sign as cryptoSign,
	verify as cryptoVerify,
} from "node:crypto";
import type { Signer } from "./attestation.ts";

export interface LocalEd25519Signer extends Signer {
	/** SHA-256 over the SPKI DER of the public key. */
	keyid: string;
	/** SPKI DER of the public key, hex-encoded (for bundle embedding). */
	publicKeyDerHex: string;
}

export function createEd25519Signer(): LocalEd25519Signer {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	const publicKeyDerHex = publicKey.export({ type: "spki", format: "der" }).toString("hex");
	const keyid = createHash("sha256").update(Buffer.from(publicKeyDerHex, "hex")).digest("hex");
	return {
		keyid,
		publicKeyDerHex,
		async sign(payload: Uint8Array): Promise<{ signature: string; keyid: string }> {
			const sig = cryptoSign(null, payload, privateKey);
			return { signature: sig.toString("base64"), keyid };
		},
		async verify(payload: Uint8Array, signature: string, keyid: string): Promise<boolean> {
			if (keyid !== keyid) return false;
			try {
				return cryptoVerify(null, payload, publicKey, Buffer.from(signature, "base64"));
			} catch {
				return false;
			}
		},
	};
}
