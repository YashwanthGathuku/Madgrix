/**
 * Tests for the task-authority state machine (spec 5 §4 + spec 1).
 * node --test test/task-state.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, sha256Hex } from "../src/lib/canonical.ts";
import { createCommitment } from "../src/lib/verifiers.ts";
import {
	appendLedger,
	attemptPromotion,
	commitVerifier,
	createAuthority,
	defaultCtx,
	enrollAgents,
	escalateToOperator,
	ingestQueueEvent,
	issuePermit,
	quarantineContender,
	registerClaim,
	registerOperatorKeys,
	revealVerifier,
	reviewQuarantine,
	runVerdictSeam,
	submitEvaluation,
	submitVerifierReport,
	taskHashFor,
	type Ctx,
	type Effect,
	type QuarantineRecheck,
	type SignedDetermination,
} from "../src/lib/task-state.ts";
import { createEd25519Signer } from "../src/lib/signer-node.ts";
import { quarantineDeterminationPayload } from "../src/lib/verifier-keys.ts";
import type {
	AuthorityState,
	CallerIdentity,
	ContenderRecord,
	EvaluationBundle,
	QueuePushEvent,
	QuarantineTrigger,
	ReferenceReport,
	TaskRecord,
	VerifierCommitment,
} from "../src/lib/types.ts";

const TASK_HASH = "taskhash-abc";
const BASELINE = "base123";

function makeTask(): TaskRecord {
	return {
		task_id: "task-1",
		task_hash: TASK_HASH,
		intent: "expired JWT returns HTTP 401",
		baseline_repo: "acme/api",
		baseline_commit: BASELINE,
		behavior_contract: "expired JWT → 401",
		policy_version: "seam-policy/0.1.0",
		frozen_at: "2026-10-01T18:00:00Z",
	};
}

function makeCtx(): Ctx {
	return {
		now: () => "2026-10-01T18:30:00.000Z",
		randomHex: (n: number) => "f".repeat(n * 2),
		sha256Hex,
		selectorPolicyHash: "policyhash",
		policyVersion: "seam-policy/0.1.0",
	};
}

function makeContender(): ContenderRecord {
	return {
		contender_id: "contender-1",
		agent_id: "agent-1",
		fork_repo: "fork-1",
		fork_lineage: { parent_repo: "acme/api", parent_commit: BASELINE },
		fork_base: BASELINE,
		token_id: "tok-1",
		status: "forked",
		claim_work_id: null,
		latest_commit: null,
	};
}

function stateWithContender(ctx: Ctx): AuthorityState {
	const s = createAuthority(makeTask());
	return { ...s, contenders: { "contender-1": makeContender() } };
}

/** As stateWithContender, with the contender's push of `sha` already observed
 *  (evidence must name the contender's latest observed commit). */
