import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildConflictCapsule } from "../src/lib/conflict-capsule.ts";
import type { CompositionRecord } from "../src/lib/types.ts";

function conflicted(): CompositionRecord {
	return {
		status: "CONFLICTED",
		contender_id: "crew-1",
		baseline: "base",
		agents: [
			{ id: "api", role: "api", intent: "change route", sha: "sha-a", paths: ["src/**"], claim_work_id: "w-a" },
			{ id: "ui", role: "ui", intent: "change route UI", sha: "sha-b", paths: ["src/**"], claim_work_id: "w-b" },
		],
		contributing_shas: ["sha-b", "sha-a"],
		files: [
			{
				path: "src/router.ts",
				classification: "textual-line-overlap",
				sides: [
					{ agent_id: "ui", role: "ui", intent: "change route UI", sha: "sha-b", excerpt: "PRIVATE UI SOURCE" },
					{ agent_id: "api", role: "api", intent: "change route", sha: "sha-a", excerpt: "PRIVATE API SOURCE" },
				],
			},
		],
		candidate_sha: null,
	};
}

describe("Conflict Capsule", () => {
	it("turns conflict state into a stable content-addressed protocol object without exporting raw source excerpts", async () => {
		const a = await buildConflictCapsule("task-hash", conflicted());
		const reordered = conflicted();
		reordered.contributing_shas.reverse();
		reordered.files[0].sides.reverse();
		const b = await buildConflictCapsule("task-hash", reordered);
		assert.equal(a.capsule_id, b.capsule_id);
		assert.equal(a.resolution_requirements.new_candidate_required, true);
		assert.equal(a.resolution_requirements.re_evaluation_required, true);
		assert.equal(a.resolution_requirements.old_authority_invalid, true);
		assert.equal(a.conflicts[0].path, "src/router.ts");
		assert.match(a.conflicts[0].sides[0].excerpt_sha256, /^[0-9a-f]{64}$/);
		assert.doesNotMatch(JSON.stringify(a), /PRIVATE .* SOURCE/);
	});

	it("refuses to capsule a promotable composition", async () => {
		const row = conflicted();
		row.status = "COMPOSED";
		row.candidate_sha = "new";
		await assert.rejects(() => buildConflictCapsule("task-hash", row), /requires CONFLICTED/);
	});
});
