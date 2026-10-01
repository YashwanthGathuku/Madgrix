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

const TREE = "tree-sha256-aaa";
const COMMIT = "commit-aaa";
const BASELINE = "base123";
const POLICY = "policyhash";
const PERMIT = "permit-1";

async function buildAllOkBundle() {
	const signer = createEd25519Signer();
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
		expectedParent: "dest-head-1",
		nonce: "nonce-1",
		permitId: PERMIT,
		issuedAt: "2026-10-01T19:00:00Z",
	});
	const statements = await Promise.all(
		[link, test, verif, auth].map((s) => signEnvelope(s, signer)),
	);
	const bundle: PromotionBundle = {
		version: 1,
		statements,
		ship: { repo: "acme/api", commit: COMMIT, tree_sha256: TREE, parent: "dest-head-1", permit_id: PERMIT },
		ledger_hashes: [PERMIT],
		authority_pubkey_der_hex: signer.publicKeyDerHex,
	};
	return { signer, bundle };
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
			expectedParent: "p",
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
		const { signer, bundle } = await buildAllOkBundle();
		const { lines, verified } = await verifyBundle(bundle, signer, { policyHash: POLICY });
		assert.equal(verified, true);
		assert.deepEqual(
			lines.map((l) => l.label),
			[
				"subject digest",
				"candidate digest",
				"chain integrity",
				"hidden evaluation",
				"policy digest",
				"destination parent",
				"signature",
				"promotion authority",
			],
		);
		assert.deepEqual(
			lines.map((l) => l.status),
			["OK", "OK", "OK", "PASSED", "OK", "OK", "VALID", "CONSUMED ONCE"],
		);
	});

	it("broken chain (test statement on a different tree) → named failing line", async () => {
		const { signer, bundle } = await buildAllOkBundle();
		const badTest = await buildTestResultStatement({
			treeSha256: "different-tree",
			candidateCommit: COMMIT,
			testConfigDigest: "testconfig",
			result: "PASS",
		});
		const statements = [...bundle.statements];
		statements[1] = await signEnvelope(badTest, signer);
		const { lines, verified } = await verifyBundle({ ...bundle, statements }, signer, {
			policyHash: POLICY,
		});
		assert.equal(verified, false);
		const chainLine = lines.find((l) => l.label === "chain integrity");
		assert.equal(chainLine?.status, "FAIL");
	});

	it("permit replay (permit_id twice in ledger) → promotion authority FAIL", async () => {
		const { signer, bundle } = await buildAllOkBundle();
		const { lines, verified } = await verifyBundle(
			{ ...bundle, ledger_hashes: [PERMIT, PERMIT] },
			signer,
			{ policyHash: POLICY },
		);
		assert.equal(verified, false);
		const line = lines.find((l) => l.label === "promotion authority");
		assert.equal(line?.status, "FAIL");
	});

	it("wrong policy hash → policy digest FAIL", async () => {
		const { signer, bundle } = await buildAllOkBundle();
		const { lines, verified } = await verifyBundle(bundle, signer, { policyHash: "other-policy" });
		assert.equal(verified, false);
		assert.equal(lines.find((l) => l.label === "policy digest")?.status, "FAIL");
	});

	it("ship parent moved → destination parent FAIL", async () => {
		const { signer, bundle } = await buildAllOkBundle();
		const { lines, verified } = await verifyBundle(
			{ ...bundle, ship: { ...bundle.ship, parent: "dest-head-2" } },
			signer,
			{ policyHash: POLICY },
		);
		assert.equal(verified, false);
		assert.equal(lines.find((l) => l.label === "destination parent")?.status, "FAIL");
	});
});
