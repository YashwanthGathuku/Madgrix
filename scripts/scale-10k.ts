#!/usr/bin/env node
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createAuthority, defaultCtx, enrollAgents } from "../src/lib/task-state.ts";
import {
	DEFAULT_ACTIVE_AGENT_WINDOW,
	MAX_LOGICAL_AGENTS,
	planAgentWaves,
	runBounded,
} from "../src/lib/fleet-scale.ts";

const count = MAX_LOGICAL_AGENTS;
const ids = Array.from({ length: count }, (_, i) => `agent-${String(i + 1).padStart(5, "0")}`);
const enrollment = Object.fromEntries(ids.map((id, i) => [id, (i + 1).toString(16).padStart(64, "0")]));

const authority = createAuthority({
	task_id: "task_scale_10k",
	task_hash: "scale-10k-task-hash",
	intent: "validate 10k logical-agent control-plane representation",
	baseline_repo: "scale/repo",
	baseline_commit: "baseline",
	behavior_contract: "scale harness only",
	policy_version: "scale-harness/v1",
	frozen_at: "2026-10-15T00:00:00.000Z",
});
const enrolled = await enrollAgents(authority, enrollment, defaultCtx("scale-policy-hash"));
assert.equal(Object.keys(enrolled.agent_enrollment ?? {}).length, count);

const waves = planAgentWaves(ids, DEFAULT_ACTIVE_AGENT_WINDOW);
const flattened = waves.flatMap((wave) => wave.agent_ids);
assert.equal(flattened.length, count);
assert.equal(new Set(flattened).size, count);
assert.ok(waves.every((wave) => wave.agent_ids.length <= DEFAULT_ACTIVE_AGENT_WINDOW));

let inFlight = 0;
let maxInFlight = 0;
const completed = await runBounded(ids, DEFAULT_ACTIVE_AGENT_WINDOW, async (id) => {
	inFlight += 1;
	maxInFlight = Math.max(maxInFlight, inFlight);
	await new Promise<void>((resolve) => setImmediate(resolve));
	inFlight -= 1;
	return id;
});
assert.equal(completed.length, count);
assert.ok(maxInFlight <= DEFAULT_ACTIVE_AGENT_WINDOW);

const enrollmentBytes = Buffer.byteLength(JSON.stringify(enrolled.agent_enrollment), "utf8");
console.log(
	JSON.stringify(
		{
			logical_agents: count,
			enrolled_identities: Object.keys(enrolled.agent_enrollment ?? {}).length,
			waves: waves.length,
			active_window: DEFAULT_ACTIVE_AGENT_WINDOW,
			observed_max_in_flight: maxInFlight,
			enrollment_json_bytes: enrollmentBytes,
			proof_scope:
				"local logical-agent enrollment + bounded scheduler; not 10,000 simultaneous Cloudflare repos or LLM processes",
		},
		null,
		2,
	),
);
console.log("MADGRIX_10K_LOGICAL_FLEET_OK");
