import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MAX_LOGICAL_AGENTS, planAgentWaves, runBounded } from "../src/lib/fleet-scale.ts";

describe("10k logical fleet planning", () => {
	it("plans 10,000 unique agents into bounded waves", () => {
		const ids = Array.from({ length: MAX_LOGICAL_AGENTS }, (_, i) => `agent-${String(i + 1).padStart(5, "0")}`);
		const waves = planAgentWaves(ids, 32);
		assert.equal(waves.length, 313);
		assert.equal(waves[0].agent_ids.length, 32);
		assert.equal(waves.at(-1)?.agent_ids.length, 16);
		const flattened = waves.flatMap((wave) => wave.agent_ids);
		assert.equal(flattened.length, MAX_LOGICAL_AGENTS);
		assert.equal(new Set(flattened).size, MAX_LOGICAL_AGENTS);
	});

	it("refuses a roster beyond the declared 10k bound", () => {
		const ids = Array.from({ length: MAX_LOGICAL_AGENTS + 1 }, (_, i) => `a-${i}`);
		assert.throws(() => planAgentWaves(ids, 32), /exceeds 10000/);
	});

	it("never exceeds the active window", async () => {
		const ids = Array.from({ length: 1000 }, (_, i) => `agent-${i}`);
		let inFlight = 0;
		let maxInFlight = 0;
		const out = await runBounded(ids, 17, async (id) => {
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise<void>((resolve) => setImmediate(resolve));
			inFlight -= 1;
			return id;
		});
		assert.equal(out.length, ids.length);
		assert.equal(maxInFlight, 17);
	});
});
