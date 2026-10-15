/**
 * Evidence-submission authorization (spec 3 §5 credential matrix;
 * spec 3 §6 attack #6).
 *
 * The authority itself enforces the caller zone on submitEvaluation —
 * this file proves the enforcement lives in the transition function, not
 * in a wrapper that could be bypassed: contender-zone, verdict-plane,
 * and unknown callers are all rejected, and only the evaluation domain
 * is admitted. Also covers evidence idempotency (identical re-submit →
 * ACK_DUP), re-evaluation (a changed bundle overwrites until the candidate
 * is labeled), and the evidence binding of
 * specs/amendments/evidence-integrity-v1.md: a bundle must name the
 * contender's latest observed commit, and once verifiers' candidate labels
 * exist for a SHA its evidence can no longer be replaced.
 *
 * node --test test/evidence-auth.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, sha256Hex } from "../src/lib/canonical.ts";
import { assumeCompleteMergeArtifactScan } from "../src/lib/merge-artifacts.ts";
import { TaskAuthority } from "../src/do/TaskAuthority.ts";
import {
	assignCandidateLabels,
	createAuthority,
	submitEvaluation,
	type Ctx,
} from "../src/lib/task-state.ts";
import type {
	AuthorityState,
	CallerIdentity,
	ContenderRecord,
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
	const scanned = assumeCompleteMergeArtifactScan(rest);
	const bundle_hash = await sha256Hex(canonicalJson(scanned));
	return { ...(scanned as EvaluationBundle), bundle_hash };
}

function caller(zone: TrustZone): CallerIdentity {
	return { zone };
}

function makeContender(latest_commit: string | null): ContenderRecord {
	return {
		contender_id: "contender-1",
		agent_id: "agent-1",
		fork_repo: "fork-1",
		fork_lineage: { parent_repo: "acme/api", parent_commit: "base123" },
		fork_base: "base123",
		token_id: "tok-1",
		token_ids: ["tok-1"],
		status: "forked",
		claim_work_id: null,
		latest_commit,
	};
}

/** An authority that has observed contender-1 push `latest` (default csha1,
 *  the SHA makeBundle evaluates). */
function observedAuthority(latest: string | null = "csha1"): AuthorityState {
	const state = createAuthority(makeTask());
	return { ...state, contenders: { "contender-1": makeContender(latest) } };
}

describe("evidence submission authorization", () => {
	it("evaluation domain → RECORDED", async () => {
		const ctx = makeCtx();
		const state = observedAuthority();
		const bundle = await makeBundle();
		const { state: s2, outcome } = await submitEvaluation(state, bundle, caller("evaluation_domain"), ctx);
		assert.equal(outcome, "RECORDED");
		assert.equal(s2.evaluations["csha1"].bundle_hash, bundle.bundle_hash);
	});

	it("contender zone → rejected (attack #6: contender-supplied evidence inadmissible)", async () => {
		const ctx = makeCtx();
		const state = observedAuthority();
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
		const state = observedAuthority();
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
		const state = observedAuthority();
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
		const state = observedAuthority();
		const bundle = await makeBundle();
		const first = await submitEvaluation(state, bundle, caller("evaluation_domain"), ctx);
		assert.equal(first.outcome, "RECORDED");
		const ledgerLen = first.state.ledger.length;
		const second = await submitEvaluation(first.state, bundle, caller("evaluation_domain"), ctx);
		assert.equal(second.outcome, "ACK_DUP");
		assert.equal(second.state, first.state, "ACK_DUP must return the state object unchanged");
		assert.equal(second.state.ledger.length, ledgerLen, "ACK_DUP must not append a ledger entry");
	});

	it("re-evaluation before candidate labels exist (changed bundle, same candidate) → RECORDED (overwrites)", async () => {
		const ctx = makeCtx();
		const state = observedAuthority();
		const v1 = await makeBundle({ hidden_oracle: { passed: true, total: 2, failed: [] as string[] } });
		const first = await submitEvaluation(state, v1, caller("evaluation_domain"), ctx);
		const v2 = await makeBundle({ hidden_oracle: { passed: true, total: 3, failed: [] as string[] } });
		assert.notEqual(v2.bundle_hash, v1.bundle_hash, "the re-evaluation must differ");
		const second = await submitEvaluation(first.state, v2, caller("evaluation_domain"), ctx);
		assert.equal(second.outcome, "RECORDED");
		assert.equal(second.state.evaluations["csha1"].bundle_hash, v2.bundle_hash);
	});

	it("a malformed evaluation_config_sha256 → rejected; a well-formed one is recorded", async () => {
		const ctx = makeCtx();
		for (const bad of ["", "abc", "E".repeat(64), "g".repeat(64), 7]) {
			const bundle = await makeBundle({ evaluation_config_sha256: bad as never });
			await assert.rejects(
				submitEvaluation(observedAuthority(), bundle, caller("evaluation_domain"), ctx),
				/evaluation_config_sha256/,
				JSON.stringify(bad),
			);
		}
		const good = await makeBundle({ evaluation_config_sha256: "0a".repeat(32) });
		const { outcome } = await submitEvaluation(observedAuthority(), good, caller("evaluation_domain"), ctx);
		assert.equal(outcome, "RECORDED");
	});

	it("bundle for a different task → rejected", async () => {
		const ctx = makeCtx();
		const state = observedAuthority();
		const bundle = await makeBundle({ task_hash: "some-other-task" });
		// Recompute the hash after changing task_hash (makeBundle already did).
		await assert.rejects(
			submitEvaluation(state, bundle, caller("evaluation_domain"), ctx),
			/task_hash mismatch/,
		);
	});
});

