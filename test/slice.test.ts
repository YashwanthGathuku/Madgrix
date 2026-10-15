/**
 * Integration test for the vertical slice (src/harness/slice.ts).
 *
 * Runs the slice's core assertions WITHOUT the sectioned print log
 * (quiet mode) and checks the headline outcomes independently:
 *   - verdict ACCEPT with contender-1 as the winner,
 *   - promotion PROMOTED, permit replay ALREADY_CONSUMED,
 *   - the written promotion bundle verifies offline against the pinned
 *     harness authority key (never the key embedded in the bundle).
 *
 * node --test test/slice.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { PromotionBundle } from "../src/lib/attestation.ts";
import { parseTrustedKey, verifyWithTrustedKey } from "../src/cli/verify.ts";
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
		assert.equal(bundle.version, 3);
		assert.equal(bundle.ship.commit, r.winnerSha);
		assert.equal(bundle.ship.permit_id, r.permitId);
		// The canonical repo was fast-forwarded from the baseline to the
		// candidate, whose own parent is the baseline.
		assert.equal(bundle.ship.base, r.baseline);
		assert.equal(bundle.ship.parent, r.baseline);
		const pinned = parseTrustedKey(await readFile(r.trustKeyPath, "utf8"));
		const { lines, verified } = await verifyWithTrustedKey(bundle, pinned);
		assert.equal(verified, true);
		assert.deepEqual(
			lines.map((l) => l.status),
			["OK", "OK", "OK", "PASSED", "OK", "OK", "PINNED", "VALID", "RECOMPUTED FROM BOUND FIELDS", "OK"],
		);
		assert.equal(r.verified, true);
	});
});
