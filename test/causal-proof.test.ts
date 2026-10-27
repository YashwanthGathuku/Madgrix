import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildCausalProofGraph } from "../src/lib/causal-proof.ts";
import { createAuthority } from "../src/lib/task-state.ts";
import type { EvaluationBundle, PermitRecord, TaskRecord, VerdictRecord } from "../src/lib/types.ts";

const task: TaskRecord = {
	task_id: "task-causal",
	task_hash: "1".repeat(64),
	intent: "ship the reviewed state",
	baseline_repo: "default/starter",
	baseline_commit: "base",
	behavior_contract: "",
	policy_version: "seam-policy/0.1.0",
	frozen_at: "2026-10-14T00:00:00.000Z",
};

const evaluation: EvaluationBundle = {
	candidate_sha: "candidate",
	tree_sha256: "2".repeat(64),
	contender_id: "contender",
	task_hash: task.task_hash,
	admission: { exact_baseline: true, scope_compliance: true, valid_tool_states: true, no_eval_tampering: true, provenance_complete: true },
	hidden_oracle: { passed: true, total: 1, failed: [] },
	regressions: { passed: true, total: 1, failed: [] },
	static_analysis: { passed: true, findings: [] },
	semantic_checks: { passed: true, total: 1, failed: [] },
	security_policy: { passed: true, findings: [] },
	bundle_hash: "3".repeat(64),
	evaluated_at: "2026-10-14T00:01:00.000Z",
	tainted: false,
};

const verdict: VerdictRecord = {
	state: "ACCEPT",
	candidate_shas: ["candidate"],
	evidence_hashes: [evaluation.bundle_hash],
	reasons: ["PRIVATE VERDICT REASON"],
	policy_hash: "4".repeat(64),
	selector_policy_version: "seam-policy/0.1.0",
	timestamp: "2026-10-14T00:02:00.000Z",
	winner_sha: "candidate",
};

const permit: PermitRecord = {
	permit_id: "5".repeat(64),
	task_hash: task.task_hash,
	baseline_commit: task.baseline_commit,
	winner_candidate_sha: "candidate",
	contender_id: "contender",
	winning_tree_sha256: evaluation.tree_sha256,
	evaluation_bundle_hash: evaluation.bundle_hash,
	selector_policy_hash: verdict.policy_hash,
	destination_repo: "default/starter",
	expected_destination_head: "base",
	nonce: "6".repeat(64),
	issued_at: "2026-10-14T00:03:00.000Z",
	consumed: false,
	consumed_at: null,
};

describe("Causal Proof Graph", () => {
	it("answers why a governed SHA may become canonical with a stable root without exporting free-text verdict reasons", async () => {
		const state = createAuthority(task);
		state.evaluations.candidate = evaluation;
		state.verdicts.push(verdict);
		state.permits[permit.permit_id] = permit;
		const graph = await buildCausalProofGraph(state, "candidate");
		assert.equal(graph.target_sha, "candidate");
		assert.match(graph.causal_root, /^[0-9a-f]{64}$/);
		assert.ok(graph.nodes.some((n) => n.type === "task"));
		assert.ok(graph.nodes.some((n) => n.type === "evaluation"));
		assert.ok(graph.nodes.some((n) => n.type === "verdict"));
		assert.ok(graph.nodes.some((n) => n.type === "canoncap"));
		assert.ok(graph.nodes.some((n) => n.type === "canonical"));
		assert.ok(graph.edges.some((e) => e.relation === "authorizes-canonicalization"));
		assert.ok(graph.edges.some((e) => e.relation === "ships-exact-state"));
		assert.doesNotMatch(JSON.stringify(graph), /PRIVATE VERDICT REASON/);
	});
});