describe("tamper quarantine (specs/amendments/tamper-quarantine-v1.md)", () => {
	const tampered = {
		exact_baseline: true,
		scope_compliance: true,
		valid_tool_states: true,
		no_eval_tampering: false,
		provenance_complete: true,
	};

	it("a recorded bundle that names changed evaluation files quarantines the contender and returns its effects", async () => {
		const ctx = makeCtx();
		const bundle = await makeBundle({ admission: tampered, eval_file_changes: ["package.json", "test/sum.test.js"] });
		const r = await submitEvaluation(observedAuthority(), bundle, caller("evaluation_domain"), ctx);
		assert.equal(r.outcome, "RECORDED");
		const record = r.state.quarantine["contender-1"];
		assert.equal(record?.status, "QUARANTINED");
		assert.equal(record?.trigger, "eval_file_modification");
		assert.equal(record?.evidence_hash, bundle.bundle_hash, "the bundle is the mechanical evidence");
		assert.equal(r.state.evaluations["csha1"].tainted, true);
		assert.deepEqual(
			r.effects.map((e) => (e.kind === "revoke_token" ? `${e.kind}:${e.token_id}` : e.kind)),
			["revoke_token:tok-1", "cancel_workflow", "notify"],
		);
		assert.deepEqual(
			r.state.ledger.slice(-2).map((e) => e.kind),
			["evaluation_submitted", "contender_quarantined"],
		);
	});

	it("tampering through out-of-scope paths alone fails the gate but does not quarantine", async () => {
		const ctx = makeCtx();
		const bundle = await makeBundle({ admission: { ...tampered, scope_compliance: false }, eval_file_changes: [] });
		const r = await submitEvaluation(observedAuthority(), bundle, caller("evaluation_domain"), ctx);
		assert.equal(r.outcome, "RECORDED");
		assert.equal(r.state.quarantine["contender-1"], undefined);
		assert.deepEqual(r.effects, []);
	});

	it("a contender already in quarantine is not quarantined again", async () => {
		const ctx = makeCtx();
		const first = await makeBundle({ admission: tampered, eval_file_changes: ["package.json"] });
		const r1 = await submitEvaluation(observedAuthority(), first, caller("evaluation_domain"), ctx);
		const second = await makeBundle({ admission: tampered, eval_file_changes: ["jest.config.js"] });
		const r2 = await submitEvaluation(r1.state, second, caller("evaluation_domain"), ctx);
		assert.equal(r2.outcome, "RECORDED");
		assert.deepEqual(r2.effects, []);
		assert.equal(r2.state.quarantine["contender-1"]?.evidence_hash, first.bundle_hash, "the first evidence stands");
	});

	it("eval_file_changes must be a list of paths and agree with no_eval_tampering", async () => {
		const ctx = makeCtx();
		for (const [label, overrides] of [
			["not a list", { admission: tampered, eval_file_changes: "package.json" }],
			["empty path", { admission: tampered, eval_file_changes: [""] }],
			["not a string", { admission: tampered, eval_file_changes: [7] }],
			["changes but no tampering", { eval_file_changes: ["package.json"] }],
		] as const) {
			const bundle = await makeBundle(overrides as never);
			await assert.rejects(
				submitEvaluation(observedAuthority(), bundle, caller("evaluation_domain"), ctx),
				/eval_file_changes/,
				label,
			);
		}
	});
});

