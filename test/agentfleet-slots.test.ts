/**
 * Contender slots come from an Agentfleet validation report, not a hardcoded trio.
 * node --test test/agentfleet-slots.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { contenderIdsFromReport, loadContenderIds } from "../scripts/lib/agentfleet-slots.mjs";

describe("Agentfleet contender slots", () => {
	it("reads summary.agent_ids in manifest order", () => {
		const ids = Array.from({ length: 10 }, (_, i) => `agent-${String(i + 1).padStart(2, "0")}`);
		assert.deepEqual(
			contenderIdsFromReport({
				is_valid: true,
				summary: { agent_ids: ids },
			}),
			ids,
		);
	});

	it("rejects a report that is not a valid roster", () => {
		assert.throws(() => contenderIdsFromReport({ is_valid: false, issues: [{ message: "no agents" }] }), /no agents/);
		assert.throws(() => contenderIdsFromReport({ is_valid: true, summary: { agent_ids: ["agent-01"] } }), /at least two/);
		assert.throws(
			() => contenderIdsFromReport({ is_valid: true, summary: { agent_ids: ["agent-01", "agent 02"] } }),
			/cannot enroll/,
		);
	});

	it("lets MADGRIX_AGENT_IDS override the fleet manifest", () => {
		assert.deepEqual(loadContenderIds({ env: { MADGRIX_AGENT_IDS: "agent-a, agent-b" } }), ["agent-a", "agent-b"]);
	});
});
