/**
 * Evidence-submission authorization (spec 3 §5 credential matrix;
 * spec 3 §6 attack #6).
 *
 * The authority itself enforces the caller zone on submitEvaluation —
 * this file proves the enforcement lives in the transition function, not
 * in a wrapper that could be bypassed: contender-zone, verdict-plane,
 * and unknown callers are all rejected, and only the evaluation domain
 * is admitted. Also covers evidence idempotency (identical re-submit →
 * ACK_DUP) and re-evaluation (changed bundle overwrites).
 *
 * node --test test/evidence-auth.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, sha256Hex } from "../src/lib/canonical.ts";
import {
	createAuthority,
	submitEvaluation,
	type Ctx,
} from "../src/lib/task-state.ts";
import type {
	CallerIdentity,
	EvaluationBundle,
	TaskRecord,
	TrustZone,
} from "../src/lib/types.ts";

const TASK_HASH = "taskhash-ea";

function makeTask(): TaskRecord {
	return {
		task_id: "task-ea",
		task_hash: TASK_HASH,
		intent: "fix the thing",
		baseline_repo: "acme/api",
		baseline_commit: "base123",
		behavior_contract: "it works",
		policy_version: "seam-policy/0.1.0",
		frozen_at: "2026-10-01T18:00:00Z",
	};
}

function makeCtx(): Ctx {
	return {
		now: () => "2026-10-01T18:30:00.000Z",
		randomHex: (n: number) => "e".repeat(n * 2),
		sha256Hex,
		selectorPolicyHash: "policyhash",
		policyVersion: "seam-policy/0.1.0",
	};
}

async function makeBundle(overrides: Partial<EvaluationBundle> = {}): Promise<EvaluationBundle> {
	const base = {
		candidate_sha: "csha1",
		tree_sha256: "tree1",
		contender_id: "contender-1",
		task_hash: TASK_HASH,
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
		evaluated_at: "2026-10-01T18:00:00Z",
		tainted: false,
		...overrides,
	};
	const { bundle_hash: _h, ...rest } = base as EvaluationBundle & { bundle_hash?: string };
	const bundle_hash = await sha256Hex(canonicalJson(rest));
	return { ...(rest as EvaluationBundle), bundle_hash };
}

function caller(zone: TrustZone): CallerIdentity {
	return { zone };
}

describe("evidence submission authorization", () => {
	it("evaluation domain → RECORDED", async () => {
		const ctx = makeCtx();
		const state = createAuthority(makeTask());
		const bundle = await makeBundle();
		const { state: s2, outcome } = await submitEvaluation(state, bundle, caller("evaluation_domain"), ctx);
		assert.equal(outcome, "RECORDED");
		assert.equal(s2.evaluations["csha1"].bundle_hash, bundle.bundle_hash);
	});

	it("contender zone → rejected (attack #6: contender-supplied evidence inadmissible)", async () => {
		const ctx = makeCtx();
		const state = createAuthority(makeTask());
		const bundle = await makeBundle();
		await assert.rejects(
			submitEvaluation(state, bundle, { zone: "contender", actor: "contender-1" }, ctx),
			/contender-supplied evidence is inadmissible/,
		);
		// The rejection must leave no trace of the bundle.
		assert.equal(state.evaluations["csha1"], undefined);
	});

	it("verdict_plane, control_plane, promotion zones → rejected", async () => {
		const ctx = makeCtx();
		const state = createAuthority(makeTask());
		const bundle = await makeBundle();
		for (const zone of ["verdict_plane", "control_plane", "promotion"] as TrustZone[]) {
			await assert.rejects(
				submitEvaluation(state, bundle, caller(zone), ctx),
				/not authorized to submit evidence/,
				`zone ${zone} must be rejected`,
			);
		}
	});

	it("unknown zone (unauthenticated caller) → rejected (fail closed)", async () => {
		const ctx = makeCtx();
		const state = createAuthority(makeTask());
		const bundle = await makeBundle();
		// This is the edge's fail-closed default when no caller identity
		// reaches the authority.
		await assert.rejects(
			submitEvaluation(state, bundle, caller("unknown"), ctx),
			/not authorized to submit evidence/,
		);
	});

	it("identical re-submit → ACK_DUP (no state change, no ledger entry)", async () => {
		const ctx = makeCtx();
		const state = createAuthority(makeTask());
		const bundle = await makeBundle();
		const first = await submitEvaluation(state, bundle, caller("evaluation_domain"), ctx);
		assert.equal(first.outcome, "RECORDED");
		const ledgerLen = first.state.ledger.length;
		const second = await submitEvaluation(first.state, bundle, caller("evaluation_domain"), ctx);
		assert.equal(second.outcome, "ACK_DUP");
		assert.equal(second.state, first.state, "ACK_DUP must return the state object unchanged");
		assert.equal(second.state.ledger.length, ledgerLen, "ACK_DUP must not append a ledger entry");
	});

	it("re-evaluation (changed bundle, same candidate) → RECORDED (overwrites)", async () => {
		const ctx = makeCtx();
		const state = createAuthority(makeTask());
		const v1 = await makeBundle({ hidden_oracle: { passed: true, total: 2, failed: [] as string[] } });
		const first = await submitEvaluation(state, v1, caller("evaluation_domain"), ctx);
		const v2 = await makeBundle({ hidden_oracle: { passed: true, total: 3, failed: [] as string[] } });
		assert.notEqual(v2.bundle_hash, v1.bundle_hash, "the re-evaluation must differ");
		const second = await submitEvaluation(first.state, v2, caller("evaluation_domain"), ctx);
		assert.equal(second.outcome, "RECORDED");
		assert.equal(second.state.evaluations["csha1"].bundle_hash, v2.bundle_hash);
	});

	it("bundle for a different task → rejected", async () => {
		const ctx = makeCtx();
		const state = createAuthority(makeTask());
		const bundle = await makeBundle({ task_hash: "some-other-task" });
		// Recompute the hash after changing task_hash (makeBundle already did).
		await assert.rejects(
			submitEvaluation(state, bundle, caller("evaluation_domain"), ctx),
			/task_hash mismatch/,
		);
	});
});