describe("evidence binding: latest observed commit, no replacement after labels", () => {
	it("(b) a bundle whose candidate_sha is not the contender's latest observed commit → rejected", async () => {
		const ctx = makeCtx();
		const bundle = await makeBundle(); // evaluates csha1 for contender-1
		const cases: Array<[string, AuthorityState, RegExp]> = [
			["contender moved on to csha2", observedAuthority("csha2"), /latest observed commit/],
			["no push observed yet", observedAuthority(null), /latest observed commit/],
			["contender unknown to the authority", createAuthority(makeTask()), /unknown contender/],
		];
		for (const [label, state, reason] of cases) {
			await assert.rejects(
				submitEvaluation(state, bundle, caller("evaluation_domain"), ctx),
				reason,
				`${label}: evidence for csha1 must be rejected`,
			);
			assert.equal(state.evaluations["csha1"], undefined, `${label}: nothing recorded`);
		}
	});

	it("(a) a second bundle for a SHA after candidate labels are assigned → rejected and ledgered", async () => {
		const ctx = makeCtx();
		const v1 = await makeBundle({ hidden_oracle: { passed: false, total: 2, failed: ["hidden-1"] } });
		const first = await submitEvaluation(observedAuthority(), v1, caller("evaluation_domain"), ctx);
		assert.equal(first.outcome, "RECORDED");
		const labeled = await assignCandidateLabels(first.state, ["csha1"], ctx);
		assert.equal(labeled.labels["candidate-0"], "csha1");

		// Same candidate, different (better-looking) evidence after verifiers can see the label.
		const v2 = await makeBundle({ hidden_oracle: { passed: true, total: 2, failed: [] as string[] } });
		assert.notEqual(v2.bundle_hash, v1.bundle_hash);
		const second = await submitEvaluation(labeled.state, v2, caller("evaluation_domain"), ctx);

		assert.equal(second.outcome, "REPLACEMENT_REJECTED");
		assert.equal(second.state.evaluations["csha1"].bundle_hash, v1.bundle_hash, "the labeled evidence stands");
		const last = second.state.ledger[second.state.ledger.length - 1];
		assert.equal(last.kind, "evidence_replacement_rejected");
		assert.equal(
			last.payload_hash,
			await sha256Hex(
				canonicalJson({
					candidate_sha: "csha1",
					contender_id: "contender-1",
					recorded_bundle_hash: v1.bundle_hash,
					rejected_bundle_hash: v2.bundle_hash,
					submitted_by_zone: "evaluation_domain",
				}),
			),
			"the ledger entry commits to both bundle hashes",
		);

		// An identical retry of the labeled evidence still converges.
		const retry = await submitEvaluation(second.state, v1, caller("evaluation_domain"), ctx);
		assert.equal(retry.outcome, "ACK_DUP");
		assert.equal(retry.state, second.state);
	});

	it("TaskAuthority /evidence: 422 for a non-latest SHA; 409 + persisted ledger entry for a replacement after labels", async () => {
		const storage = memoryStorage();
		const authority = new TaskAuthority({ storage, id: { toString: () => "task-ea" } } as never, {});
		assert.equal((await rpc(authority, "POST", "/init", { task: makeTask() })).status, 200);
		const contender = await rpc(authority, "POST", "/contender", { contender: makeContender(null) });
		assert.equal(contender.status, 200);
		const v1 = await makeBundle();
		const evaluation = { zone: "evaluation_domain" };

		const unobserved = await rpc(authority, "POST", "/evidence", { bundle: v1, caller: evaluation });
		assert.equal(unobserved.status, 422, "no push of csha1 observed yet");

		const push = { namespace: "push", repo: "fork-1", ref: "refs/heads/main", before: "base123", after: "csha1" };
		assert.equal((await rpc(authority, "POST", "/event", { event: push })).status, 200);
		assert.equal((await rpc(authority, "POST", "/evidence", { bundle: v1, caller: evaluation })).status, 200);
		assert.equal((await rpc(authority, "POST", "/candidate-labels", { candidate_shas: ["csha1"] })).status, 200);

		const v2 = await makeBundle({ hidden_oracle: { passed: true, total: 3, failed: [] as string[] } });
		const replaced = await rpc(authority, "POST", "/evidence", { bundle: v2, caller: evaluation });
		assert.equal(replaced.status, 409);
		assert.equal(replaced.body.error, "evidence_replacement_rejected");

		const state = (await rpc(authority, "GET", "/state")).body as AuthorityState;
		assert.equal(state.evaluations["csha1"].bundle_hash, v1.bundle_hash, "stored evidence unchanged");
		assert.equal(state.ledger[state.ledger.length - 1].kind, "evidence_replacement_rejected", "the rejection is persisted");
	});
});

/** In-memory Durable Object storage: structured-clone round-trips, one transaction at a time. */
function memoryStorage() {
	const data = new Map<string, unknown>();
	let queue: Promise<unknown> = Promise.resolve();
	return {
		get: async (k: string) => structuredClone(data.get(k)),
		put: async (k: string, v: unknown) => void data.set(k, structuredClone(v)),
		transaction<T>(fn: (txn: unknown) => Promise<T>): Promise<T> {
			const run = queue.then(() => fn(undefined));
			queue = run.catch(() => undefined);
			return run;
		},
	};
}

async function rpc(authority: TaskAuthority, method: string, path: string, body?: unknown) {
	const res = await authority.fetch(
		new Request(`https://task-authority${path}`, {
			method,
			headers: { "content-type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
		}),
	);
	return { status: res.status, body: (await res.json()) as any };
}
