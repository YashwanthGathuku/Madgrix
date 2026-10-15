import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createAuthority } from "../src/lib/task-state.ts";
import type { AuthorityState, EvaluationBundle, WorkClaim } from "../src/lib/types.ts";
import { renderWorkGraphPage } from "../src/worker/work-graph-page.ts";
import type { PromotionBundle } from "../src/lib/attestation.ts";

function base(): AuthorityState {
	return createAuthority({
		task_id: "mission-task",
		task_hash: "task-hash",
		intent: "coordinate autonomous agents without letting unverified state become canonical",
		baseline_repo: "demo/canonical",
		baseline_commit: "base-sha",
		behavior_contract: "only the exact authorized state may ship",
		policy_version: "seam-policy/0.1.0",
		frozen_at: "2026-10-14T20:00:00Z",
	});
}

function claim(workId: string, agent: string, paths: string[]): WorkClaim {
	return {
		work_id: workId,
		agent,
		task: "task-hash",
		baseline: "base-sha",
		intent: { behavior: [`${agent} behavior`] },
		scope: { paths, symbols: [] },
		contracts: { reads: [], modifies: [] },
		interfaces: [],
		schema_changes: [],
		expected_tests: [],
		lease: { claimed_at: "2026-10-14T20:00:00Z", expires_at: "2026-10-15T02:00:00Z" },
		status: "active",
		version: 1,
	};
}

function evaluation(sha: string): EvaluationBundle {
	return {
		candidate_sha: sha,
		tree_sha256: "tree-candidate",
		contender_id: "contender-1",
		task_hash: "task-hash",
		admission: {
			exact_baseline: true,
			scope_compliance: true,
			valid_tool_states: true,
			no_eval_tampering: true,
			provenance_complete: true,
		},
		hidden_oracle: { passed: true, total: 4, failed: [] },
		regressions: { passed: true, total: 8, failed: [] },
		static_analysis: { passed: true, findings: [] },
		semantic_checks: { passed: true, total: 3, failed: [] },
		security_policy: { passed: true, findings: [] },
		bundle_hash: "eval-hash",
		evaluated_at: "2026-10-14T20:30:00Z",
		tainted: false,
	};
}

function promotion(): PromotionBundle {
	return {
		version: 3,
		statements: [],
		ship: {
			repo: "demo/canonical",
			commit: "candidate-sha",
			tree_sha256: "tree-candidate",
			base: "base-sha",
			parent: "base-sha",
			permit_id: "permit-1",
		},
		ledger: { head_sha256: "ledger-head", entries: [] },
		authority_pubkey_der_hex: "abcdef1234567890",
	};
}

