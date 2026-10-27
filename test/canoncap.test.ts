import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { canonCapFromPermit, checkCanonCap } from "../src/lib/canoncap.ts";
import type { PermitRecord } from "../src/lib/types.ts";

const permit: PermitRecord = {
	permit_id: "a".repeat(64),
	task_hash: "b".repeat(64),
	baseline_commit: "base",
	winner_candidate_sha: "candidate",
	contender_id: "contender-1",
	winning_tree_sha256: "c".repeat(64),
	evaluation_bundle_hash: "d".repeat(64),
	selector_policy_hash: "e".repeat(64),
	destination_repo: "default/canonical",
	expected_destination_head: "head-1",
	nonce: "f".repeat(64),
	issued_at: "2026-10-14T00:00:00.000Z",
	consumed: false,
	consumed_at: null,
};

describe("CanonCap", () => {
	it("content-addresses exact canonicalization authority including candidate and destination", async () => {
		const cap = await canonCapFromPermit(permit);
		const cap2 = await canonCapFromPermit({ ...permit, nonce: "0".repeat(64) });
		assert.equal(cap.canoncap_id, cap2.canoncap_id, "nonce is not part of the public descriptor");
		assert.equal(cap.bindings.candidate_sha, "candidate");
		assert.equal(cap.bindings.destination_repo, "default/canonical");
		assert.equal(cap.single_use, true);
		assert.match(cap.canoncap_id, /^[0-9a-f]{64}$/);
	});

	it("fails closed when any exact-state binding moves", async () => {
		const cap = await canonCapFromPermit(permit);
		const world = {
			destination_repo: permit.destination_repo,
			destination_head: permit.expected_destination_head,
			candidate_sha: permit.winner_candidate_sha,
			tree_sha256: permit.winning_tree_sha256,
			evaluation_bundle_hash: permit.evaluation_bundle_hash,
			selector_policy_hash: permit.selector_policy_hash,
		};
		assert.deepEqual(checkCanonCap(cap, world), { ok: true });
		assert.deepEqual(checkCanonCap(cap, { ...world, destination_head: "moved" }), {
			ok: false,
			error: "DESTINATION_HEAD_MOVED",
		});
		assert.deepEqual(checkCanonCap(cap, { ...world, candidate_sha: "substituted" }), {
			ok: false,
			error: "CANDIDATE_CHANGED",
		});
		assert.deepEqual(checkCanonCap(cap, { ...world, destination_repo: "other/repo" }), {
			ok: false,
			error: "DESTINATION_CHANGED",
		});
	});
});
