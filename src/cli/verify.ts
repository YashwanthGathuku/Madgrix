/**
 * Offline promotion-bundle verifier: `node src/cli/verify.ts <bundle-path>`.
 * (Internal codename: seam — NOT a public brand.)
 *
 * Builds a VERIFY-ONLY Ed25519 signer from the bundle's own
 * `authority_pubkey_der_hex` (SPKI DER, hex) via node:crypto — no signing
 * capability, no network, no key-distribution side channel. Calls
 * verifyBundle (spec 4 §7) and prints the transcript lines in order.
 *
 * Exit 0 + VERIFIED on success; any failure prints FAIL on that line,
 * NOT VERIFIED overall, exit 1.
 */

import { readFile } from "node:fs/promises";
import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { sha256Hex } from "../lib/canonical.ts";
import { verifyBundle, type PromotionBundle, type Signer } from "../lib/attestation.ts";
import { SELECTOR_POLICY_INPUT } from "../do/TaskAuthority.ts";

/** A signer that can only verify — sign() always throws. Exported for
 *  test/slice.test.ts so the integration test can independently verify
 *  the bundle the slice wrote. */
export function buildVerifyOnlySigner(authorityPubkeyDerHex: string): Signer {
	let publicKey;
	try {
		publicKey = createPublicKey({
			key: Buffer.from(authorityPubkeyDerHex, "hex"),
			format: "der",
			type: "spki",
		});
	} catch {
		throw new Error("authority_pubkey_der_hex is not a valid SPKI DER public key");
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

/** The eight spec 4 §7 transcript lines, in order. */
const TRANSCRIPT_LABELS = [
	"subject digest",
	"candidate digest",
	"chain integrity",
	"hidden evaluation",
	"policy digest",
	"destination parent",
	"signature",
	"promotion authority",
] as const;

async function main(): Promise<number> {
	const bundlePath = process.argv[2];
	if (!bundlePath) {
		console.error("usage: node src/cli/verify.ts <bundle-path>");
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
	if (typeof bundle.authority_pubkey_der_hex !== "string" || bundle.authority_pubkey_der_hex === "") {
		console.error("bundle missing authority_pubkey_der_hex — cannot build a verifier");
		return 1;
	}
	const signer = buildVerifyOnlySigner(bundle.authority_pubkey_der_hex);
	// The frozen selector-policy identity (same input the authority hashed).
	const policyHash = await sha256Hex(SELECTOR_POLICY_INPUT);
	const { lines, verified } = await verifyBundle(bundle, signer, { policyHash });

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
