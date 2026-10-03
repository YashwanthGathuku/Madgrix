/**
 * Tests for in-toto + DSSE attestation (spec 4).
 * node --test test/attestation.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	AGENT_PROMOTION_AUTHORITY_V1,
	buildLinkStatement,
	buildPromotionAuthority,
	buildTestResultStatement,
	buildVerificationResultStatement,
	signEnvelope,
	verifyBundle,
	verifyEnvelope,
	type PromotionBundle,
} from "../src/lib/attestation.ts";
import { createEd25519Signer } from "../src/lib/signer-node.ts";
import { canonicalJson, sha256Hex } from "../src/lib/canonical.ts";
import { LEDGER_GENESIS_PREV_HASH, ledgerEntryHash } from "../src/lib/ledger.ts";
import { buildPermitId } from "../src/lib/permit.ts";
import type { LedgerEntry } from "../src/lib/types.ts";

const TREE = "tree-sha256-aaa";
const COMMIT = "commit-aaa";
const BASELINE = "base123";
const POLICY = "policyhash";
const PERMIT = "permit-1";

/** A hash-chained ledger recording the promotion `promotions` times. */
async function promotionLedger(permitId: string, promotions: number) {
	const entries: LedgerEntry[] = [];
	const append = async (kind: string, payload_hash: string) => {
		const fields = {
			seq: entries.length,
			ts: "2026-10-01T19:00:00Z",
			kind,
			payload_hash,
			prev_hash: entries.length === 0 ? LEDGER_GENESIS_PREV_HASH : entries[entries.length - 1].entry_hash,
		};
		entries.push({ ...fields, entry_hash: await ledgerEntryHash(fields, sha256Hex) });
	};
	await append("authority_created", "");
	for (let i = 0; i < promotions; i++) {
		await append("promotion_succeeded", await sha256Hex(canonicalJson({ permit_id: permitId, tree_sha256: TREE })));
	}
	return { head_sha256: entries[entries.length - 1].entry_hash, entries };
}

async function buildAllOkBundle(opts: { promotions?: number; permitId?: string } = {}) {
	const signer = createEd25519Signer();
	const permitId = opts.permitId ?? await buildPermitId(
		{
			task_hash: "taskhash",
			baseline_commit: BASELINE,
			winning_tree_sha256: TREE,
			evaluation_bundle_hash: "evalhash",
			selector_policy_hash: POLICY,
			expected_destination_head: "dest-head-1",
		},
		sha256Hex,
	);
	const ledger = await promotionLedger(permitId, opts.promotions ?? 1);
	const link = await buildLinkStatement({ baselineCommit: BASELINE, candidateCommit: COMMIT, treeSha256: TREE });
	const test = await buildTestResultStatement({
		treeSha256: TREE,
		candidateCommit: COMMIT,
		testConfigDigest: "testconfig",
		result: "PASS",
	});
	const verif = await buildVerificationResultStatement({
		treeSha256: TREE,
		candidateCommit: COMMIT,
		policySha256: POLICY,
		result: "PASSED",
	});
	const auth = await buildPromotionAuthority({
		taskHash: "taskhash",
		baselineCommit: BASELINE,
		candidateRepo: "fork-1",
		candidateCommit: COMMIT,
		treeSha256: TREE,
		evaluationBundleHash: "evalhash",
		verificationResult: "PASSED",
		policySha256: POLICY,
		destinationRepo: "acme/api",
		destinationBase: "dest-head-1",
		nonce: "nonce-1",
		permitId,
		issuedAt: "2026-10-01T19:00:00Z",
		ledgerHeadSha256: ledger.head_sha256,
	});
	const statements = await Promise.all(
		[link, test, verif, auth].map((s) => signEnvelope(s, signer)),
	);
	const bundle: PromotionBundle = {
		version: 3,
		statements,
		// The candidate sits two commits above the base: its own parent is not the base.
		ship: { repo: "acme/api", commit: COMMIT, tree_sha256: TREE, base: "dest-head-1", parent: "candidate-step-1", permit_id: permitId },
		ledger,
		authority_pubkey_der_hex: signer.publicKeyDerHex,
	};
	// The tests pin the key that signed the bundle.
	return { signer, bundle, pin: { policyHash: POLICY, trustedKeyDerHex: signer.publicKeyDerHex } };
}

