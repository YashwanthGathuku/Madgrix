/**
 * Forged promotion bundles (spec 4 §6–§7; specs/amendments/authority-signing-v1.md).
 *
 * Before authority-signing-v1, src/cli/verify.ts checked every signature
 * against `bundle.authority_pubkey_der_hex`, the key inside the bundle
 * itself. Anyone could build the four statements for a commit that never
 * existed, sign them with a fresh key, embed that key and get VERIFIED,
 * including "promotion authority... CONSUMED ONCE", which no offline check
 * can establish.
 *
 * These tests run the real verify CLI against forged bundles and a genuine
 * slice bundle, with the verifier pinned to a trusted authority key.
 *
 * node --test test/forged-bundle.test.ts
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
	buildLinkStatement,
	buildPromotionAuthority,
	buildTestResultStatement,
	buildVerificationResultStatement,
	signEnvelope,
} from "../src/lib/attestation.ts";
import { canonicalJson, sha256Hex } from "../src/lib/canonical.ts";
import { buildPermitId } from "../src/lib/permit.ts";
import { createEd25519Signer } from "../src/lib/signer-node.ts";
import { SELECTOR_POLICY_INPUT } from "../src/do/TaskAuthority.ts";
import { runSlice } from "../src/harness/slice.ts";
// Namespace import: verifyWithTrustedKey is introduced by the fix, and a
// named import of a missing export would stop this file from loading at all.
import * as verifyModule from "../src/cli/verify.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VERIFY_CLI = path.join(REPO_ROOT, "src/cli/verify.ts");
const GENESIS_PREV_HASH = "0".repeat(64);

interface CliRun {
	code: number | null;
	stdout: string;
	stderr: string;
	/** transcript label → status, e.g. "signature" → "VALID". */
	lines: Map<string, string>;
}

/** `node src/cli/verify.ts <bundle> [args...]` (bundle first, as the pre-fix CLI expects). */
function verifyCli(bundlePath: string, ...args: string[]): Promise<CliRun> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [VERIFY_CLI, bundlePath, ...args], {
			cwd: REPO_ROOT,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (b) => (stdout += b));
		child.stderr.on("data", (b) => (stderr += b));
		child.on("error", reject);
		child.on("close", (code) => {
			const lines = new Map<string, string>();
			for (const line of stdout.split("\n")) {
				const m = /^([a-z ]+?)\.+ (\S.*)$/.exec(line);
				if (m) lines.set(m[1], m[2]);
			}
			resolve({ code, stdout, stderr, lines });
		});
	});
}

const tmp = {} as { dir: string; pinnedKeyPath: string };

async function writeJson(name: string, value: unknown): Promise<string> {
	const file = path.join(tmp.dir, name);
	await writeFile(file, JSON.stringify(value, null, 2));
	return file;
}

/** ledger entry hash per authority-signing-v1: SHA-256 over canonical JSON of the entry minus entry_hash. */
async function entryHash(e: { seq: number; ts: string; kind: string; payload_hash: string; prev_hash: string }) {
	return sha256Hex(canonicalJson({ seq: e.seq, ts: e.ts, kind: e.kind, payload_hash: e.payload_hash, prev_hash: e.prev_hash }));
}

/** Re-link entries[from..] and return the new head: a tamper that keeps the chain self-consistent. */
async function rechain(entries: any[], from: number): Promise<string> {
	for (let i = from; i < entries.length; i++) {
		entries[i].prev_hash = i === 0 ? GENESIS_PREV_HASH : entries[i - 1].entry_hash;
		entries[i].entry_hash = await entryHash(entries[i]);
	}
	return entries[entries.length - 1].entry_hash;
}

/**
 * A bundle for values that exist nowhere, signed by a key the forger just
 * generated. Its permit id recomputes from its own bound fields and, with
 * `withLedger`, it carries a self-consistent hash-chained ledger, so the
 * only thing wrong with it is who signed it.
 */
