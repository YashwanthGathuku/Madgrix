/**
 * Integration test for the vertical slice (src/harness/slice.ts).
 *
 * Runs the slice's core assertions WITHOUT the sectioned print log
 * (quiet mode) and checks the headline outcomes independently:
 *   - verdict ACCEPT with contender-1 as the winner,
 *   - promotion PROMOTED, permit replay ALREADY_CONSUMED,
 *   - the written promotion bundle verifies offline via an independent
 *     verify-only signer built from the bundle's own authority key.
 *
 * node --test test/slice.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { sha256Hex } from "../src/lib/canonical.ts";
import { verifyBundle, type PromotionBundle } from "../src/lib/attestation.ts";
import { buildVerifyOnlySigner } from "../src/cli/verify.ts";
import { SELECTOR_POLICY_INPUT } from "../src/do/TaskAuthority.ts";
import { runSlice } from "../src/harness/slice.ts";

describe("vertical slice (quiet)", () => {
	it("completes: ACCEPT → PROMOTED → replay consumed → bundle VERIFIED", async () => {
		const r = await runSlice({ quiet: true });

		// Verdict: ACCEPT, winner is contender-1's candidate.
		assert.equal(r.verdictState, "ACCEPT");
		assert.ok(r.winnerSha !== null && r.winnerSha.length === 64);
		assert.equal(r.winnerSha, r.candidateShas["contender-1"]);

		// Promotion: first presentation PROMOTED; replay is a no-op ACK.
		assert.equal(r.promotionOutcome, "PROMOTED");
		assert.equal(r.replayOutcome, "ALREADY_CONSUMED");
		assert.ok(r.permitId.length === 64);

		// Independent offline verification of the written bundle.
		const bundle = JSON.parse(await readFile(r.bundlePath, "utf8")) as PromotionBundle;
		assert.equal(bundle.version, 1);
		assert.equal(bundle.ship.commit, r.winnerSha);
		assert.equal(bundle.ship.permit_id, r.permitId);
		const signer = buildVerifyOnlySigner(bundle.authority_pubkey_der_hex);
		const policyHash = await sha256Hex(SELECTOR_POLICY_INPUT);
		const { lines, verified } = await verifyBundle(bundle, signer, { policyHash });
		assert.equal(verified, true);
		assert.deepEqual(
			lines.map((l) => l.status),
			["OK", "OK", "OK", "PASSED", "OK", "OK", "VALID", "CONSUMED ONCE"],
		);
		assert.equal(r.verified, true);
	});
});
