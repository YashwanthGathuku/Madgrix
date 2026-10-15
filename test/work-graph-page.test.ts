/**
 * The task graph page prints stored authority state and does not classify it.
 * node --test test/work-graph-page.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifyPair } from "../src/lib/claims.ts";
import { createAuthority } from "../src/lib/task-state.ts";
import type { AuthorityState, ConflictRisk, EvaluationBundle, PermitRecord, WorkClaim } from "../src/lib/types.ts";
import { buildWorkGraph } from "../src/lib/work-graph.ts";
import type { PromotionBundle } from "../src/lib/attestation.ts";
import { renderWorkGraphPage } from "../src/worker/work-graph-page.ts";

const TOKEN_ID = "token-id-must-stay-off-the-page";
const NONCE = "nonce-secret-value";
const HIDDEN_FAILURE = "hidden-oracle-case-9";
const FINDING = "finding-secret-path";
const SIGNATURE = "sig-secret-value";
const KEY = "abcdef1234567890extra";

function claim(overrides: Partial<WorkClaim> & { work_id: string; agent: string }): WorkClaim {
	return {
		task: "taskhash-abc",
		baseline: "baseline-sha",
		intent: { behavior: ["task intent"] },
		scope: { paths: ["src/x/**"], symbols: [] },
		contracts: { reads: [], modifies: [] },
		interfaces: [],
		schema_changes: [],
		expected_tests: [],
		lease: { claimed_at: "2026-10-06T12:00:00Z", expires_at: "2026-10-06T13:00:00Z" },
		status: "claimed",
		version: 1,
		agent_secret_sha256: "agent-secret-hash-must-stay-off-the-page",
		...overrides,
	};
}

function bundle(sha: string, overrides: Partial<EvaluationBundle> = {}): EvaluationBundle {
	return {
		candidate_sha: sha,
		tree_sha256: "tree-resolved",
		contender_id: "contender-demo",
		task_hash: "taskhash-abc",
		admission: {
			exact_baseline: true,
			scope_compliance: false,
			valid_tool_states: true,
			no_eval_tampering: true,
			provenance_complete: true,
		},
		hidden_oracle: { passed: false, total: 4, failed: [HIDDEN_FAILURE] },
		regressions: { passed: true, total: 3, failed: [] },
		static_analysis: { passed: true, findings: [] },
		semantic_checks: { passed: true, total: 1, failed: [] },
		security_policy: { passed: false, findings: [FINDING] },
		bundle_hash: `bundle-${sha}`,
		evaluated_at: "2026-10-06T12:00:00Z",
		tainted: false,
		...overrides,
	};
}

function permit(overrides: Partial<PermitRecord> = {}): PermitRecord {
	return {
		permit_id: "permit-1",
		task_hash: "taskhash-abc",
		baseline_commit: "baseline-sha",
		winner_candidate_sha: "resolved-sha",
		contender_id: "contender-demo",
		winning_tree_sha256: "tree-resolved",
		evaluation_bundle_hash: "bundle-resolved-sha",
		selector_policy_hash: "policyhash",
		destination_repo: "demo/canonical",
		expected_destination_head: "baseline-sha",
		nonce: NONCE,
		issued_at: "2026-10-06T12:00:00.000Z",
		consumed: true,
		consumed_at: "2026-10-06T12:05:00.000Z",
		...overrides,
	};
}

function promotion(commit: string): PromotionBundle {
	return {
		version: 3,
		statements: [
			{
				payloadType: "application/vnd.in-toto+json",
				payload: "e30",
				signatures: [{ keyid: "key-1", sig: SIGNATURE }],
			},
		],
		ship: {
			repo: "demo/canonical",
			commit,
			tree_sha256: "tree-resolved",
			base: "baseline-sha",
			parent: "baseline-sha",
			permit_id: "permit-1",
		},
		ledger: { head_sha256: "ledger-head", entries: [] },
		authority_pubkey_der_hex: KEY,
	};
}

function base(): AuthorityState {
	const state = createAuthority({
		task_id: "demo-task",
		task_hash: "taskhash-abc",
		intent: "compose api, ui, and an integration check <script>alert(1)</script>",
		baseline_repo: "demo/repo",
		baseline_commit: "baseline-sha",
		behavior_contract: "label is api+ui",
		policy_version: "seam-policy/0.1.0",
		frozen_at: "2026-10-06T11:00:00Z",
	});
	state.contenders["contender-demo"] = {
		contender_id: "contender-demo",
		agent_id: "parent",
		fork_repo: "fork-demo",
		fork_lineage: { parent_repo: "demo/repo", parent_commit: "baseline-sha" },
		fork_base: "baseline-sha",
		token_id: TOKEN_ID,
		token_ids: [TOKEN_ID],
		status: "forked",
		claim_work_id: null,
		latest_commit: "resolved-sha",
	};
	return state;
}

describe("work graph page", () => {
	it("prints a resolved crew from stored records and stored risk words", () => {
		const api = claim({
			work_id: "W-api",
			agent: "sub-api",
			scope: { paths: ["src/api/**", "src/contract.js"], symbols: [] },
			contracts: { reads: [], modifies: ["label"] },
		});
		const ui = claim({
			work_id: "W-ui",
			agent: "sub-ui",
			scope: { paths: ["src/ui/**", "src/contract.js"], symbols: [] },
			contracts: { reads: ["label"], modifies: [] },
		});
		const testAgent = claim({
			work_id: "W-test",
			agent: "sub-test",
			scope: { paths: ["test/integration/**"], symbols: [] },
		});
		const green = classifyPair(testAgent, api, { depMap: {} });
		const amber = classifyPair(ui, testAgent);
		const red = classifyPair(api, ui, { depMap: {} });
		assert.equal(green.risk, "GREEN");
		assert.equal(amber.risk, "AMBER");
		assert.equal(red.risk, "RED");

		const state = base();
		state.claims = [api, ui, testAgent];
		state.conflict_reports = [green, amber, red];
		state.composition = {
			status: "RESOLVED",
			contender_id: "contender-demo",
			baseline: "baseline-sha",
			agents: [
				{ id: "sub-api", role: "api", intent: "name the contract api", sha: "side-a", paths: ["src/api/**", "src/contract.js"], claim_work_id: "W-api" },
				{ id: "sub-ui", role: "ui", intent: "name the contract ui", sha: "side-b", paths: ["src/ui/**", "src/contract.js"], claim_work_id: "W-ui" },
				{ id: "sub-test", role: "test", intent: "add an integration check", sha: "side-c", paths: ["test/integration/**"], claim_work_id: "W-test" },
			],
			contributing_shas: ["side-a", "side-b", "side-c"],
			files: [
				{
					path: "src/contract.js",
					classification: "textual-line-overlap",
					sides: [
						{ agent_id: "sub-api", role: "api", intent: "name the contract api", sha: "side-a", excerpt: "export const label = \"api\";" },
						{ agent_id: "sub-ui", role: "ui", intent: "name the contract ui", sha: "side-b", excerpt: "<script>alert(1)</script>" },
					],
				},
			],
			candidate_sha: "resolved-sha",
		};
		state.evaluations = {
			"side-a": bundle("side-a"),
			"resolved-sha": bundle("resolved-sha"),
		};
		state.verdicts = [
			{
				state: "ACCEPT",
				candidate_shas: ["resolved-sha"],
				evidence_hashes: ["bundle-resolved-sha"],
				reasons: ["unique dominant candidate resolved-sha"],
				policy_hash: "policyhash",
				selector_policy_version: "seam-policy/0.1.0",
				timestamp: "2026-10-06T12:00:00.000Z",
				winner_sha: "resolved-sha",
			},
		];
		state.quarantine["other-contender"] = {
			contender_id: "other-contender",
			trigger: "eval_file_modification",
			evidence_hash: "evidence-hash",
			entered_at: "2026-10-06T12:01:00.000Z",
			status: "QUARANTINED",
			reviewed_by: null,
			review_note: null,
		};
		state.permits["permit-1"] = permit();
		state.promotion_bundles = { "permit-1": promotion("resolved-sha") };

		const html = renderWorkGraphPage(state);
		assert.match(html, /CrewContender/);
		assert.match(html, /parent <code>parent<\/code>/);
		assert.match(html, /API agent <code>sub-api<\/code>/);
		assert.match(html, /UI agent <code>sub-ui<\/code>/);
		assert.match(html, /test\/integration agent <code>sub-test<\/code>/);
		assert.match(html, /name the contract api/);
		assert.match(html, /add an integration check/);
		assert.match(html, /class="dep"/);
		assert.match(html, />baseline</);
		assert.match(html, />overlap</);
		assert.match(html, />claim-conflict</);
		assert.match(html, /Recorded risk GREEN/);
		assert.match(html, /Recorded risk AMBER/);
		assert.match(html, /Recorded risk RED/);
		assert.match(html, /L2 dependency analysis unavailable/);
		assert.doesNotMatch(html, /class="[^"]*risk-/);
		assert.match(html, /class="overlap"/);
		assert.match(html, /textual-line-overlap/);
		assert.match(html, /Member contribution SHAs/);
		assert.match(html, /New candidate/);
		assert.match(html, /id="promotable">PROMOTABLE CANDIDATE: <code>resolved-sha<\/code>/);
		assert.match(html, /side-a/);
		const parent = html.match(/<article class="agent parent">[\s\S]*?<\/article>/);
		assert.ok(parent);
		assert.doesNotMatch(parent[0], /resolved-sha/);
		assert.match(html, />ACCEPT</);
		assert.match(html, /QUARANTINED/);
		assert.match(html, /eval_file_modification/);
		assert.match(html, /<dt>Baseline<\/dt><dd><span class="pass">pass<\/span><\/dd>/);
		assert.match(html, /<dt>Scope<\/dt><dd><span class="fail">fail<\/span><\/dd>/);
		assert.match(html, /hidden oracle <span class="fail">fail<\/span> \(4 total\)/);
		assert.match(html, /Security<\/dt><dd><span class="fail">fail<\/span>/);
		assert.match(html, /Candidate SHA<\/dt><dd><code>resolved-sha<\/code>/);
		assert.match(html, /Destination head<\/dt><dd><code>baseline-sha<\/code>/);
		assert.match(html, /Permit status<\/dt><dd>consumed/);
		assert.match(html, /Authorized SHA<\/dt><dd><code>resolved-sha<\/code>/);
		assert.match(html, /Promoted SHA<\/dt><dd><code>resolved-sha<\/code>/);
		assert.match(html, /Canonical destination<\/dt><dd><code>demo\/canonical<\/code>/);
		assert.match(html, /1 of 1 envelopes include a signature field/);
		assert.match(html, /prefix <code>abcdef123456<\/code>/);
		assert.match(html, /Offline verification/);
		assert.match(html, /Not run/);
		assert.match(html, /Stored bundle. Not the promotable candidate./);
		assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
		assert.doesNotMatch(html, /<script>alert/);
		assert.doesNotMatch(html, new RegExp(TOKEN_ID));
		assert.doesNotMatch(html, new RegExp(NONCE));
		assert.doesNotMatch(html, new RegExp(HIDDEN_FAILURE));
		assert.doesNotMatch(html, new RegExp(FINDING));
		assert.doesNotMatch(html, new RegExp(SIGNATURE));
		assert.doesNotMatch(html, /7890extra/);
		assert.doesNotMatch(html, /agent-secret-hash-must-stay-off-the-page/);
		assert.doesNotMatch(html, /\bVERIFIED\b/);
		assert.doesNotMatch(html, /\bPINNED\b/);
		assert.doesNotMatch(html, /\bVALID\b/);
		assert.doesNotMatch(html, /Fixture\/demo input/);
	});

	it("a conflict with no candidate does not invent a resolver SHA or a risk edge", () => {
		const state = base();
		state.composition = {
			status: "CONFLICTED",
			contender_id: "contender-demo",
			baseline: "baseline-sha",
			agents: [
				{ id: "sub-api", role: "api", intent: "name the contract api", sha: "side-a", paths: ["src/contract.js"], claim_work_id: null },
				{ id: "sub-ui", role: "ui", intent: "name the contract ui", sha: "side-b", paths: ["src/contract.js"], claim_work_id: null },
			],
			contributing_shas: ["side-a", "side-b"],
			files: [
				{
					path: "src/contract.js",
					classification: "textual-line-overlap",
					sides: [
						{ agent_id: "sub-api", role: "api", intent: "name the contract api", sha: "side-a", excerpt: "api" },
						{ agent_id: "sub-ui", role: "ui", intent: "name the contract ui", sha: "side-b", excerpt: "ui" },
					],
				},
			],
			candidate_sha: null,
		};
		const html = renderWorkGraphPage(state);
		assert.match(html, /class="stamp">CONFLICTED</);
		assert.match(html, /class="state now">CONFLICTED/);
		assert.match(html, /Resolution state: unresolved/);
		assert.match(html, /id="promotable">PROMOTABLE CANDIDATE: NONE/);
		assert.match(html, /No conflict reports are stored/);
		assert.match(html, /No evaluation bundle is stored/);
		assert.match(html, /No verdict is recorded/);
		assert.match(html, /No permit is recorded/);
		assert.match(html, /No promotion is recorded/);
		assert.match(html, /Not run/);
		assert.doesNotMatch(html, /resolved-sha/);
		assert.doesNotMatch(html, /New candidate/);
		assert.doesNotMatch(html, /class="edge /);
		assert.doesNotMatch(html, /\bundefined\b/);
		assert.doesNotMatch(html, /\bnull\b/);
		const plate = html.slice(html.indexOf('id="promotable"'), html.indexOf('id="promotable"') + 80);
		assert.match(plate, /NONE/);
		assert.doesNotMatch(plate, /side-a/);
		assert.doesNotMatch(html, />ACCEPT</);
		assert.doesNotMatch(html, />REJECT</);
		assert.doesNotMatch(html, />ABSTAIN</);
		assert.doesNotMatch(html, />ESCALATE</);
	});

	it("does not call a contributing SHA a new candidate", () => {
		const state = base();
		state.composition = {
			status: "RESOLVED",
			contender_id: "contender-demo",
			baseline: "baseline-sha",
			agents: [
				{ id: "sub-api", role: "api", intent: "api", sha: "side-a", paths: ["src/a"], claim_work_id: null },
				{ id: "sub-ui", role: "ui", intent: "ui", sha: "side-b", paths: ["src/b"], claim_work_id: null },
			],
			contributing_shas: ["side-a", "side-b"],
			files: [],
			candidate_sha: "side-a",
		};
		const html = renderWorkGraphPage(state);
		assert.match(html, /id="promotable">PROMOTABLE CANDIDATE: NONE/);
		assert.match(html, /member contribution/);
		assert.doesNotMatch(html, /New candidate/);
		assert.doesNotMatch(html, /id="promotable">PROMOTABLE CANDIDATE: <code>side-a/);
	});

	it("escapes a risk word that is not one of the stored four", () => {
		const state = base();
		state.claims = [claim({ work_id: "W-a", agent: "sub-api" }), claim({ work_id: "W-b", agent: "sub-ui" })];
		state.conflict_reports = [
			{
				claim_a: "W-a",
				claim_b: "W-b",
				risk: 'RED"><script>alert(1)</script>' as ConflictRisk,
				layers: { text: [], symbol: [], impact: [], contract: [], state: [] },
				explanation: "injected <b>explanation</b>",
			},
		];
		const html = renderWorkGraphPage(state);
		assert.match(html, /class="dep"/);
		assert.doesNotMatch(html, /class="[^"]*RED/);
		assert.doesNotMatch(html, /<script>alert/);
		assert.match(html, /Recorded risk RED&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
		assert.match(html, /&lt;b&gt;explanation&lt;\/b&gt;/);
	});

	it("shows a fixture banner only when the caller passes one", () => {
		const state = base();
		const bare = renderWorkGraphPage(state);
		assert.doesNotMatch(bare, /Fixture\/demo input/);
		assert.match(bare, /No CrewContender is recorded/);
		assert.match(bare, /No composition is recorded/);
		assert.match(bare, /No evaluation bundle is stored/);
		assert.match(bare, /Not run/);
		assert.doesNotMatch(bare, /\bundefined\b/);
		assert.doesNotMatch(bare, /\bnull\b/);
		const html = renderWorkGraphPage(state, { fixtureBanner: "Fixture/demo input. Local git." });
		assert.match(html, /Fixture\/demo input\. Local git\./);
	});

	it("leaves the candidate empty unless the recorded state is COMPOSED or RESOLVED", () => {
		for (const status of ["PENDING", "COMPOSING", "CONFLICTED", "RESOLVING"]) {
			const state = base();
			state.composition = {
				status: status as NonNullable<AuthorityState["composition"]>["status"],
				contender_id: "contender-demo",
				baseline: "baseline-sha",
				agents: [
					{ id: "sub-api", role: "api", intent: "api", sha: "side-a", paths: ["src/a"], claim_work_id: null },
					{ id: "sub-ui", role: "ui", intent: "ui", sha: "side-b", paths: ["src/b"], claim_work_id: null },
				],
				contributing_shas: ["side-a", "side-b"],
				files: [],
				candidate_sha: "sneaky-sha",
			};
			const html = renderWorkGraphPage(state);
			assert.match(html, new RegExp(`class="stamp">${status}`));
			assert.match(html, /id="promotable">PROMOTABLE CANDIDATE: NONE/);
			assert.doesNotMatch(html, /sneaky-sha/);
			assert.doesNotMatch(html, /New candidate/);
		}

		const composed = base();
		composed.composition = {
			status: "COMPOSED",
			contender_id: "contender-demo",
			baseline: "baseline-sha",
			agents: [
				{ id: "sub-api", role: "api", intent: "api", sha: "side-a", paths: ["src/a"], claim_work_id: null },
				{ id: "sub-ui", role: "ui", intent: "ui", sha: "side-b", paths: ["src/b"], claim_work_id: null },
			],
			contributing_shas: ["side-a", "side-b"],
			files: [],
			candidate_sha: "composed-sha",
		};
		const composedHtml = renderWorkGraphPage(composed);
		assert.match(composedHtml, /id="promotable">PROMOTABLE CANDIDATE: <code>composed-sha<\/code>/);
		assert.match(composedHtml, /Resolution state: COMPOSED/);
		assert.doesNotMatch(composedHtml, /New candidate/);
	});

	it("prints the canonical work graph and does not show a member SHA as the candidate", () => {
		const stored = base();
		stored.task = { ...stored.task, intent: "stored intent" };
		stored.composition = {
			status: "CONFLICTED",
			contender_id: "contender-demo",
			baseline: "baseline-sha",
			agents: [
				{ id: "sub-api", role: "api", intent: "stored intent", sha: "side-a", paths: ["src/contract.js"], claim_work_id: null },
				{ id: "sub-ui", role: "ui", intent: "stored ui", sha: "side-b", paths: ["src/contract.js"], claim_work_id: null },
			],
			contributing_shas: ["side-a", "side-b"],
			files: [],
			candidate_sha: null,
		};
		const resolved = base();
		resolved.task = { ...resolved.task, intent: "graph intent" };
		resolved.composition = {
			status: "RESOLVED",
			contender_id: "contender-demo",
			baseline: "baseline-sha",
			agents: [
				{ id: "sub-api", role: "api", intent: "from graph", sha: "side-a", paths: ["src/contract.js"], claim_work_id: "W-api" },
				{ id: "sub-ui", role: "ui", intent: "ui", sha: "side-b", paths: ["src/contract.js"], claim_work_id: null },
			],
			contributing_shas: ["side-a", "side-b"],
			files: [
				{
					path: "src/contract.js",
					classification: "textual-line-overlap",
					sides: [
						{ agent_id: "sub-api", role: "api", intent: "from graph", sha: "side-a", excerpt: "api" },
						{ agent_id: "sub-ui", role: "ui", intent: "ui", sha: "side-b", excerpt: "ui" },
					],
				},
			],
			candidate_sha: "graph-sha",
		};
		const graph = buildWorkGraph(resolved);
		assert.equal(graph.candidate_sha, "graph-sha");
		assert.equal(graph.composition_state, "RESOLVED");
		const shown = renderWorkGraphPage(stored, { graph });
		assert.match(shown, /<h1>graph intent<\/h1>/);
		assert.match(shown, /class="stamp">RESOLVED/);
		assert.match(shown, /id="promotable">PROMOTABLE CANDIDATE: <code>graph-sha<\/code>/);
		assert.match(shown, /New candidate/);
		assert.match(shown, /from graph/);
		assert.match(shown, /side-a/);
		assert.doesNotMatch(shown, /class="stamp">CONFLICTED/);

		const illegal = base();
		illegal.composition = {
			status: "RESOLVED",
			contender_id: "contender-demo",
			baseline: "baseline-sha",
			agents: [
				{ id: "sub-api", role: "api", intent: "api", sha: "side-a", paths: ["src/a"], claim_work_id: null },
				{ id: "sub-ui", role: "ui", intent: "ui", sha: "side-b", paths: ["src/b"], claim_work_id: null },
			],
			contributing_shas: ["side-a", "side-b"],
			files: [],
			candidate_sha: "side-a",
		};
		const hiddenGraph = buildWorkGraph(illegal);
		assert.equal(hiddenGraph.candidate_sha, null);
		assert.equal(hiddenGraph.crew?.candidate_sha, null);
		const hidden = renderWorkGraphPage(illegal, { graph: hiddenGraph });
		assert.match(hidden, /id="promotable">PROMOTABLE CANDIDATE: NONE/);
		assert.match(hidden, /member contribution/);
		assert.match(hidden, /Member contribution SHAs/);
		assert.match(hidden, /side-a/);
		assert.doesNotMatch(hidden, /New candidate/);
		assert.doesNotMatch(hidden, /id="promotable">PROMOTABLE CANDIDATE: <code>side-a/);
	});
});
