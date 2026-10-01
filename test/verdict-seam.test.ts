/**
 * Tests for the verdict seam (spec 1 §9).
 * Includes the anti-compensation test: a security failure MUST NOT be
 * outweighed by perfect everything else.
 * node --test test/verdict-seam.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, sha256Hex } from "../src/lib/canonical.ts";
import {
	dominanceRank,
	eligibility,
	runVerdict,
	tallyVotes,
	type RankedCandidate,
} from "../src/lib/verdict-seam.ts";
import type { AdmissionGates, EvaluationBundle, VerdictReport } from "../src/lib/types.ts";

const GATES_OK: AdmissionGates = {
	exact_baseline: true,
	scope_compliance: true,
	valid_tool_states: true,
	no_eval_tampering: true,
	provenance_complete: true,
};

async function makeBundle(overrides: Partial<EvaluationBundle> = {}): Promise<EvaluationBundle> {
	const base = {
		candidate_sha: "sha-a",
		tree_sha256: "tree-a",
		contender_id: "contender-1",
		task_hash: "taskhash-abc",
		admission: { ...GATES_OK },
		hidden_oracle: { passed: true, total: 2, failed: [] as string[] },
		regressions: { passed: true, total: 5, failed: [] as string[] },
		static_analysis: { passed: true, findings: [] as string[] },
		semantic_checks: { passed: true, total: 1, failed: [] as string[] },
		security_policy: { passed: true, findings: [] as string[] },
		evaluated_at: "2026-10-01T18:00:00Z",
		tainted: false,
		...overrides,
	};
	const { bundle_hash: _h, ...rest } = base as EvaluationBundle & { bundle_hash?: string };
	const bundle_hash = await sha256Hex(canonicalJson(rest));
	return { ...(rest as EvaluationBundle), bundle_hash };
}

function candidate(overrides: Partial<RankedCandidate> & { bundle: EvaluationBundle }): RankedCandidate {
	return {
		contender_id: "contender-1",
		candidate_sha: overrides.bundle.candidate_sha,
		tree_sha256: overrides.bundle.tree_sha256,
		blast_radius: 1,
		change_surface: 1,
		...overrides,
	};
}

function report(verifier_id: string, candidate_sha: string, verdict: "accept" | "reject" | "abstain"): VerdictReport {
	// NOTE: signature/admissibility is enforced by the task authority
	// (commit-reveal) before reports reach the seam; tallyVotes assumes
	// only admissible reports are passed in.
	return {
		verifier_id,
		candidate_label: candidate_sha, // caller maps anonymized label → sha
		verdict,
		reasons: [`${verdict} by ${verifier_id}`],
		signature: "sig",
		keyid: "key",
	};
}

const BASE_INPUT = {
	quarantinedContenderIds: [] as string[],
	policyHash: "policyhash",
	policyVersion: "seam-policy/0.1.0",
	now: "2026-10-01T19:00:00Z",
	sha256Hex,
};

describe("eligibility", () => {
	it("eligible when all gates pass and the bundle hash recomputes", async () => {
		const b = await makeBundle();
		assert.deepEqual(await eligibility(b, sha256Hex), { eligible: true, failed: [] });
	});

	it("bundle_hash mismatch → ineligible", async () => {
		const b = await makeBundle();
		b.bundle_hash = "0".repeat(64);
		const r = await eligibility(b, sha256Hex);
		assert.equal(r.eligible, false);
		assert.deepEqual(r.failed, ["evaluation_bundle_hash mismatch"]);
	});

	it("each failed gate is named", async () => {
		const cases: [keyof AdmissionGates, string][] = [
			["exact_baseline", "baseline_valid"],
			["scope_compliance", "scope_valid"],
			["no_eval_tampering", "evaluation_integrity_valid"],
			["provenance_complete", "provenance_valid"],
			["valid_tool_states", "provenance_valid"],
		];
		for (const [gate, name] of cases) {
			const b = await makeBundle({ admission: { ...GATES_OK, [gate]: false } });
			const r = await eligibility(b, sha256Hex);
			assert.equal(r.eligible, false, gate);
			assert.ok(r.failed.includes(name), `${gate} → ${name}`);
		}
		const b = await makeBundle({ hidden_oracle: { passed: false, total: 2, failed: ["h1"] } });
		assert.ok((await eligibility(b, sha256Hex)).failed.includes("required_tests_pass"));
		const b2 = await makeBundle({ security_policy: { passed: false, findings: ["secret"] } });
		assert.ok((await eligibility(b2, sha256Hex)).failed.includes("policy_valid"));
	});
});

describe("runVerdict", () => {
	it("ANTI-COMPENSATION: security failure + perfect everything else → REJECT", async () => {
		// The forbidden construction would pass this candidate on weighted
		// totals. The seam must REJECT it: policy_valid is non-compensatory.
		const b = await makeBundle({
			security_policy: { passed: false, findings: ["hardcoded secret"] },
		});
		const r = await runVerdict({
			...BASE_INPUT,
			candidates: [candidate({ bundle: b })],
			reports: [],
		});
		assert.equal(r.state, "REJECT");
		assert.equal(r.winner_sha, null);
		assert.match(r.reasons.join(" "), /policy_valid/);
	});

	it("ANTI-COMPENSATION (vicious): ineligible candidate dominating every secondary + winning the verifier vote still loses", async () => {
		// Candidate A: failed MANDATORY gates (security_policy failed AND
		// no_eval_tampering false) but PERFECT secondaries — hidden oracle
		// 10/10, zero blast radius, minimal change surface — plus a
		// unanimous 3-verifier accept. A weighted/compensation scheme would
		// crown A by a landslide.
		const a = await makeBundle({
			candidate_sha: "sha-a",
			tree_sha256: "tree-a",
			contender_id: "contender-a",
			admission: { ...GATES_OK, no_eval_tampering: false },
			security_policy: { passed: false, findings: ["hardcoded secret"] },
			hidden_oracle: { passed: true, total: 10, failed: [] as string[] },
		});
		// Candidate B: eligible, but weak — barely-passing hidden oracle
		// (6/10), huge blast radius, large change surface, no verifier
		// reports at all.
		const b = await makeBundle({
			candidate_sha: "sha-b",
			tree_sha256: "tree-b",
			contender_id: "contender-b",
			hidden_oracle: { passed: true, total: 10, failed: ["h1", "h2", "h3", "h4"] },
		});
		const aElig = await eligibility(a, sha256Hex);
		assert.equal(aElig.eligible, false, "A must be ineligible");
		assert.ok(aElig.failed.includes("policy_valid"), "A must fail policy_valid");
		assert.ok(
			aElig.failed.includes("evaluation_integrity_valid"),
			"A must fail evaluation_integrity_valid",
		);
		const r = await runVerdict({
			...BASE_INPUT,
			candidates: [
				candidate({ bundle: a, contender_id: "contender-a", blast_radius: 0, change_surface: 1 }),
				candidate({ bundle: b, contender_id: "contender-b", blast_radius: 9, change_surface: 15 }),
			],
			reports: [
				report("v1", "sha-a", "accept"),
				report("v2", "sha-a", "accept"),
				report("v3", "sha-a", "accept"),
			],
		});
		// A is ineligible: its perfect secondaries and its 3 verifier
		// accepts count for NOTHING. B — eligible, weakest possible — wins.
		assert.equal(r.state, "ACCEPT");
		assert.equal(r.winner_sha, "sha-b", "the eligible-but-weak candidate must win; no compensation");
	});

	it("no eligible candidate → REJECT with per-candidate gate reasons", async () => {
		const b = await makeBundle({ admission: { ...GATES_OK, exact_baseline: false } });
		const r = await runVerdict({ ...BASE_INPUT, candidates: [candidate({ bundle: b })], reports: [] });
		assert.equal(r.state, "REJECT");
		assert.match(r.reasons.join(" "), /baseline_valid/);
	});

	it("unique dominant candidate → ACCEPT", async () => {
		const better = await makeBundle({ candidate_sha: "sha-better", tree_sha256: "tree-better" });
		const worse = await makeBundle({
			candidate_sha: "sha-worse",
			tree_sha256: "tree-worse",
			contender_id: "contender-2",
		});
		const r = await runVerdict({
			...BASE_INPUT,
			candidates: [
				candidate({ bundle: better, blast_radius: 1, change_surface: 1 }),
				candidate({
					bundle: worse,
					contender_id: "contender-2",
					blast_radius: 5,
					change_surface: 9,
				}),
			],
			reports: [],
		});
		assert.equal(r.state, "ACCEPT");
		assert.equal(r.winner_sha, "sha-better");
		assert.match(r.reasons.join(" "), /dominant/i);
	});

	it("no unique dominant + 2-of-3 verifier majority → ACCEPT", async () => {
		// Identical dimensions: neither dominates the other.
		const a = await makeBundle({ candidate_sha: "sha-a", tree_sha256: "tree-a" });
		const b = await makeBundle({
			candidate_sha: "sha-b",
			tree_sha256: "tree-b",
			contender_id: "contender-2",
		});
		const r = await runVerdict({
			...BASE_INPUT,
			candidates: [candidate({ bundle: a }), candidate({ bundle: b, contender_id: "contender-2" })],
			reports: [
				report("v-correctness", "sha-a", "accept"),
				report("v-security", "sha-a", "accept"),
				report("v-minimality", "sha-b", "abstain"),
			],
		});
		assert.equal(r.state, "ACCEPT");
		assert.equal(r.winner_sha, "sha-a");
	});

	it("conflicting admissible evidence (accept + reject on one candidate) → ESCALATE", async () => {
		const a = await makeBundle({ candidate_sha: "sha-a", tree_sha256: "tree-a" });
		const b = await makeBundle({
			candidate_sha: "sha-b",
			tree_sha256: "tree-b",
			contender_id: "contender-2",
		});
		const r = await runVerdict({
			...BASE_INPUT,
			candidates: [candidate({ bundle: a }), candidate({ bundle: b, contender_id: "contender-2" })],
			reports: [
				report("v-correctness", "sha-a", "accept"),
				report("v-security", "sha-a", "reject"),
			],
		});
		assert.equal(r.state, "ESCALATE");
		assert.equal(r.winner_sha, null);
		assert.match(r.reasons.join(" "), /BLOCKED/);
	});

	it("indistinguishable candidates, no majority → ABSTAIN (never a coin flip)", async () => {
		const a = await makeBundle({ candidate_sha: "sha-a", tree_sha256: "tree-a" });
		const b = await makeBundle({
			candidate_sha: "sha-b",
			tree_sha256: "tree-b",
			contender_id: "contender-2",
		});
		const r = await runVerdict({
			...BASE_INPUT,
			candidates: [candidate({ bundle: a }), candidate({ bundle: b, contender_id: "contender-2" })],
			reports: [],
		});
		assert.equal(r.state, "ABSTAIN");
		assert.equal(r.winner_sha, null);
	});

	it("quarantined contenders are excluded from selection", async () => {
		const a = await makeBundle({ candidate_sha: "sha-a", tree_sha256: "tree-a" });
		const r = await runVerdict({
			...BASE_INPUT,
			quarantinedContenderIds: ["contender-1"],
			candidates: [candidate({ bundle: a })],
			reports: [],
		});
		assert.equal(r.state, "REJECT");
		assert.match(r.reasons.join(" "), /quarantined|no candidates/i);
	});
});

describe("dominanceRank", () => {
	it("frontier = non-dominated set", async () => {
		const a = await makeBundle({ candidate_sha: "sha-a", tree_sha256: "tree-a" });
		const b = await makeBundle({ candidate_sha: "sha-b", tree_sha256: "tree-b" });
		const ca = candidate({ bundle: a, blast_radius: 1, change_surface: 5 });
		const cb = candidate({ bundle: b, blast_radius: 5, change_surface: 1 });
		const { dominant, frontier } = dominanceRank([ca, cb]);
		assert.equal(dominant, null); // trade-off: neither dominates
		assert.equal(frontier.length, 2);
	});
});

describe("tallyVotes", () => {
	it("counts accepts/rejects/abstains per sha; ignores unknown labels", () => {
		const t = tallyVotes(
			[
				report("v1", "sha-a", "accept"),
				report("v2", "sha-a", "reject"),
				report("v3", "sha-b", "abstain"),
				report("v4", "sha-ghost", "accept"),
			],
			["sha-a", "sha-b"],
		);
		assert.deepEqual(t["sha-a"], { accepts: 1, rejects: 1, abstains: 0 });
		assert.deepEqual(t["sha-b"], { accepts: 0, rejects: 0, abstains: 1 });
	});
});