async function forgeBundle(opts: { withLedger: boolean }) {
	const forger = createEd25519Signer();
	const policy = await sha256Hex(SELECTOR_POLICY_INPUT);
	const fabricated = {
		task_hash: await sha256Hex("a task that was never frozen"),
		baseline_commit: "1111111111111111111111111111111111111111",
		candidate_commit: "0123456789abcdef0123456789abcdef01234567",
		tree_sha256: await sha256Hex("a tree nobody evaluated"),
		evaluation_bundle_hash: await sha256Hex("an evaluation that never ran"),
		base: "2222222222222222222222222222222222222222",
		nonce: "9".repeat(64),
	};
	const permit_id = await buildPermitId(
		{
			task_hash: fabricated.task_hash,
			baseline_commit: fabricated.baseline_commit,
			winning_tree_sha256: fabricated.tree_sha256,
			evaluation_bundle_hash: fabricated.evaluation_bundle_hash,
			selector_policy_hash: policy,
			expected_destination_head: fabricated.base,
		},
		sha256Hex,
	);
	const authority = await buildPromotionAuthority({
		taskHash: fabricated.task_hash,
		baselineCommit: fabricated.baseline_commit,
		candidateRepo: "fork-that-does-not-exist",
		candidateCommit: fabricated.candidate_commit,
		treeSha256: fabricated.tree_sha256,
		evaluationBundleHash: fabricated.evaluation_bundle_hash,
		verificationResult: "PASSED",
		policySha256: policy,
		destinationRepo: "acme/canonical",
		destinationBase: fabricated.base,
		nonce: fabricated.nonce,
		permitId: permit_id,
		issuedAt: "2026-10-02T12:00:00.000Z",
	});
	let ledger: { head_sha256: string; entries: any[] } | undefined;
	if (opts.withLedger) {
		const entries: any[] = [
			{ seq: 0, ts: "2026-10-02T11:00:00.000Z", kind: "authority_created", payload_hash: "" },
			{
				seq: 1,
				ts: "2026-10-02T12:00:01.000Z",
				kind: "promotion_succeeded",
				payload_hash: await sha256Hex(canonicalJson({ permit_id, tree_sha256: fabricated.tree_sha256 })),
			},
		];
		const head = await rechain(entries, 0);
		(authority.predicate as Record<string, unknown>).ledger = { head_sha256: head };
		ledger = { head_sha256: head, entries };
	}
	const statements = [];
	for (const statement of [
		await buildLinkStatement({
			baselineCommit: fabricated.baseline_commit,
			candidateCommit: fabricated.candidate_commit,
			treeSha256: fabricated.tree_sha256,
		}),
		await buildTestResultStatement({
			treeSha256: fabricated.tree_sha256,
			candidateCommit: fabricated.candidate_commit,
			testConfigDigest: fabricated.evaluation_bundle_hash,
			result: "PASS",
		}),
		await buildVerificationResultStatement({
			treeSha256: fabricated.tree_sha256,
			candidateCommit: fabricated.candidate_commit,
			policySha256: policy,
			result: "PASSED",
		}),
		authority,
	]) {
		statements.push(await signEnvelope(statement, forger));
	}
	const bundle = {
		version: opts.withLedger ? 3 : 1,
		statements,
		ship: {
			repo: "acme/canonical",
			commit: fabricated.candidate_commit,
			tree_sha256: fabricated.tree_sha256,
			base: fabricated.base,
			parent: fabricated.base,
			permit_id,
		},
		...(ledger ? { ledger } : {}),
		// The pre-authority-signing format's "ledger": the permit id itself.
		ledger_hashes: [permit_id],
		authority_pubkey_der_hex: forger.publicKeyDerHex,
	};
	return { bundle, forgerKeyDerHex: forger.publicKeyDerHex };
}

