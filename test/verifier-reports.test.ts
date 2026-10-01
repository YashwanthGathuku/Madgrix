/**
 * Verifier-report signature enforcement (spec 1 §8; spec 3 §6 attack #11).
 *
 * The task authority holds each verifier's public key registered at task
 * freeze and verifies EVERY submitted report. This file exercises the
 * attack surface directly: unknown verifier, wrong key, unsigned,
 * forged, and tampered reports must each be rejected with a DISTINCT
 * error; only a genuinely signed report is admitted.
 *
 * node --test test/verifier-reports.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { canonicalJson, sha256Hex } from "../src/lib/canonical.ts";
import { createCommitment } from "../src/lib/verifiers.ts";
import { verifierReportPayload } from "../src/lib/verifier-keys.ts";
import { createEd25519Signer } from "../src/lib/signer-node.ts";
import {
	commitVerifier,
	createAuthority,
	defaultCtx,
	registerVerifierKeys,
	revealVerifier,
	submitVerifierReport,
	type Ctx,
} from "../src/lib/task-state.ts";
import type { AuthorityState, TaskRecord, VerdictReport } from "../src/lib/types.ts";

const TASK_HASH = "taskhash-vr";
const POLICY_VERSION = "seam-policy/0.1.0";

function makeTask(): TaskRecord {
	return {
		task_id: "task-vr",
		task_hash: TASK_HASH,
		intent: "fix the thing",
		baseline_repo: "acme/api",
		baseline_commit: "base123",
		behavior_contract: "it works",
		policy_version: POLICY_VERSION,
		frozen_at: "2026-10-01T18:00:00Z",
	};
}

function makeCtx(): Ctx {
	return {
		now: () => "2026-10-01T18:30:00.000Z",
		randomHex: (n: number) => "f".repeat(n * 2),
		sha256Hex,
		selectorPolicyHash: "policyhash",
		policyVersion: POLICY_VERSION,
	};
}

/** A verifier identity: its own private key, never shared with the authority. */
function makeVerifier(verifier_id: string) {
	const signer = createEd25519Signer();
	return {
		verifier_id,
		signer,
		keyid: signer.keyid,
		publicKeyDerHex: signer.publicKeyDerHex,
		async signReport(fields: {
			candidate_label: string;
			verdict: "accept" | "reject" | "abstain";
			reasons: string[];
			keyid?: string;
		}): Promise<VerdictReport> {
			const unsigned = {
				verifier_id,
				candidate_label: fields.candidate_label,
				verdict: fields.verdict,
				reasons: fields.reasons,
				keyid: fields.keyid ?? signer.keyid,
			};
			const sig = await signer.sign(new TextEncoder().encode(verifierReportPayload(unsigned)));
			return { ...unsigned, signature: sig.signature };
		},
	};
}

/** Authority with verifier keys frozen, and verifier-1 committed + revealed. */
async function authorityWithRevealedVerifier(
	ctx: Ctx,
	verifier: ReturnType<typeof makeVerifier>,
	extraVerifiers: ReturnType<typeof makeVerifier>[] = [],
): Promise<{ state: AuthorityState; nonce: string; reference: object }> {
	let state = createAuthority(makeTask());
	state = await registerVerifierKeys(
		state,
		[verifier, ...extraVerifiers].map((v) => ({
			verifier_id: v.verifier_id,
			public_key_der_hex: v.publicKeyDerHex,
		})),
		ctx,
	);
	const reference = { expected_behavior: ["x"], invariants: [], likely_failure_modes: [], evaluation_plan: [], security_expectations: [] };
	const nonce = "nonce-1";
	const commitment = await createCommitment(reference, nonce, TASK_HASH, verifier.verifier_id, POLICY_VERSION, sha256Hex);
	state = await commitVerifier(
		state,
		{
			verifier_id: verifier.verifier_id,
			task_hash: TASK_HASH,
			policy_version: POLICY_VERSION,
			commitment,
			committed_at: ctx.now(),
		},
		ctx,
	);
	const rev = await revealVerifier(state, verifier.verifier_id, reference, nonce, ctx);
	assert.equal(rev.admissible, true);
	return { state: rev.state, nonce, reference };
}

