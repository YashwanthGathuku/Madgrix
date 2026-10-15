import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { projectCanonicality, renderCanonicalityPanel } from "../src/worker/canonicality-panel.ts";
import { createAuthority } from "../src/lib/task-state.ts";
import type { EvaluationBundle, PermitRecord, TaskRecord, VerdictRecord } from "../src/lib/types.ts";

const task: TaskRecord = {
	task_id: "demo-task", task_hash: "1".repeat(64), intent: "prove canonicality", baseline_repo: "default/repo",
	baseline_commit: "base", behavior_contract: "", policy_version: "seam-policy/0.1.0", frozen_at: "2026-10-14T00:00:00Z",
};

describe("canonicality Mission Control projection", () => {
	it("renders CanonCap and a causal root without exposing nonce", async () => {
		const state = createAuthority(task);
		const evalBundle: EvaluationBundle = {
			candidate_sha: "winner", tree_sha256: "2".repeat(64), contender_id: "c1", task_hash: task.task_hash,
			admission: { exact_baseline: true, scope_compliance: true, valid_tool_states: true, no_eval_tampering: true, provenance_complete: true },
			hidden_oracle: { passed: true, total: 1, failed: [] }, regressions: { passed: true, total: 1, failed: [] },
			static_analysis: { passed: true, findings: [] }, semantic_checks: { passed: true, total: 1, failed: [] },
			security_policy: { passed: true, findings: [] }, bundle_hash: "3".repeat(64), evaluated_at: "2026-10-14T00:01:00Z", tainted: false,
		};
		const verdict: VerdictRecord = { state: "ACCEPT", candidate_shas: ["winner"], evidence_hashes: [evalBundle.bundle_hash], reasons: ["passed"], policy_hash: "4".repeat(64), selector_policy_version: "seam-policy/0.1.0", timestamp: "2026-10-14T00:02:00Z", winner_sha: "winner" };
		const permit: PermitRecord = { permit_id: "5".repeat(64), task_hash: task.task_hash, baseline_commit: "base", winner_candidate_sha: "winner", contender_id: "c1", winning_tree_sha256: evalBundle.tree_sha256, evaluation_bundle_hash: evalBundle.bundle_hash, selector_policy_hash: verdict.policy_hash, destination_repo: "default/repo", expected_destination_head: "base", nonce: "SECRET-NONCE-MUST-NOT-RENDER", issued_at: "2026-10-14T00:03:00Z", consumed: true, consumed_at: "2026-10-14T00:04:00Z" };
		state.evaluations.winner = evalBundle;
		state.verdicts.push(verdict);
		state.permits[permit.permit_id] = permit;
		const projection = await projectCanonicality(state);
		assert.equal(projection.target_sha, "winner");
		assert.equal(projection.canoncaps.length, 1);
		assert.ok(projection.causal_proof);
		const html = renderCanonicalityPanel(projection);
		assert.match(html, /Canonicality is a capability/);
		assert.match(html, /Causal Proof Graph/);
		assert.doesNotMatch(html, /SECRET-NONCE/);
	});
});
