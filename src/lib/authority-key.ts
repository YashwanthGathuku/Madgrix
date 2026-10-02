/**
 * The task authority's attestation signing key
 * (specs/amendments/authority-signing-v1.md).
 *
 * AUTHORITY_SIGNING_KEY is an Ed25519 private key in PKCS8 form, given as
 * PEM ("-----BEGIN PRIVATE KEY-----") or as the bare base64 of the DER. It is
 * a Worker secret and lives in the control plane only (spec 4 §6, spec 3 §2).
 * Signing uses WebCrypto, which both Workers and Node provide, so the
 * TaskAuthority Durable Object and the local slice sign with the same code.
 * Verifiers never trust the public key this signer embeds in a bundle; they
 * compare it against their own pinned copy.
 */

import { sha256Hex } from "./canonical.ts";
import type { Signer } from "./attestation.ts";

/** SPKI DER prefix of an Ed25519 public key (RFC 8410); the 32-byte key follows. */
const ED25519_SPKI_PREFIX_HEX = "302a300506032b6570032100";

export interface AuthoritySigner extends Signer {
	/** SHA-256 (hex) of the SPKI DER public key. */
	keyid: string;
	/** SPKI DER of the public key, hex. */
	publicKeyDerHex: string;
}

function hexToBytes(hex: string): Uint8Array {
	return Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));
}

function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function base64ToBytes(b64: string): Uint8Array {
	return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function bytesToBase64(bytes: Uint8Array): string {
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s);
}

function pkcs8Der(key: string): Uint8Array {
	const body = key.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "");
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body)) throw new Error("AUTHORITY_SIGNING_KEY is not PKCS8 PEM or base64");
	return base64ToBytes(body);
}

/** Build the authority signer from AUTHORITY_SIGNING_KEY. Throws if absent or malformed. */
export async function loadAuthoritySigner(pkcs8: unknown): Promise<AuthoritySigner> {
	if (typeof pkcs8 !== "string" || pkcs8.trim() === "") throw new Error("AUTHORITY_SIGNING_KEY is not set");
	const der = pkcs8Der(pkcs8) as BufferSource;
	let jwk: JsonWebKey;
	let privateKey: CryptoKey;
	try {
		// Extractable once, only to read the public half; signing uses a
		// non-extractable handle.
		const exportable = await crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, true, ["sign"]);
		jwk = await crypto.subtle.exportKey("jwk", exportable);
		privateKey = await crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, false, ["sign"]);
	} catch {
		throw new Error("AUTHORITY_SIGNING_KEY is not an Ed25519 PKCS8 private key");
	}
	if (typeof jwk.x !== "string") throw new Error("AUTHORITY_SIGNING_KEY has no Ed25519 public component");
	const publicKeyDer = hexToBytes(
		ED25519_SPKI_PREFIX_HEX + bytesToHex(base64ToBytes(jwk.x.replace(/-/g, "+").replace(/_/g, "/").padEnd(44, "="))),
	);
	const publicKeyDerHex = bytesToHex(publicKeyDer);
	const keyid = await sha256Hex(publicKeyDer);
	const publicKey = await crypto.subtle.importKey("spki", publicKeyDer as BufferSource, { name: "Ed25519" }, false, ["verify"]);
	return {
		keyid,
		publicKeyDerHex,
		async sign(payload: Uint8Array): Promise<{ signature: string; keyid: string }> {
			const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, payload as BufferSource));
			return { signature: bytesToBase64(signature), keyid };
		},
		async verify(payload: Uint8Array, signature: string, requestedKeyid: string): Promise<boolean> {
			if (requestedKeyid !== keyid) return false;
			try {
				return await crypto.subtle.verify("Ed25519", publicKey, base64ToBytes(signature) as BufferSource, payload as BufferSource);
			} catch {
				return false;
			}
		},
	};
}