describe("DSSE envelope", () => {
	it("sign/verify roundtrip", async () => {
		const signer = createEd25519Signer();
		const stmt = await buildPromotionAuthority({
			taskHash: "t",
			baselineCommit: BASELINE,
			candidateRepo: "fork-1",
			candidateCommit: COMMIT,
			treeSha256: TREE,
			evaluationBundleHash: "e",
			verificationResult: "PASSED",
			policySha256: POLICY,
			destinationRepo: "acme/api",
			destinationBase: "p",
			nonce: "n",
			permitId: PERMIT,
			issuedAt: "2026-10-01T19:00:00Z",
		});
		assert.equal(stmt.predicateType, AGENT_PROMOTION_AUTHORITY_V1);
		assert.equal(stmt.subject[0].digest.sha256, TREE);
		const env = await signEnvelope(stmt, signer);
		assert.equal(env.payloadType, "application/vnd.in-toto+json");
		const r = await verifyEnvelope(env, signer);
		assert.equal(r.valid, true);
		assert.equal((r.statement as typeof stmt).predicateType, AGENT_PROMOTION_AUTHORITY_V1);
	});

	it("tampered payload → invalid", async () => {
		const signer = createEd25519Signer();
		const stmt = await buildLinkStatement({ baselineCommit: BASELINE, candidateCommit: COMMIT, treeSha256: TREE });
		const env = await signEnvelope(stmt, signer);
		const tampered = { ...env, payload: env.payload.replace(TREE, "tree-sha256-EVIL") };
		const r = await verifyEnvelope(tampered, signer);
		assert.equal(r.valid, false);
		assert.match(r.failure as string, /did not verify/);
	});

	it("wrong keyid → invalid", async () => {
		const signer = createEd25519Signer();
		const other = createEd25519Signer();
		const stmt = await buildLinkStatement({ baselineCommit: BASELINE, candidateCommit: COMMIT, treeSha256: TREE });
		const env = await signEnvelope(stmt, signer);
		const r = await verifyEnvelope(env, {
			sign: other.sign.bind(other),
			verify: other.verify.bind(other),
		});
		assert.equal(r.valid, false);
	});
});

describe("verifyBundle (spec 4 §7 transcript)", () => {
	it("all-OK bundle → VERIFIED with the transcript lines in order", async () => {
		const { signer, bundle, pin } = await buildAllOkBundle();
		const { lines, verified } = await verifyBundle(bundle, signer, pin);
		assert.equal(verified, true);
		assert.deepEqual(
			lines.map((l) => l.label),
			[
				"subject digest",
				"candidate digest",
				"chain integrity",
				"hidden evaluation",
				"policy digest",
				"destination base",
				"authority key",
				"signature",
				"permit id",
				"ledger chain",
			],
		);
		assert.deepEqual(
			lines.map((l) => l.status),
			["OK", "OK", "OK", "PASSED", "OK", "OK", "PINNED", "VALID", "RECOMPUTED FROM BOUND FIELDS", "OK"],
		);
	});

	it("broken chain (test statement on a different tree) → named failing line", async () => {
		const { signer, bundle, pin } = await buildAllOkBundle();
		const badTest = await buildTestResultStatement({
			treeSha256: "different-tree",
			candidateCommit: COMMIT,
			testConfigDigest: "testconfig",
			result: "PASS",
		});
		const statements = [...bundle.statements];
		statements[1] = await signEnvelope(badTest, signer);
		const { lines, verified } = await verifyBundle({ ...bundle, statements }, signer, pin);
		assert.equal(verified, false);
		const chainLine = lines.find((l) => l.label === "chain integrity");
		assert.equal(chainLine?.status, "FAIL");
	});

	it("permit replay (promotion recorded twice in the signed ledger) → ledger chain FAIL", async () => {
		const { signer, bundle, pin } = await buildAllOkBundle({ promotions: 2 });
		const { lines, verified } = await verifyBundle(bundle, signer, pin);
		assert.equal(verified, false);
		const line = lines.find((l) => l.label === "ledger chain");
		assert.equal(line?.status, "FAIL");
		assert.match(line?.detail ?? "", /2 times/);
	});

	it("permit_id that does not recompute from its bound fields → permit id FAIL", async () => {
		const { signer, bundle, pin } = await buildAllOkBundle({ permitId: PERMIT });
		const { lines, verified } = await verifyBundle(bundle, signer, pin);
		assert.equal(verified, false);
		assert.deepEqual(
			lines.filter((l) => l.status === "FAIL").map((l) => l.label),
			["permit id"],
			"signed, pinned and ledgered, but the permit id is not the hash of what it binds",
		);
	});

	it("wrong policy hash → policy digest FAIL", async () => {
		const { signer, bundle, pin } = await buildAllOkBundle();
		const { lines, verified } = await verifyBundle(bundle, signer, { ...pin, policyHash: "other-policy" });
		assert.equal(verified, false);
		assert.equal(lines.find((l) => l.label === "policy digest")?.status, "FAIL");
	});

	it("ship base moved → destination base FAIL", async () => {
		const { signer, bundle, pin } = await buildAllOkBundle();
		const { lines, verified } = await verifyBundle(
			{ ...bundle, ship: { ...bundle.ship, base: "dest-head-2" } },
			signer,
			pin,
		);
		assert.equal(verified, false);
		assert.deepEqual(
			lines.filter((l) => l.status === "FAIL").map((l) => l.label),
			["destination base"],
		);
	});

	it("a version-2 bundle (expected_parent, no ship base) does not verify under version 3", async () => {
		const { signer, bundle, pin } = await buildAllOkBundle();
		const { base: _base, ...shipV2 } = bundle.ship;
		const { lines, verified } = await verifyBundle({ ...bundle, ship: shipV2 } as never, signer, pin);
		assert.equal(verified, false);
		assert.equal(lines.find((l) => l.label === "destination base")?.status, "FAIL");
	});
});
