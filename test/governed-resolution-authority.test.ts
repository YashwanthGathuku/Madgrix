/**
 * Governed resolution, authority side (specs/amendments/governed-resolution-v1.md §5–§6):
 * the capsule a conflict gets, what a RESOLVED record must bind, which
 * witness verdicts can be recorded, the RED/BLOCKED rule for COMPOSED, and the
 * resolution line of offline verify on a real signed promotion bundle.
 * node --test test/governed-resolution-authority.test.ts
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { verifyBundle, type PromotionBundle } from "../src/lib/attestation.ts";
import { canonicalJson, sha256Hex } from "../src/lib/canonical.ts";
import { buildCausalProofGraph } from "../src/lib/causal-proof.ts";
import { buildConflictCapsuleV2 } from "../src/lib/conflict-capsule.ts";
import { assumeCompleteMergeArtifactScan } from "../src/lib/merge-artifacts.ts";
import { resolutionPayload } from "../src/lib/resolution-authority.ts";
import { createEd25519Signer } from "../src/lib/signer-node.ts";
import {
	attemptPromotion,
	createAuthority,
	issuePermit,
	recordComposition,
	recordPromotionBundle,
	runVerdictSeam,
	submitEvaluation,
	type Ctx,
} from "../src/lib/task-state.ts";
import type { AuthorityState, CompositionRecord, CompositionResolution, EvaluationBundle } from "../src/lib/types.ts";

const BASELINE = "base123";
const SIDE_A = "side-a";
const SIDE_B = "side-b";
const RESOLVED = "resolved-sha";
const MANIFEST = "d".repeat(64);

function makeCtx(): Ctx {
	return {
		now: () => "2026-10-18T12:00:00.000Z",
		randomHex: (n: number) => "e".repeat(n * 2),
		sha256Hex,
		selectorPolicyHash: "policyhash",
		// Unit tests of other authority rules over synthetic SHAs: the admission
		// proof itself is covered in resolution-hardening-v3/v4 with a real key.
		insecureUnpinnedWitnessRunner: true,
		policyVersion: "seam-policy/0.1.0",
	};
}

function conflicted(overrides: Partial<CompositionRecord> = {}): CompositionRecord {
	return {
		status: "CONFLICTED",
		contender_id: "contender-1",
		baseline: BASELINE,
		agents: [
			{ id: "sub-api", role: "api", intent: "include api", sha: SIDE_A, paths: ["src/label.js"], claim_work_id: "W-api" },
			{ id: "sub-ui", role: "ui", intent: "include ui", sha: SIDE_B, paths: ["src/label.js"], claim_work_id: "W-ui" },
		],
		contributing_shas: [SIDE_A, SIDE_B],
		files: [
			{
				path: "src/label.js",
				classification: "textual-line-overlap",
				sides: [
					{ agent_id: "sub-api", role: "api", intent: "include api", sha: SIDE_A, excerpt: 'export const label = "api";' },
					{ agent_id: "sub-ui", role: "ui", intent: "include ui", sha: SIDE_B, excerpt: 'export const label = "ui";' },
				],
				hunks: [
					{
						index: 0,
						base_sha256: "1".repeat(64),
						sides: [
							{ agent_id: "sub-api", sha256: "2".repeat(64) },
							{ agent_id: "sub-ui", sha256: "3".repeat(64) },
						],
					},
				],
			},
		],
		candidate_sha: null,
		witness_manifest_sha256: MANIFEST,
		...overrides,
	};
}

function observed(sha: string): AuthorityState {
	const state = createAuthority({
		task_id: "task-1",
		task_hash: "taskhash-abc",
		intent: "resolve two agents",
		baseline_repo: "acme/api",
		baseline_commit: BASELINE,
		behavior_contract: "both intents hold",
		policy_version: "seam-policy/0.1.0",
		frozen_at: "2026-10-18T11:00:00Z",
	});
	state.contenders["contender-1"] = {
		contender_id: "contender-1",
		agent_id: "agent-1",
		fork_repo: "fork-1",
		fork_lineage: { parent_repo: "acme/api", parent_commit: BASELINE },
		fork_base: BASELINE,
		token_id: "tok-1",
		status: "forked",
		claim_work_id: null,
		latest_commit: sha,
	};
	return state;
}

function resolution(state: AuthorityState, overrides: Partial<CompositionResolution> = {}): CompositionResolution {
	return {
		format: "madgrix-resolution/v1",
		capsule_id: state.composition?.capsule_id as string,
		resolver_id: "replay:llm",
		rung: "replay",
		order_agreement: "identical",
		lease: { paths: ["src/label.js"], precomposed_tree: "a".repeat(40) },
		witness: { witness_manifest_sha256: MANIFEST, witness_report_sha256: "b".repeat(64), verdict: "ADMIT", review_cleared_by: null },
		...overrides,
	};
}

function resolved(state: AuthorityState, overrides: Partial<CompositionResolution> = {}): CompositionRecord {
	return conflicted({ status: "RESOLVED", candidate_sha: RESOLVED, resolution: resolution(state, overrides) });
}

async function makeBundle(overrides: Partial<EvaluationBundle> = {}): Promise<EvaluationBundle> {
	const base = {
		candidate_sha: RESOLVED,
		tree_sha256: "tree-resolved",
		contender_id: "contender-1",
		task_hash: "taskhash-abc",
		admission: {
			exact_baseline: true,
			scope_compliance: true,
			valid_tool_states: true,
			no_eval_tampering: true,
			provenance_complete: true,
		},
		hidden_oracle: { passed: true, total: 2, failed: [] as string[] },
		regressions: { passed: true, total: 5, failed: [] as string[] },
		static_analysis: { passed: true, findings: [] as string[] },
		semantic_checks: { passed: true, total: 1, failed: [] as string[] },
		security_policy: { passed: true, findings: [] as string[] },
		evaluated_at: "2026-10-18T12:00:00Z",
		tainted: false,
		...overrides,
	};
	const scanned = assumeCompleteMergeArtifactScan(base);
	return { ...(scanned as EvaluationBundle), bundle_hash: await sha256Hex(canonicalJson(scanned)) };
}

describe("conflict capsule v2", () => {
	it("the authority computes the capsule id from the conflict it records, and refuses a supplied id that disagrees", async () => {
		const ctx = makeCtx();
		const state = await recordComposition(observed(SIDE_A), conflicted(), ctx);
		const expected = await buildConflictCapsuleV2("taskhash-abc", state.composition as CompositionRecord);
		assert.equal(state.composition?.capsule_id, expected.capsule_id);
		assert.equal(expected.witness_manifest_sha256, MANIFEST);
		assert.equal(expected.conflicts[0].lease, "hunk");
		assert.equal(expected.conflicts[0].hunks.length, 1);
		// Same conflict, same id.
		const again = await recordComposition(observed(SIDE_A), conflicted(), ctx);
		assert.equal(again.composition?.capsule_id, expected.capsule_id);
		// Another frozen witness manifest is another capsule.
		const other = await recordComposition(observed(SIDE_A), conflicted({ witness_manifest_sha256: "f".repeat(64) }), ctx);
		assert.notEqual(other.composition?.capsule_id, expected.capsule_id);
		await assert.rejects(
			recordComposition(observed(SIDE_A), conflicted({ capsule_id: "0".repeat(64) }), ctx),
			/supplied capsule_id is not this conflict's capsule/,
		);
	});
});

describe("RESOLVED binding", () => {
	it("needs a recorded conflict and a resolution bound to that conflict's capsule and frozen witnesses", async () => {
		const ctx = makeCtx();
		await assert.rejects(
			recordComposition(observed(SIDE_A), conflicted({ status: "RESOLVED", candidate_sha: RESOLVED }), ctx),
			/RESOLVED must follow a recorded CONFLICTED composition/,
		);
		const state = await recordComposition(observed(SIDE_A), conflicted(), ctx);
		await assert.rejects(recordComposition(state, conflicted({ status: "RESOLVED", candidate_sha: RESOLVED }), ctx), /requires a resolution block/);
		await assert.rejects(recordComposition(state, resolved(state, { capsule_id: "9".repeat(64) }), ctx), /answers another conflict capsule/);
		await assert.rejects(
			recordComposition(state, resolved(state, { witness: { ...resolution(state).witness, witness_manifest_sha256: "f".repeat(64) } }), ctx),
			/another witness manifest/,
		);
		await assert.rejects(
			recordComposition(state, resolved(state, { lease: { paths: ["src/other.js"], precomposed_tree: "a".repeat(40) } }), ctx),
			/lease is not the conflicted paths/,
		);
		await assert.rejects(recordComposition(state, resolved(state, { order_agreement: null }), ctx), /replay resolution must record how its two orders agreed/);
		await assert.rejects(
			recordComposition(
				state,
				conflicted({ status: "RESOLVED", candidate_sha: RESOLVED, contributing_shas: [SIDE_A, "side-c"], resolution: resolution(state) }),
				ctx,
			),
			/other contributing SHAs than the conflict/,
		);
	});

	it("records ADMIT, records REVIEW only when a named person cleared it, and never records REFUSE", async () => {
		const ctx = makeCtx();
		const state = await recordComposition(observed(SIDE_A), conflicted(), ctx);
		const witness = resolution(state).witness;
		await assert.rejects(recordComposition(state, resolved(state, { witness: { ...witness, verdict: "REFUSE" } }), ctx), /REFUSED the candidate/);
		await assert.rejects(
			recordComposition(state, resolved(state, { witness: { ...witness, verdict: "REVIEW", review_cleared_by: "  " } }), ctx),
			/REVIEW and nobody cleared the review/,
		);
		const cleared = await recordComposition(
			state,
			resolved(state, { rung: "command", order_agreement: null, witness: { ...witness, verdict: "REVIEW", review_cleared_by: "ash" } }),
			ctx,
		);
		assert.equal(cleared.composition?.resolution?.witness.review_cleared_by, "ash");
		const admitted = await recordComposition(state, resolved(state), ctx);
		assert.equal(admitted.composition?.status, "RESOLVED");
		assert.equal(admitted.composition?.resolution?.capsule_id, state.composition?.capsule_id);
	});

	it("writes one resolution_recorded ledger entry whose hash is the resolution payload, and keeps the conflict's files and capsule", async () => {
		const ctx = makeCtx();
		const state = await recordComposition(observed(SIDE_A), conflicted(), ctx);
		// A RESOLVED record that tries to restate the conflict differently is
		// bound to the authority's own record instead.
		const restated = resolved(state);
		restated.files = [{ ...restated.files[0], hunks: undefined }];
		const after = await recordComposition(state, restated, ctx);
		assert.deepEqual(after.composition?.files, state.composition?.files);
		assert.equal(after.composition?.capsule_id, state.composition?.capsule_id);
		const entries = after.ledger.filter((e) => e.kind === "resolution_recorded");
		assert.equal(entries.length, 1);
		const payload = resolutionPayload(after.composition as CompositionRecord);
		assert.ok(payload);
		assert.equal(entries[0].payload_hash, await sha256Hex(canonicalJson(payload)));
		const graph = await buildCausalProofGraph(after, RESOLVED);
		const node = graph.nodes.find((n) => n.type === "composition");
		assert.equal((node?.data as { capsule_id?: string }).capsule_id, state.composition?.capsule_id);
		assert.equal((node?.data as { resolution?: { rung: string } }).resolution?.rung, "replay");
	});

	it("a resolution block or witness check on the wrong status is refused", async () => {
		const ctx = makeCtx();
		const state = await recordComposition(observed(SIDE_A), conflicted(), ctx);
		await assert.rejects(
			recordComposition(observed(SIDE_A), conflicted({ resolution: resolution(state) }), ctx),
			/only RESOLVED carries a resolution block/,
		);
		await assert.rejects(
			recordComposition(
				observed(SIDE_A),
				conflicted({ witness_check: { witness_manifest_sha256: MANIFEST, witness_report_sha256: "b".repeat(64), verdict: "ADMIT" } }),
				ctx,
			),
			/only COMPOSED carries a witness check/,
		);
	});
});

describe("COMPOSED over RED or BLOCKED claims", () => {
	function composed(overrides: Partial<CompositionRecord> = {}): CompositionRecord {
		return conflicted({ status: "COMPOSED", candidate_sha: "composed-sha", files: [], ...overrides });
	}
	function withReport(risk: "RED" | "BLOCKED" | "AMBER"): AuthorityState {
		const state = observed(SIDE_A);
		state.conflict_reports = [
			{
				claim_a: "W-api",
				claim_b: "W-ui",
				risk,
				layers: { text: [], symbol: risk === "RED" ? ["label"] : [], impact: [], contract: [], state: risk === "BLOCKED" ? ["POST /label"] : [] },
				explanation: "test",
			},
		];
		return state;
	}

	it("needs a witness check when the member claims were RED or BLOCKED, and refuses a REFUSE verdict", async () => {
		const ctx = makeCtx();
		for (const risk of ["RED", "BLOCKED"] as const) {
			await assert.rejects(recordComposition(withReport(risk), composed(), ctx), /RED or BLOCKED; a COMPOSED candidate over them needs a witness check/);
		}
		const check = { witness_manifest_sha256: MANIFEST, witness_report_sha256: "b".repeat(64), verdict: "ADMIT" as const };
		const ok = await recordComposition(withReport("RED"), composed({ witness_check: check }), ctx);
		assert.equal(ok.composition?.witness_check?.verdict, "ADMIT");
		await assert.rejects(
			recordComposition(withReport("RED"), composed({ witness_check: { ...check, verdict: "REFUSE" } }), ctx),
			/REFUSED the candidate/,
		);
		await assert.rejects(
			recordComposition(withReport("RED"), composed({ witness_check: { ...check, witness_manifest_sha256: "f".repeat(64) } }), ctx),
			/witness check ran another manifest/,
		);
		// AMBER (path overlap, no shared symbol or contract) keeps the old rule.
		const amber = await recordComposition(withReport("AMBER"), composed(), ctx);
		assert.equal(amber.composition?.status, "COMPOSED");
	});
});

describe("offline verify of a resolved promotion", () => {
	async function promotedResolution() {
		const ctx = makeCtx();
		let state = await recordComposition(observed(RESOLVED), conflicted(), ctx);
		state = await recordComposition(state, resolved(state), ctx);
		state = (await submitEvaluation(state, await makeBundle(), { zone: "evaluation_domain" }, ctx)).state;
		const seam = await runVerdictSeam(state, [{ contender_id: "contender-1", candidate_sha: RESOLVED, blast_radius: 1, change_surface: 1 }], ctx);
		assert.equal(seam.record.state, "ACCEPT");
		const permit = await issuePermit(seam.state, RESOLVED, "acme/api", BASELINE, ctx);
		assert.equal(permit.outcome, "ISSUED");
		const permitId = permit.permit?.permit_id as string;
		const promoted = await attemptPromotion(permit.state, permitId, BASELINE, "tree-resolved", ctx);
		assert.equal(promoted.outcome, "PROMOTED");
		const signer = createEd25519Signer();
		const { bundle } = await recordPromotionBundle(promoted.state, permitId, { commit: RESOLVED, parent: BASELINE }, signer, ctx);
		const pin = { policyHash: "policyhash", trustedKeyDerHex: signer.publicKeyDerHex };
		return { bundle, signer, pin, capsule: state.composition?.capsule_id as string };
	}

	it("a resolution recorded with no witness runner key pinned (insecure opt-in) carries no proof and is NOT VERIFIED", async () => {
		// The VERIFIED path, with a real signed admission proof, is in
		// test/resolution-hardening-v4.test.ts.
		const { bundle, signer, pin, capsule } = await promotedResolution();
		assert.equal(bundle.resolution?.resolution.capsule_id, capsule);
		const { lines, verified } = await verifyBundle(bundle, signer, pin);
		assert.equal(verified, false);
		const line = lines.find((l) => l.label === "resolution");
		assert.equal(line?.status, "FAIL");
		assert.match(line?.detail ?? "", /carries no admission proof/);
		// Every other line still verifies.
		assert.deepEqual(lines.filter((l) => l.status === "FAIL").map((l) => l.label), ["resolution"]);
	});

	it("an edited capsule id, a stripped resolution, or a resolution for another commit is NOT VERIFIED", async () => {
		const { bundle, signer, pin } = await promotedResolution();
		const edited: PromotionBundle = structuredClone(bundle);
		(edited.resolution as NonNullable<PromotionBundle["resolution"]>).resolution.capsule_id = "0".repeat(64);
		const a = await verifyBundle(edited, signer, pin);
		assert.equal(a.verified, false);
		assert.match(a.lines.find((l) => l.label === "resolution")?.detail ?? "", /recorded 0 times/);

		const stripped: PromotionBundle = structuredClone(bundle);
		delete stripped.resolution;
		const b = await verifyBundle(stripped, signer, pin);
		assert.equal(b.verified, false);
		assert.match(b.lines.find((l) => l.label === "resolution")?.detail ?? "", /records a resolution, but the bundle carries none/);

		const elsewhere: PromotionBundle = structuredClone(bundle);
		elsewhere.ship.commit = "some-other-commit";
		const c = await verifyBundle(elsewhere, signer, pin);
		assert.equal(c.verified, false);
		assert.equal(c.lines.find((l) => l.label === "resolution")?.status, "FAIL");
	});
});

describe("RESOLVED hardening (stress report bug 8 / repro 13)", () => {
	it("a retried identical RESOLVED is an idempotent no-op; a different one is still refused", async () => {
		const ctx = makeCtx();
		const state = await recordComposition(observed(SIDE_A), conflicted(), ctx);
		const once = await recordComposition(state, resolved(state), ctx);
		const twice = await recordComposition(once, resolved(state), ctx);
		assert.equal(twice, once, "the same RESOLVED returns the recorded state unchanged");
		assert.equal(twice.ledger.length, once.ledger.length);
		await assert.rejects(
			recordComposition(once, conflicted({ status: "RESOLVED", candidate_sha: "other-sha", resolution: resolution(state) }), ctx),
			/candidate SHA is already bound/,
		);
	});

	it("refuses a RESOLVED whose candidate is the baseline commit", async () => {
		const ctx = makeCtx();
		const state = await recordComposition(observed(SIDE_A), conflicted(), ctx);
		await assert.rejects(
			recordComposition(state, conflicted({ status: "RESOLVED", candidate_sha: BASELINE, resolution: resolution(state) }), ctx),
			/must be new, not the baseline/,
		);
	});

	it("refuses a RESOLVED that names other agents or intents than the conflict", async () => {
		const ctx = makeCtx();
		const state = await recordComposition(observed(SIDE_A), conflicted(), ctx);
		const agents = conflicted().agents.map((agent) => ({ ...agent }));
		agents[1].intent = "a different intent";
		await assert.rejects(
			recordComposition(state, conflicted({ status: "RESOLVED", candidate_sha: RESOLVED, agents, resolution: resolution(state) }), ctx),
			/names other agents than the conflict/,
		);
	});
});
