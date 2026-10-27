import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-ignore -- plain ESM helper
import { planAgents, percentile, flaggedPathOverlap, claimBody, pool } from "../scripts/lib/scale.mjs";
import { createAuthority, enrollAgents, registerClaim, isActionableReport } from "../src/lib/task-state.ts";
import { randomHex, sha256Hex } from "../src/lib/canonical.ts";

test("planAgents seeds one overlap every 20 agents, all ids distinct", () => {
	const a = planAgents(100);
	assert.equal(new Set(a.map((x: { id: string }) => x.id)).size, 100);
	assert.equal(a.filter((x: { overlapsWith: string | null }) => x.overlapsWith).length, 4);
	assert.deepEqual(a[20].paths, ["agents/a20/**", "agents/a19/**"]);
});

test("percentile is nearest-rank", () => {
	assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
	assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
	assert.equal(percentile([], 50), null);
});

test("pool keeps order", async () => {
	assert.deepEqual(await pool([3, 1, 2], 2, async (x: number) => x * 2), [6, 2, 4]);
});

test("authority stores O(overlaps) conflict reports, not O(n²), and still flags seeded overlaps", async () => {
	const ctx = { now: () => new Date().toISOString(), randomHex, sha256Hex, selectorPolicyHash: "0".repeat(64), policyVersion: "seam-policy/0.1.0" };
	const task = { task_id: "t", task_hash: "h".repeat(64), intent: "s", baseline_repo: "r", baseline_commit: "c".repeat(40), behavior_contract: "", policy_version: "seam-policy/0.1.0", frozen_at: ctx.now() };
	const agents = planAgents(60);
	const secrets: Record<string, string> = {};
	const enroll: Record<string, string> = {};
	for (const a of agents) { secrets[a.id] = randomHex(32); enroll[a.id] = await sha256Hex(secrets[a.id]); }
	let state = await enrollAgents(createAuthority(task as never), enroll, ctx as never);
	const workIds: Record<string, string> = {};
	let flagged = 0;
	for (const a of [...agents.filter((x: { overlapsWith: string | null }) => !x.overlapsWith), ...agents.filter((x: { overlapsWith: string | null }) => x.overlapsWith)]) {
		const r = await registerClaim(state, claimBody(a, task) as never, ctx as never, secrets[a.id]);
		state = r.state;
		workIds[a.id] = r.claim.work_id;
		assert.ok(r.reports.every(isActionableReport));
		if (a.overlapsWith && flaggedPathOverlap(r.reports.map((x) => ({ with: x.claim_b, explanation: x.explanation })), workIds[a.overlapsWith])) flagged++;
	}
	assert.equal(state.claims.length, 60);
	assert.equal(flagged, 2);
	assert.equal((state.conflict_reports ?? []).length, 2);
});