describe("MADGRIX Mission Control", () => {
	it("derives semantic clearance from stored WorkClaims and conflict reports without granting authority", () => {
		const state = base();
		state.claims = [
			claim("W-api", "api-agent", ["src/api/**"]),
			claim("W-ui", "ui-agent", ["src/ui/**"]),
			claim("W-docs", "docs-agent", ["docs/**"]),
		];
		state.conflict_reports = [
			{
				claim_a: "W-api",
				claim_b: "W-ui",
				risk: "RED",
				layers: { text: [], symbol: [], impact: [], contract: ["AuthState"], state: [] },
				explanation: "API modifies AuthState while UI reads the same contract",
			},
		];

		const html = renderWorkGraphPage(state);
		assert.match(html, /MADGRIX Mission Control/);
		assert.match(html, /Semantic clearance/);
		assert.match(html, /api-agent <code>W-api<\/code>/);
		assert.match(html, /ui-agent <code>W-ui<\/code>/);
		assert.match(html, /docs-agent <code>W-docs<\/code>/);
		assert.equal((html.match(/class="clearance-state">HOLD/g) ?? []).length, 2);
		assert.equal((html.match(/class="clearance-state">CLEAR/g) ?? []).length, 1);
		assert.match(html, /contract: AuthState/);
		assert.match(html, /Read-only projection of stored WorkClaims and conflict reports/);
	});

	it("shows blind-verifier progress but never exposes signatures, keys, reasons, or candidate-to-SHA mapping", () => {
		const state = base();
		state.verifier_keys["security-reviewer"] = {
			verifier_id: "security-reviewer",
			keyid: "key-id-secret",
			public_key_der_hex: "public-key-secret",
		};
		state.verifier_commitments["security-reviewer"] = {
			verifier_id: "security-reviewer",
			task_hash: "task-hash",
			policy_version: "seam-policy/0.1.0",
			commitment: "commitment-secret",
			committed_at: "2026-10-14T20:01:00Z",
		};
		state.verifier_reveals["security-reviewer"] = {
			expected_behavior: ["secret expected behavior"],
			invariants: [],
			likely_failure_modes: [],
			evaluation_plan: [],
			security_expectations: [],
		};
		state.verdict_reports.push({
			verifier_id: "security-reviewer",
			candidate_label: "candidate-blind-7",
			verdict: "accept",
			reasons: ["private reviewer reason"],
			signature: "signature-secret",
			keyid: "key-id-secret",
		});
		state.candidate_labels["candidate-blind-7"] = "candidate-real-sha-secret";

		const html = renderWorkGraphPage(state);
		assert.match(html, /Blind verifier board/);
		assert.match(html, /security-reviewer/);
		assert.match(html, /committed/);
		assert.match(html, /revealed/);
		assert.match(html, />accept</);
		assert.match(html, /candidate-blind-7/);
		assert.doesNotMatch(html, /signature-secret/);
		assert.doesNotMatch(html, /key-id-secret/);
		assert.doesNotMatch(html, /public-key-secret/);
		assert.doesNotMatch(html, /commitment-secret/);
		assert.doesNotMatch(html, /private reviewer reason/);
		assert.doesNotMatch(html, /secret expected behavior/);
		assert.doesNotMatch(html, /candidate-real-sha-secret/);
	});

	it("explains an exact canonical promotion only from stored authority records", () => {
		const state = base();
		state.contenders["contender-1"] = {
			contender_id: "contender-1",
			agent_id: "api-agent",
			fork_repo: "demo/fork-1",
			fork_lineage: { parent_repo: "demo/canonical", parent_commit: "base-sha" },
			token_id: "token-secret",
			status: "submitted",
			claim_work_id: null,
			latest_commit: "candidate-sha",
			fork_base: "base-sha",
		};
		state.evaluations["candidate-sha"] = evaluation("candidate-sha");
		state.verdicts.push({
			state: "ACCEPT",
			candidate_shas: ["candidate-sha"],
			evidence_hashes: ["eval-hash"],
			reasons: ["all non-compensatory gates passed"],
			policy_hash: "policy-hash",
			selector_policy_version: "seam-policy/0.1.0",
			timestamp: "2026-10-14T20:31:00Z",
			winner_sha: "candidate-sha",
		});
		state.permits["permit-1"] = {
			permit_id: "permit-1",
			task_hash: "task-hash",
			baseline_commit: "base-sha",
			winner_candidate_sha: "candidate-sha",
			contender_id: "contender-1",
			winning_tree_sha256: "tree-candidate",
			evaluation_bundle_hash: "eval-hash",
			selector_policy_hash: "policy-hash",
			destination_repo: "demo/canonical",
			expected_destination_head: "base-sha",
			nonce: "permit-nonce-secret",
			issued_at: "2026-10-14T20:32:00Z",
			consumed: true,
			consumed_at: "2026-10-14T20:33:00Z",
		};
		state.promotion_bundles = { "permit-1": promotion() };

		const html = renderWorkGraphPage(state);
		assert.match(html, /Why canonical\?/);
		assert.match(html, /EXACT STATE MATCH/);
		assert.match(html, /WHAT WAS AUTHORIZED = WHAT WAS SHIPPED/);
		assert.match(html, /Evidence binding<\/dt><dd>MATCH/);
		assert.match(html, /Destination-head binding<\/dt><dd>MATCH/);
		assert.match(html, /Producer<\/dt><dd><code>api-agent<\/code> via <code>contender-1<\/code>/);
		assert.doesNotMatch(html, /token-secret/);
		assert.doesNotMatch(html, /permit-nonce-secret/);
	});

	it("does not invent a canonical answer before promotion", () => {
		const state = base();
		state.evaluations["candidate-sha"] = evaluation("candidate-sha");
		const html = renderWorkGraphPage(state);
		assert.match(html, /Why canonical\?/);
		assert.match(html, /No canonical promotion is recorded for this task/);
		assert.doesNotMatch(html, /EXACT STATE MATCH/);
		assert.doesNotMatch(html, /WHAT WAS AUTHORIZED = WHAT WAS SHIPPED/);
	});
});