function stateWithObservedCandidate(ctx: Ctx, sha = "csha1"): AuthorityState {
	const s = stateWithContender(ctx);
	return { ...s, contenders: { "contender-1": { ...makeContender(), latest_commit: sha } } };
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

/** Drive a fresh authority to an ACCEPT verdict for one candidate. */
async function authorityWithAccept(ctx: Ctx, bundle: EvaluationBundle) {
	let state = stateWithObservedCandidate(ctx, bundle.candidate_sha);
	const evalCaller: CallerIdentity = { zone: "evaluation_domain" };
	state = (await submitEvaluation(state, bundle, evalCaller, ctx)).state;
	const { state: s2, record } = await runVerdictSeam(
		state,
		[
			{
				contender_id: bundle.contender_id,
				candidate_sha: bundle.candidate_sha,
				blast_radius: 1,
				change_surface: 1,
			},
		],
		ctx,
	);
	assert.equal(record.state, "ACCEPT");
	return s2;
}

/** Operator-key helpers for quarantine-review tests. */
async function makeOperator() {
	const signer = createEd25519Signer();
	return {
		signer,
		keyid: signer.keyid,
		publicKeyDerHex: signer.publicKeyDerHex,
		async register(state: AuthorityState, ctx: Ctx) {
			return registerOperatorKeys(state, [{ public_key_der_hex: signer.publicKeyDerHex }], ctx);
		},
		async determine(
			contender_id: string,
			trigger: "tool_status_fabrication",
			decision: "RELEASED" | "REVOKED",
			note: string,
		): Promise<SignedDetermination> {
			const payload = new TextEncoder().encode(
				quarantineDeterminationPayload({ contender_id, trigger, decision, note }),
			);
			const sig = await signer.sign(payload);
			return { note, keyid: signer.keyid, signature: sig.signature };
		},
	};
}

function makeRecheck(trigger: QuarantineTrigger, passed: boolean, detail: string): QuarantineRecheck {
	return { trigger, passed, detail, checked_at: "2026-10-01T19:00:00Z" };
}

describe("ingestQueueEvent", () => {
	it("duplicate event → ACK_DUP (idempotent, no state change)", async () => {
		const ctx = makeCtx();
		const state = stateWithContender(ctx);
		const event: QueuePushEvent = {
			namespace: "push",
			repo: "fork-1",
			ref: "refs/heads/work",
			before: "base123",
			after: "commitA",
		};
		const r1 = await ingestQueueEvent(state, event, ctx);
		assert.equal(r1.outcome, "APPLIED_NEW");
		assert.equal(r1.state.contenders["contender-1"].latest_commit, "commitA");
		const r2 = await ingestQueueEvent(r1.state, event, ctx);
		assert.equal(r2.outcome, "ACK_DUP");
		assert.equal(r2.effects.length, 0);
		assert.equal(r2.state.ledger.length, r1.state.ledger.length); // no new entry
	});

	it("unknown repo → REJECTED_OUT_OF_ORDER (ledgered, not applied)", async () => {
		const ctx = makeCtx();
		const state = stateWithContender(ctx);
		const event: QueuePushEvent = {
			namespace: "push",
			repo: "someone-elses-fork",
			ref: "refs/heads/work",
			before: "base123",
			after: "commitX",
		};
		const r = await ingestQueueEvent(state, event, ctx);
		assert.equal(r.outcome, "REJECTED_OUT_OF_ORDER");
		assert.equal(r.state.contenders["contender-1"].latest_commit, null);
		assert.ok(r.state.ledger.some((e) => e.kind === "queue_event_rejected_out_of_order"));
	});
});

describe("registerClaim", () => {
	it("registers, assigns work_id, classifies against live claims", async () => {
		const ctx = makeCtx();
		const state = stateWithContender(ctx);
		const input = {
			agent: "contender-1",
			task: TASK_HASH,
			baseline: BASELINE,
			intent: { behavior: ["expired JWT returns HTTP 401"] },
			scope: { paths: ["src/auth/**"], symbols: ["verifyToken"] },
			contracts: { reads: ["JWTClaims"], modifies: ["TokenValidationResult"] },
			interfaces: ["middleware.auth"],
			schema_changes: [],
			expected_tests: ["auth_expiration"],
			lease: { claimed_at: "2026-10-01T18:00:00Z", expires_at: "2026-10-01T20:00:00Z" },
		};
		const r1 = await registerClaim(state, input, ctx);
		assert.match(r1.claim.work_id, /^W-/);
		assert.equal(r1.claim.version, 1);
		assert.equal(r1.claim.status, "claimed");
		assert.equal(r1.reports.length, 0); // no live claims yet

		// Second, conflicting claim → classified at registration.
		const r2 = await registerClaim(r1.state, {
			...input,
			agent: "contender-2",
			scope: { paths: ["src/login/**"], symbols: ["LoginController"] },
			contracts: { reads: [], modifies: ["JWTClaims"] },
			interfaces: ["POST /login"], // distinct — no state-layer collision
		}, ctx);
		assert.equal(r2.reports.length, 1);
		assert.equal(r2.reports[0].risk, "RED");
	});

	it("enrolled task: only enrolled agents, each with its own secret, may claim; nothing is minted", async () => {
		const ctx = makeCtx();
		const secretA = "a1".repeat(32);
		let state = await enrollAgents(stateWithContender(ctx), { "contender-1": await sha256Hex(secretA) }, ctx);
		const input = {
			agent: "contender-1",
			task: TASK_HASH,
			baseline: BASELINE,
			intent: { behavior: ["x"] },
			scope: { paths: ["src/**"], symbols: [] },
			contracts: { reads: [], modifies: [] },
			interfaces: [],
			schema_changes: [],
			expected_tests: [],
			lease: { claimed_at: "2026-10-01T18:00:00Z", expires_at: "2026-10-01T20:00:00Z" },
		};
		await assert.rejects(registerClaim(state, input, ctx), /requires its secret/);
		await assert.rejects(registerClaim(state, input, ctx, "b2".repeat(32)), /does not match/);
		await assert.rejects(registerClaim(state, { ...input, agent: "contender-9" }, ctx, secretA), /not enrolled/);
		const r = await registerClaim(state, input, ctx, secretA);
		assert.equal(r.agent_secret, null, "no secret is minted for an enrolled agent");
		assert.equal(r.claim.agent_secret_sha256, await sha256Hex(secretA));
		state = r.state;
		await assert.rejects(enrollAgents(state, { "contender-2": await sha256Hex("x") }, ctx), /already enrolled/);
	});

	it("enrollAgents validates ids and digests and must precede every claim", async () => {
		const ctx = makeCtx();
		const digest = "c3".repeat(32);
		for (const [label, enrollment] of [
			["no agents", {}],
			["bad id", { "agent a": digest }],
			["bad digest", { "agent-a": "nope" }],
		] as const) {
			await assert.rejects(enrollAgents(stateWithContender(ctx), enrollment, ctx), /enrollAgents/, label);
		}
	});

	it("rejects empty scope.paths", async () => {
		const ctx = makeCtx();
		const state = stateWithContender(ctx);
		await assert.rejects(
			registerClaim(state, {
				agent: "contender-1",
				task: TASK_HASH,
				baseline: BASELINE,
				intent: { behavior: [] },
				scope: { paths: [], symbols: [] },
				contracts: { reads: [], modifies: [] },
				interfaces: [],
				schema_changes: [],
				expected_tests: [],
				lease: { claimed_at: "2026-10-01T18:00:00Z", expires_at: "2026-10-01T20:00:00Z" },
			}, ctx),
			/unbounded/,
		);
	});

	it("rejects task/baseline mismatch (stale work)", async () => {
		const ctx = makeCtx();
		const state = stateWithContender(ctx);
		const base = {
			agent: "contender-1",
			intent: { behavior: [] },
			scope: { paths: ["src/a/**"], symbols: [] },
			contracts: { reads: [], modifies: [] },
			interfaces: [],
			schema_changes: [],
			expected_tests: [],
			lease: { claimed_at: "2026-10-01T18:00:00Z", expires_at: "2026-10-01T20:00:00Z" },
		};
		await assert.rejects(
			registerClaim(state, { ...base, task: "other-task", baseline: BASELINE }, ctx),
			/task mismatch/,
		);
		await assert.rejects(
			registerClaim(state, { ...base, task: TASK_HASH, baseline: "other-base" }, ctx),
			/baseline mismatch/,
		);
	});
});

describe("blind verifier commit → reveal", () => {
	const report: ReferenceReport = {
		expected_behavior: ["expired JWT returns 401"],
		invariants: ["valid JWT still accepted"],
		likely_failure_modes: ["clock skew"],
		evaluation_plan: ["run hidden oracle"],
		security_expectations: ["no secret logging"],
	};

	it("valid reveal → admissible", async () => {
		const ctx = makeCtx();
		let state = stateWithContender(ctx);
		const nonce = "nonce-1";
		const commitment = await createCommitment(report, nonce, TASK_HASH, "v1", "seam-policy/0.1.0", sha256Hex);
		const vc: VerifierCommitment = {
			verifier_id: "v1",
			task_hash: TASK_HASH,
			policy_version: "seam-policy/0.1.0",
			commitment,
			committed_at: "2026-10-01T18:10:00Z",
		};
		state = await commitVerifier(state, vc, ctx);
		const r = await revealVerifier(state, "v1", report, nonce, ctx);
		assert.equal(r.admissible, true);
		assert.equal(r.reason, null);
		assert.deepEqual(r.state.verifier_reveals["v1"], report);
	});

	it("tampered reveal → INADMISSIBLE, and no retry with a rewritten opinion", async () => {
		const ctx = makeCtx();
		let state = stateWithContender(ctx);
		const commitment = await createCommitment(report, "nonce-1", TASK_HASH, "v1", "seam-policy/0.1.0", sha256Hex);
		state = await commitVerifier(state, {
			verifier_id: "v1",
			task_hash: TASK_HASH,
			policy_version: "seam-policy/0.1.0",
			commitment,
			committed_at: "2026-10-01T18:10:00Z",
		}, ctx);
		// Wrong nonce → commitment mismatch.
		const bad = await revealVerifier(state, "v1", report, "wrong-nonce", ctx);
		assert.equal(bad.admissible, false);
		assert.match(bad.reason as string, /INADMISSIBLE/);
		// Even the CORRECT reveal afterwards is refused: participation ended.
		const retry = await revealVerifier(bad.state, "v1", report, "nonce-1", ctx);
		assert.equal(retry.admissible, false);
		assert.match(retry.reason as string, /no retry/);
	});

	it("report without a revealed commitment is rejected", async () => {
		const ctx = makeCtx();
		const state = stateWithContender(ctx);
		await assert.rejects(
			submitVerifierReport(state, {
				verifier_id: "v-ghost",
				candidate_label: "candidate-7f31",
				verdict: "accept",
				reasons: ["looks good"],
				signature: "sig",
				keyid: "key",
			}, ctx),
			/no revealed commitment/,
		);
	});

	it("duplicate commitment is rejected", async () => {
		const ctx = makeCtx();
		let state = stateWithContender(ctx);
		const vc: VerifierCommitment = {
			verifier_id: "v1",
			task_hash: TASK_HASH,
			policy_version: "seam-policy/0.1.0",
			commitment: "abc",
			committed_at: "2026-10-01T18:10:00Z",
		};
		state = await commitVerifier(state, vc, ctx);
		await assert.rejects(commitVerifier(state, vc, ctx), /duplicate commitment/);
	});
});

describe("permit + promotion", () => {
	it("PROMOTED once; replay → ALREADY_CONSUMED (no-op ACK)", async () => {
		const ctx = makeCtx();
		const bundle = await makeBundle();
		let state = await authorityWithAccept(ctx, bundle);
		const { state: s2, permit } = await issuePermit(state, "csha1", "acme/api", BASELINE, ctx);
		assert.ok(permit);
		assert.equal(permit.consumed, false);

		const r1 = await attemptPromotion(s2, permit.permit_id, BASELINE, "tree1", ctx);
		assert.equal(r1.outcome, "PROMOTED");
		assert.equal(r1.state.task_status, "promoted");
		// Fast-forward the destination from the permit-bound head to the candidate.
		assert.deepEqual(r1.effects, [
			{ kind: "canonical_write", repo: "acme/api", commit: "csha1", tree_sha256: "tree1", base: BASELINE },
		]);

		const r2 = await attemptPromotion(r1.state, permit.permit_id, BASELINE, "tree1", ctx);
		assert.equal(r2.outcome, "ALREADY_CONSUMED");
		assert.equal(r2.effects.length, 0);
	});

	it("unknown permit → UNKNOWN_PERMIT", async () => {
		const ctx = makeCtx();
		const state = stateWithContender(ctx);
		const r = await attemptPromotion(state, "nope", "h", "t", ctx);
		assert.equal(r.outcome, "UNKNOWN_PERMIT");
	});

	it("destination HEAD moved → EXPIRED_HEAD_MOVED, permit NOT consumed", async () => {
		const ctx = makeCtx();
		const bundle = await makeBundle();
		let state = await authorityWithAccept(ctx, bundle);
		const issued = await issuePermit(state, "csha1", "acme/api", BASELINE, ctx);
		assert.ok(issued.permit);
		const r = await attemptPromotion(issued.state, issued.permit.permit_id, "dest-head-2", "tree1", ctx);
		assert.equal(r.outcome, "EXPIRED_HEAD_MOVED");
		assert.equal(r.state.permits[issued.permit.permit_id].consumed, false);
	});

	it("tree mismatch → TREE_MISMATCH, permit NOT consumed", async () => {
		const ctx = makeCtx();
		const bundle = await makeBundle();
		let state = await authorityWithAccept(ctx, bundle);
		const issued = await issuePermit(state, "csha1", "acme/api", BASELINE, ctx);
		assert.ok(issued.permit);
		const r = await attemptPromotion(issued.state, issued.permit.permit_id, BASELINE, "other-tree", ctx);
		assert.equal(r.outcome, "TREE_MISMATCH");
		assert.equal(r.state.permits[issued.permit.permit_id].consumed, false);
	});

	it("quarantined winner → QUARANTINED_CANDIDATE, permit NOT consumed", async () => {
		const ctx = makeCtx();
		const bundle = await makeBundle();
		let state = await authorityWithAccept(ctx, bundle);
		const issued = await issuePermit(state, "csha1", "acme/api", BASELINE, ctx);
		assert.ok(issued.permit);
		const q = await quarantineContender(issued.state, "contender-1", "candidate_sha_substitution", "ev-hash", ctx);
		const r = await attemptPromotion(q.state, issued.permit.permit_id, BASELINE, "tree1", ctx);
		assert.equal(r.outcome, "QUARANTINED_CANDIDATE");
		assert.equal(r.state.permits[issued.permit.permit_id].consumed, false);
		// The quarantine names the permit whose PromotionWorkflow instance it
		// stops (specs/amendments/promotion-runtime-v1.md); a consumed permit
		// has nothing left to stop.
		const cancel = (effects: Effect[]) => effects.find((e) => e.kind === "cancel_workflow");
		assert.deepEqual(cancel(q.effects), { kind: "cancel_workflow", contender_id: "contender-1", permit_ids: [issued.permit.permit_id] });
		const consumed = structuredClone(issued.state);
		consumed.permits[issued.permit.permit_id].consumed = true;
		const q2 = await quarantineContender(consumed, "contender-1", "candidate_sha_substitution", "ev-hash", ctx);
		assert.deepEqual(cancel(q2.effects), { kind: "cancel_workflow", contender_id: "contender-1", permit_ids: [] });
	});

	it("issuePermit requires an ACCEPT verdict for the winner", async () => {
		const ctx = makeCtx();
		const state = stateWithContender(ctx);
		await assert.rejects(issuePermit(state, "csha1", "acme/api", "h", ctx), /no ACCEPT verdict/);
	});
});

describe("quarantine", () => {
	it("quarantine revokes token, cancels workflow, notifies, taints evidence", async () => {
		const ctx = makeCtx();
		const bundle = await makeBundle();
		let state = stateWithObservedCandidate(ctx);
		state = (await submitEvaluation(state, bundle, { zone: "evaluation_domain" }, ctx)).state;
		const { state: qstate, effects } = await quarantineContender(
			state,
			"contender-1",
			"eval_file_modification",
			"ev-hash-1",
			ctx,
		);
		assert.equal(qstate.contenders["contender-1"].status, "quarantined");
		assert.equal(qstate.quarantine["contender-1"].status, "QUARANTINED");
		assert.equal(qstate.evaluations["csha1"].tainted, true);
		assert.deepEqual(effects, [
			{ kind: "revoke_token", repo: "fork-1", token_id: "tok-1" },
			{ kind: "cancel_workflow", contender_id: "contender-1", permit_ids: [] },
			{
				kind: "notify",
				to: ["operator-of-record"],
				message: "contender contender-1 QUARANTINED (trigger: eval_file_modification, evidence: ev-hash-1)",
			},
		]);
	});

	it("RELEASED requires a passing re-check of the firing trigger + signed determination; REVOKED terminates", async () => {
		const ctx = makeCtx();
		const bundle = await makeBundle();
		let state = stateWithObservedCandidate(ctx);
		state = (await submitEvaluation(state, bundle, { zone: "evaluation_domain" }, ctx)).state;
		const operator = await makeOperator();
		state = await operator.register(state, ctx);
		const q = await quarantineContender(state, "contender-1", "tool_status_fabrication", "ev", ctx);

		// Unsigned determination (unknown keyid) → rejected, even with a passing re-check.
		await assert.rejects(
			reviewQuarantine(
				q.state,
				"contender-1",
				"RELEASED",
				makeRecheck("tool_status_fabrication", true, "re-run passes"),
				{ note: "false positive", keyid: "unknown-keyid", signature: "bogus" },
				ctx,
			),
			/unknown operator keyid/,
		);

		// Passing re-check + signed determination → RELEASED.
		const relDet = await operator.determine(
			"contender-1",
			"tool_status_fabrication",
			"RELEASED",
			"re-verification shows the tool receipt was valid; trigger was a mechanical false positive",
		);
		const rel = await reviewQuarantine(
			q.state,
			"contender-1",
			"RELEASED",
			makeRecheck("tool_status_fabrication", true, "re-run of the tool-status check passes"),
			relDet,
			ctx,
		);
		assert.equal(rel.state.quarantine["contender-1"].status, "RELEASED");
		assert.equal(rel.state.contenders["contender-1"].status, "released");
		assert.equal(rel.state.evaluations["csha1"].tainted, false);

		// Re-check reproduces the violation → RELEASED denied even with a valid signature.
		const badRelDet = await operator.determine(
			"contender-1",
			"tool_status_fabrication",
			"RELEASED",
			"operator claims false positive anyway",
		);
		await assert.rejects(
			reviewQuarantine(
				q.state,
				"contender-1",
				"RELEASED",
				makeRecheck("tool_status_fabrication", false, "re-run reproduces the fabricated receipt"),
				badRelDet,
				ctx,
			),
			/RELEASED denied/,
		);

		// Re-check naming the WRONG trigger → rejected (must re-run the check that fired).
		const revDet = await operator.determine("contender-1", "tool_status_fabrication", "REVOKED", "confirmed fabrication");
		await assert.rejects(
			reviewQuarantine(
				q.state,
				"contender-1",
				"REVOKED",
				makeRecheck("eval_file_modification", true, "wrong trigger"),
				revDet,
				ctx,
			),
			/does not match the quarantine trigger/,
		);

		// REVOKED with a valid signed determination → terminates, keeps the taint.
		const rev = await reviewQuarantine(
			q.state,
			"contender-1",
			"REVOKED",
			makeRecheck("tool_status_fabrication", false, "re-run reproduces the fabricated receipt"),
			revDet,
			ctx,
		);
		assert.equal(rev.state.quarantine["contender-1"].status, "REVOKED");
		assert.equal(rev.state.contenders["contender-1"].status, "revoked");
		assert.equal(rev.state.evaluations["csha1"].tainted, true); // taint kept
	});

	it("evaluator_config_modification quarantines on locked-config hash mismatch (spec 3 §6 attack 3)", async () => {
		// Amendment specs/amendments/evaluator-config-trigger.md: attack 3 is a
		// DISTINCT trigger, not hidden_eval_boundary_violation. The mechanical
		// finding is SHA256(canonical_json(presented_config)) != locked digest.
		const ctx = makeCtx();
		const bundle = await makeBundle();
		let state = stateWithObservedCandidate(ctx);
		state = (await submitEvaluation(state, bundle, { zone: "evaluation_domain" }, ctx)).state;
		const locked = { evaluator_version: "eval-domain/0.3.1", hidden_seed: "9f2c", policy: "strict" };
		const lockedHash = await ctx.sha256Hex(canonicalJson(locked));
		const presented = { ...locked, hidden_seed: "0000" }; // attacker-modified config
		const presentedHash = await ctx.sha256Hex(canonicalJson(presented));
		assert.notEqual(presentedHash, lockedHash, "modified config must change the locked digest");
		const { state: qstate, effects } = await quarantineContender(
			state,
			"contender-1",
			"evaluator_config_modification",
			presentedHash,
			ctx,
		);
		assert.equal(qstate.quarantine["contender-1"].status, "QUARANTINED");
		assert.equal(qstate.quarantine["contender-1"].trigger, "evaluator_config_modification");
		assert.equal(qstate.contenders["contender-1"].status, "quarantined");
		assert.equal(qstate.evaluations["csha1"].tainted, true);
		assert.ok(
			effects.some((e) => e.kind === "revoke_token"),
			"quarantine must revoke the fork's write token",
		);
	});
});

describe("escalation", () => {
	it("escalateToOperator blocks issuePermit", async () => {
		const ctx = makeCtx();
		const bundle = await makeBundle();
		let state = await authorityWithAccept(ctx, bundle);
		const esc = await escalateToOperator(state, "verifier split on equivalent candidates", ctx);
		state = esc.state;
		assert.equal(state.task_status, "escalated");
		await assert.rejects(
			issuePermit(state, "csha1", "acme/api", BASELINE, ctx),
			/BLOCKED/,
		);
	});
});

describe("ledger + task hash", () => {
	it("every transition appends a content-hashed ledger entry", async () => {
		const ctx = makeCtx();
		let state = stateWithContender(ctx);
		const before = state.ledger.length;
		state = await appendLedger(state, "test_kind", { a: 1 }, ctx);
		const entry = state.ledger[state.ledger.length - 1];
		assert.equal(state.ledger.length, before + 1);
		assert.equal(entry.kind, "test_kind");
		assert.equal(entry.payload_hash, await sha256Hex(canonicalJson({ a: 1 })));
	});

	it("taskHashFor hashes the canonical task record (spec 1 §5)", async () => {
		const h = await taskHashFor(
			{
				intent: "x",
				baseline_repo: "r",
				baseline_commit: "c",
				behavior_contract: "",
				policy_version: "seam-policy/0.1.0",
				frozen_at: "2026-10-01T18:00:00Z",
			},
			sha256Hex,
		);
		assert.equal(h, await sha256Hex(canonicalJson({
			intent: "x",
			baseline_repo: "r",
			baseline_commit: "c",
			behavior_contract: "",
			policy_version: "seam-policy/0.1.0",
			frozen_at: "2026-10-01T18:00:00Z",
		})));
		// The retired joinHashParts convention (pre-reconciliation) omitted
		// behavior_contract and disagrees with the frozen spec: it must NOT
		// equal the conforming hash. taskHashFor is the single convention.
		const oldConvention = await sha256Hex(
			["x", "r", "c", "seam-policy/0.1.0", "2026-10-01T18:00:00Z"].join("\0"),
		);
		assert.notEqual(h, oldConvention, "task hash must cover the full task record, not the NUL-joined subset");
	});

	it("defaultCtx is constructible", () => {
		const ctx = defaultCtx("policyhash");
		assert.equal(ctx.selectorPolicyHash, "policyhash");
		assert.equal(ctx.policyVersion, "seam-policy/0.1.0");
	});
});