describe("forged promotion bundles", () => {
	before(async () => {
		tmp.dir = await mkdtemp(path.join(os.tmpdir(), "madgrix-forged-bundle-"));
		// The real authority's public key, which the verifier pins. The forger
		// never sees the matching private key.
		const { publicKey } = generateKeyPairSync("ed25519");
		tmp.pinnedKeyPath = path.join(tmp.dir, "pinned-authority.pub");
		await writeFile(tmp.pinnedKeyPath, publicKey.export({ type: "spki", format: "pem" }));
	});

	after(async () => {
		if (tmp.dir) await rm(tmp.dir, { recursive: true, force: true });
	});

	it("a bundle for fabricated values signed by a fresh key is not VERIFIED", async () => {
		const forged = await writeJson("forged-v1.bundle", (await forgeBundle({ withLedger: false })).bundle);
		const run = await verifyCli(forged, "--trust-key", tmp.pinnedKeyPath);
		assert.notEqual(run.code, 0, `verify accepted a forged bundle:\n${run.stdout}`);
		assert.doesNotMatch(run.stdout, /^VERIFIED$/m);
	});

	it("a self-consistent forgery fails at authority key and signature; only the pinned key decides", async () => {
		const { bundle, forgerKeyDerHex } = await forgeBundle({ withLedger: true });
		const forged = await writeJson("forged-v2.bundle", bundle);
		const run = await verifyCli(forged, "--trust-key", tmp.pinnedKeyPath);
		assert.notEqual(run.code, 0, `verify accepted a forged bundle:\n${run.stdout}`);
		assert.match(run.stdout, /^NOT VERIFIED$/m);
		assert.equal(run.lines.get("authority key"), "FAIL", "the embedded key is not the pinned key");
		assert.equal(run.lines.get("signature"), "FAIL", "no statement verifies under the pinned key");
		assert.ok(!run.lines.has("promotion authority"), "no CONSUMED ONCE line");

		// The forgery is otherwise internally consistent: pinning the
		// forger's own key would verify it. Trust comes only from the pin.
		const forgerKeyPath = path.join(tmp.dir, "forger.pub");
		await writeFile(forgerKeyPath, forgerKeyDerHex);
		const underForgerKey = await verifyCli(forged, "--trust-key", forgerKeyPath);
		assert.equal(underForgerKey.code, 0, underForgerKey.stdout);
		assert.match(underForgerKey.stdout, /^VERIFIED$/m);
	});

	it("verify refuses to run without a readable trusted key", async () => {
		const forged = await writeJson("forged-no-key.bundle", (await forgeBundle({ withLedger: true })).bundle);
		const run = await verifyCli(forged, "--trust-key", path.join(tmp.dir, "no-such-key.pub"));
		assert.equal(run.code, 2, `expected a usage error, got exit ${run.code}:\n${run.stdout}`);
		assert.match(run.stderr, /trusted key/);
	});

	describe("genuine slice bundle (harness authority key)", () => {
		const slice = {} as { bundlePath: string; trustKeyPath: string; bundle: any; trustedKeyDerHex: string };

		before(async () => {
			const r = await runSlice({ quiet: true, outDir: path.join(tmp.dir, "slice") });
			slice.bundlePath = r.bundlePath;
			slice.trustKeyPath = (r as { trustKeyPath?: string }).trustKeyPath as string;
			slice.bundle = JSON.parse(await readFile(r.bundlePath, "utf8"));
			slice.trustedKeyDerHex = slice.bundle.authority_pubkey_der_hex;
		});

		it("verifies with the pinned harness key; fails with any other pinned key", async () => {
			const run = await verifyCli(slice.bundlePath, "--trust-key", slice.trustKeyPath);
			assert.equal(run.code, 0, `genuine bundle rejected:\n${run.stdout}\n${run.stderr}`);
			assert.deepEqual(
				[...run.lines.entries()],
				[
					["subject digest", "OK"],
					["candidate digest", "OK"],
					["chain integrity", "OK"],
					["hidden evaluation", "PASSED"],
					["policy digest", "OK"],
					["destination base", "OK"],
					["authority key", "PINNED"],
					["signature", "VALID"],
					["permit id", "RECOMPUTED FROM BOUND FIELDS"],
					["ledger chain", "OK"],
				],
			);
			assert.match(run.stdout, /^VERIFIED$/m);

			const other = await verifyCli(slice.bundlePath, "--trust-key", tmp.pinnedKeyPath);
			assert.notEqual(other.code, 0);
			assert.equal(other.lines.get("authority key"), "FAIL");
			assert.equal(other.lines.get("signature"), "FAIL");
		});

		it("an embedded key that differs from the pinned key fails even when signatures verify", async () => {
			const swapped = structuredClone(slice.bundle);
			swapped.authority_pubkey_der_hex = createEd25519Signer().publicKeyDerHex;
			const run = await verifyCli(await writeJson("swapped-key.bundle", swapped), "--trust-key", slice.trustKeyPath);
			assert.notEqual(run.code, 0);
			assert.equal(run.lines.get("authority key"), "FAIL");
			assert.equal(run.lines.get("signature"), "VALID", "statements still verify under the pinned key");
		});

		it("tampering any ledger entry fails, with or without re-linking the chain", async () => {
			const verifyWithTrustedKey = (verifyModule as Record<string, any>).verifyWithTrustedKey;
			assert.equal(typeof verifyWithTrustedKey, "function", "verify.ts exports verifyWithTrustedKey");
			const entries = slice.bundle.ledger.entries as any[];
			assert.ok(entries.length >= 3, "the slice ledger has entries to tamper with");

			for (let i = 0; i < entries.length; i++) {
				// Naive: change one entry and leave every hash as it was.
				const naive = structuredClone(slice.bundle);
				naive.ledger.entries[i].kind = `${naive.ledger.entries[i].kind}-tampered`;
				const r1 = await verifyWithTrustedKey(naive, slice.trustedKeyDerHex);
				assert.equal(r1.verified, false, `naive tamper of entry ${i} verified`);
				assert.equal(r1.lines.find((l: { label: string }) => l.label === "ledger chain")?.status, "FAIL");

				// Re-linked: recompute every hash from the tampered entry onward and
				// the unsigned head, so the chain is self-consistent. Only the head
				// signed into the authority statement can catch this.
				const relinked = structuredClone(slice.bundle);
				relinked.ledger.entries[i].payload_hash = await sha256Hex(`tampered-${i}`);
				relinked.ledger.head_sha256 = await rechain(relinked.ledger.entries, i);
				const r2 = await verifyWithTrustedKey(relinked, slice.trustedKeyDerHex);
				assert.equal(r2.verified, false, `re-linked tamper of entry ${i} verified`);
				assert.equal(r2.lines.find((l: { label: string }) => l.label === "ledger chain")?.status, "FAIL");
			}

			// The same through the CLI, for one representative entry.
			const cliTamper = structuredClone(slice.bundle);
			cliTamper.ledger.entries[1].payload_hash = await sha256Hex("tampered");
			cliTamper.ledger.head_sha256 = await rechain(cliTamper.ledger.entries, 1);
			const run = await verifyCli(await writeJson("tampered-ledger.bundle", cliTamper), "--trust-key", slice.trustKeyPath);
			assert.notEqual(run.code, 0);
			assert.equal(run.lines.get("ledger chain"), "FAIL");
			assert.match(run.stdout, /^NOT VERIFIED$/m);
		});
	});
});
