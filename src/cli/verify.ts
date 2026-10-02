/**
 * Offline promotion-bundle verifier:
 *   `node src/cli/verify.ts [--trust-key <public-key-file>] <bundle-path>`
 * (Internal codename: seam — NOT a public brand.)
 *
 * Trust comes from a pinned authority key, never from the bundle
 * (amendment authority-signing-v1): `--trust-key <file>`, else
 * keys/authority.pub in this repository (keys/README.md). The file holds an
 * Ed25519 public key as PEM or as hex SPKI DER. The bundle's embedded key
 * must equal the pinned key, and every signature is checked with the pinned
 * key through a VERIFY-ONLY signer — no signing capability, no network.
 * Calls verifyBundle and prints the transcript lines in order.
 *
 * Exit 0 + VERIFIED on success; any failure prints FAIL on that line,
 * NOT VERIFIED overall, exit 1. No readable trusted key or bundle: exit 2.
 */

import { readFile } from "node:fs/promises";
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sha256Hex } from "../lib/canonical.ts";
import { verifyBundle, type PromotionBundle, type Signer, type VerifyLine } from "../lib/attestation.ts";
import { SELECTOR_POLICY_INPUT } from "../do/TaskAuthority.ts";

const USAGE = "usage: node src/cli/verify.ts [--trust-key <public-key-file>] <bundle-path>";

/** The repository's pinned authority key, used when --trust-key is not given. */
export const DEFAULT_TRUST_KEY_PATH = fileURLToPath(new URL("../../keys/authority.pub", import.meta.url));

/** A signer that can only verify — sign() always throws. */
export function buildVerifyOnlySigner(authorityPubkeyDerHex: string): Signer {
	let publicKey;
	try {
		publicKey = createPublicKey({
			key: Buffer.from(authorityPubkeyDerHex, "hex"),
			format: "der",
			type: "spki",
		});
	} catch {
		throw new Error("authority key is not a valid SPKI DER public key");
	}
	return {
		async sign(): Promise<{ signature: string; keyid: string }> {
			throw new Error("verify-only signer cannot sign");
		},
		async verify(payload: Uint8Array, signature: string, _keyid: string): Promise<boolean> {
			try {
				return cryptoVerify(null, payload, publicKey, Buffer.from(signature, "base64"));
			} catch {
				return false;
			}
		},
	};
}

/** SPKI DER (hex) of an Ed25519 public key given as PEM or hex SPKI DER. */
export function parseTrustedKey(text: string): string {
	const trimmed = text.trim();
	if (trimmed.includes("PRIVATE KEY")) {
		throw new Error("holds a private key; pin the public key instead (keys/README.md)");
	}
	let key;
	try {
		key = trimmed.includes("-----BEGIN")
			? createPublicKey(trimmed)
			: createPublicKey({ key: Buffer.from(trimmed, "hex"), format: "der", type: "spki" });
	} catch {
		throw new Error("is not a PEM or hex SPKI public key");
	}
	if (key.asymmetricKeyType !== "ed25519") throw new Error(`is a ${key.asymmetricKeyType} key, not Ed25519`);
	return key.export({ type: "spki", format: "der" }).toString("hex");
}

/**
 * Verify a bundle against the pinned authority key (SPKI DER, hex). The
 * bundle's own `authority_pubkey_der_hex` is never trusted: it must equal
 * the pinned key, and every signature is verified with the pinned key.
 */
export async function verifyWithTrustedKey(
	bundle: PromotionBundle,
	trustedKeyDerHex: string,
): Promise<{ lines: VerifyLine[]; verified: boolean }> {
	const signer = buildVerifyOnlySigner(trustedKeyDerHex);
	// The frozen selector-policy identity (same input the authority hashed).
	const policyHash = await sha256Hex(SELECTOR_POLICY_INPUT);
	return verifyBundle(bundle, signer, { policyHash, trustedKeyDerHex });
}

/** The transcript lines, in order (spec 4 §7 as amended by authority-signing-v1). */
const TRANSCRIPT_LABELS = [
	"subject digest",
	"candidate digest",
	"chain integrity",
	"hidden evaluation",
	"policy digest",
	"destination parent",
	"authority key",
	"signature",
	"permit id",
	"ledger chain",
] as const;

async function main(): Promise<number> {
	let bundlePath: string | undefined;
	let trustKeyPath: string | undefined;
	const args = process.argv.slice(2);
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--trust-key") {
			trustKeyPath = args[++i];
			if (trustKeyPath === undefined) {
				console.error(USAGE);
				return 2;
			}
		} else if (bundlePath === undefined) {
			bundlePath = args[i];
		} else {
			console.error(USAGE);
			return 2;
		}
	}
	if (!bundlePath) {
		console.error(USAGE);
		return 2;
	}

	const keyPath = trustKeyPath ?? DEFAULT_TRUST_KEY_PATH;
	let keyText: string;
	try {
		keyText = await readFile(keyPath, "utf8");
	} catch {
		console.error(
			trustKeyPath === undefined
				? "no trusted key: pass --trust-key <file> or add keys/authority.pub (see keys/README.md)"
				: `cannot read trusted key: ${keyPath}`,
		);
		return 2;
	}
	let trustedKeyDerHex: string;
	try {
		trustedKeyDerHex = parseTrustedKey(keyText);
	} catch (err) {
		console.error(`trusted key ${keyPath} ${(err as Error).message}`);
		return 2;
	}

	let raw: string;
	try {
		raw = await readFile(bundlePath, "utf8");
	} catch {
		console.error(`cannot read bundle: ${bundlePath}`);
		return 2;
	}
	let bundle: PromotionBundle;
	try {
		bundle = JSON.parse(raw) as PromotionBundle;
	} catch {
		console.error(`not valid JSON: ${bundlePath}`);
		return 2;
	}

	const { lines, verified } = await verifyWithTrustedKey(bundle, trustedKeyDerHex);
	const byLabel = new Map(lines.map((l) => [l.label, l.status]));
	for (const label of TRANSCRIPT_LABELS) {
		const status = byLabel.get(label) ?? "FAIL";
		console.log(`${label.padEnd(22, ".")} ${status}`);
	}
	console.log("");
	if (verified) {
		console.log("VERIFIED");
		return 0;
	}
	console.log("NOT VERIFIED");
	return 1;
}

function isMainModule(): boolean {
	const arg = process.argv[1];
	if (!arg) return false;
	try {
		return pathToFileURL(path.resolve(arg)).href === import.meta.url;
	} catch {
		return false;
	}
}

if (isMainModule()) {
	main()
		.then((code) => process.exit(code))
		.catch((e) => {
			console.error(`verify error: ${(e as Error).message}`);
			process.exit(1);
		});
}