describe("verifier report signature enforcement", () => {
	it("genuinely signed report is accepted", async () => {
		const ctx = makeCtx();
		const v1 = makeVerifier("verifier-1");
		const { state } = await authorityWithRevealedVerifier(ctx, v1);
		const report = await v1.signReport({
			candidate_label: "candidate-7f31",
			verdict: "accept",
			reasons: ["boundary correct"],
		});
		const s2 = await submitVerifierReport(state, report, ctx);
		assert.equal(s2.verdict_reports.length, 1);
		assert.equal(s2.verdict_reports[0].verifier_id, "verifier-1");
	});

	it("unknown verifier_id (no registered key) → rejected", async () => {
		const ctx = makeCtx();
		const v1 = makeVerifier("verifier-1");
		const ghost = makeVerifier("verifier-ghost");
		const { state } = await authorityWithRevealedVerifier(ctx, v1);
		// Commit + reveal as the ghost so the ONLY failure is the missing key.
		const reference = { expected_behavior: ["x"], invariants: [], likely_failure_modes: [], evaluation_plan: [], security_expectations: [] };
		const commitment = await createCommitment(reference, "nonce-g", TASK_HASH, ghost.verifier_id, POLICY_VERSION, sha256Hex);
		let s = await commitVerifier(
			state,
			{ verifier_id: ghost.verifier_id, task_hash: TASK_HASH, policy_version: POLICY_VERSION, commitment, committed_at: ctx.now() },
			ctx,
		);
		s = (await revealVerifier(s, ghost.verifier_id, reference, "nonce-g", ctx)).state;
		const report = await ghost.signReport({ candidate_label: "candidate-7f31", verdict: "accept", reasons: ["ok"] });
		await assert.rejects(submitVerifierReport(s, report, ctx), /unknown verifier_id/);
	});

	it("keyid mismatch (wrong key) → rejected", async () => {
		const ctx = makeCtx();
		const v1 = makeVerifier("verifier-1");
		const v2 = makeVerifier("verifier-2");
		const { state } = await authorityWithRevealedVerifier(ctx, v1, [v2]);
		// v1's report, but carrying v2's keyid: signed payload no longer
		// matches the report's keyid field → caught as wrong key.
		const report = await v1.signReport({
			candidate_label: "candidate-7f31",
			verdict: "accept",
			reasons: ["ok"],
			keyid: v2.keyid,
		});
		await assert.rejects(submitVerifierReport(state, report, ctx), /keyid mismatch/);
	});

	it("unsigned report (empty signature) → rejected", async () => {
		const ctx = makeCtx();
		const v1 = makeVerifier("verifier-1");
		const { state } = await authorityWithRevealedVerifier(ctx, v1);
		const report = await v1.signReport({ candidate_label: "candidate-7f31", verdict: "accept", reasons: ["ok"] });
		await assert.rejects(
			submitVerifierReport(state, { ...report, signature: "" }, ctx),
			/unsigned report/,
		);
	});

	it("forged report (signed by a different key) → rejected", async () => {
		const ctx = makeCtx();
		const v1 = makeVerifier("verifier-1");
		const attacker = makeVerifier("attacker");
		const { state } = await authorityWithRevealedVerifier(ctx, v1);
		// Attacker signs a report CLAIMING to be verifier-1, with v1's
		// keyid: the signature does not verify against v1's registered key.
		const forged = await attacker.signReport({ candidate_label: "candidate-7f31", verdict: "accept", reasons: ["forged"] });
		const forgedAsV1: VerdictReport = {
			...forged,
			verifier_id: "verifier-1",
			keyid: v1.keyid,
		};
		// Re-sign with attacker's key so signature ≠ payload signed by v1.
		const reSigned = await attacker.signer.sign(
			new TextEncoder().encode(
				verifierReportPayload({
					verifier_id: "verifier-1",
					candidate_label: forgedAsV1.candidate_label,
					verdict: forgedAsV1.verdict,
					reasons: forgedAsV1.reasons,
					keyid: v1.keyid,
				}),
			),
		);
		await assert.rejects(
			submitVerifierReport(state, { ...forgedAsV1, signature: reSigned.signature }, ctx),
			/signature verification failed/,
		);
	});

	it("tampered payload (signed accept, submitted as reject) → rejected", async () => {
		const ctx = makeCtx();
		const v1 = makeVerifier("verifier-1");
		const { state } = await authorityWithRevealedVerifier(ctx, v1);
		const signed = await v1.signReport({ candidate_label: "candidate-7f31", verdict: "accept", reasons: ["ok"] });
		const tampered: VerdictReport = { ...signed, verdict: "reject" };
		await assert.rejects(submitVerifierReport(state, tampered, ctx), /signature verification failed/);
	});

	it("key registration is immutable — re-registering a verifier_id throws", async () => {
		const ctx = makeCtx();
		const v1 = makeVerifier("verifier-1");
		const v1b = makeVerifier("verifier-1");
		let state = createAuthority(makeTask());
		state = await registerVerifierKeys(
			state,
			[{ verifier_id: v1.verifier_id, public_key_der_hex: v1.publicKeyDerHex }],
			ctx,
		);
		// Key-swap attempt: same verifier_id, different key material.
		await assert.rejects(
			registerVerifierKeys(
				state,
				[{ verifier_id: v1b.verifier_id, public_key_der_hex: v1b.publicKeyDerHex }],
				ctx,
			),
			/immutable/,
		);
	});

	it("garbage key material is rejected at registration (fail closed)", async () => {
		const ctx = makeCtx();
		const state = createAuthority(makeTask());
		await assert.rejects(
			registerVerifierKeys(state, [{ verifier_id: "v", public_key_der_hex: "not-a-key" }], ctx),
			/invalid public key/,
		);
	});
});
