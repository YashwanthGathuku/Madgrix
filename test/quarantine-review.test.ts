/**
 * Quarantine review enforcement (spec 1 §9.5; spec 3 §7).
 *
 * RELEASED requires BOTH a passing re-run of the mechanical check that
 * fired AND a valid operator-of-record signature. This file proves the
 * signature side: unregistered keys, tampered determinations, and
 * key-swap attempts are all rejected; the trigger-binding is enforced
 * (the re-check must re-run the check that actually fired).
 *
 * (The happy-path RELEASED/REVOKED transitions live in
 * test/task-state.test.ts; this file is the adversarial edge.)
 *
 * node --test test/quarantine-review.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	createAuthority,
	quarantineContender,
	registerOperatorKeys,
	reviewQuarantine,
	type Ctx,
	type QuarantineRecheck,
	type SignedDetermination,
} from "../src/lib/task-state.ts";
import { createEd25519Signer } from "../src/lib/signer-node.ts";
import { quarantineDeterminationPayload } from "../src/lib/verifier-keys.ts";
import { sha256Hex } from "../src/lib/canonical.ts";
import type { AuthorityState, TaskRecord, QuarantineTrigger } from "../src/lib/types.ts";

function makeTask(): TaskRecord {
	return {
		task_id: "task-qr",
		task_hash: "taskhash-qr",
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
		randomHex: (n: number) => "d".repeat(n * 2),
		sha256Hex,
		selectorPolicyHash: "policyhash",
		policyVersion: "seam-policy/0.1.0",
	};
}

function makeOperator() {
	const signer = createEd25519Signer();
	return {
		keyid: signer.keyid,
		publicKeyDerHex: signer.publicKeyDerHex,
		async determine(
			contender_id: string,
			trigger: QuarantineTrigger,
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

function recheck(trigger: QuarantineTrigger, passed: boolean): QuarantineRecheck {
	return { trigger, passed, detail: "re-ran the mechanical check", checked_at: "2026-10-01T19:00:00Z" };
}

/** Fresh authority with one quarantined contender + one registered operator key. */
async function quarantinedSetup(ctx: Ctx, trigger: QuarantineTrigger = "eval_file_modification") {
	const operator = makeOperator();
	let state: AuthorityState = createAuthority(makeTask());
	state = {
		...state,
		contenders: {
			"contender-1": {
				contender_id: "contender-1",
				agent_id: "agent-1",
				fork_repo: "fork-1",
				fork_lineage: { parent_repo: "acme/api", parent_commit: "base123" },
				token_id: "tok-1",
				status: "forked",
				claim_work_id: null,
				latest_commit: null,
			},
		},
	};
	state = await registerOperatorKeys(state, [{ public_key_der_hex: operator.publicKeyDerHex }], ctx);
	const q = await quarantineContender(state, "contender-1", trigger, "evidence-hash", ctx);
	return { state: q.state, operator };
}

describe("quarantine review — signature enforcement", () => {
	it("determination signed by an UNREGISTERED key → rejected", async () => {
		const ctx = makeCtx();
		const { state } = await quarantinedSetup(ctx);
		const rogue = makeOperator(); // never registered
		const det = await rogue.determine("contender-1", "eval_file_modification", "RELEASED", "trust me");
		await assert.rejects(
			reviewQuarantine(state, "contender-1", "RELEASED", recheck("eval_file_modification", true), det, ctx),
			/unknown operator keyid/,
		);
	});

	it("tampered determination (signed RELEASED, submitted as REVOKED) → rejected", async () => {
		const ctx = makeCtx();
		const { state, operator } = await quarantinedSetup(ctx);
		// The signature binds decision=RELEASED; submitting it as REVOKED
		// must fail the signature check.
		const det = await operator.determine("contender-1", "eval_file_modification", "RELEASED", "false positive");
		await assert.rejects(
			reviewQuarantine(state, "contender-1", "REVOKED", recheck("eval_file_modification", false), det, ctx),
			/signature invalid/,
		);
	});

	it("tampered note (signature over a different note) → rejected", async () => {
		const ctx = makeCtx();
		const { state, operator } = await quarantinedSetup(ctx);
		const det = await operator.determine("contender-1", "eval_file_modification", "REVOKED", "confirmed fabrication");
		const edited: SignedDetermination = { ...det, note: "false positive, release it" };
		await assert.rejects(
			reviewQuarantine(state, "contender-1", "REVOKED", recheck("eval_file_modification", false), edited, ctx),
			/signature invalid/,
		);
	});

	it("re-check must name the trigger that fired (trigger binding)", async () => {
		const ctx = makeCtx();
		const { state, operator } = await quarantinedSetup(ctx, "tool_status_fabrication");
		const det = await operator.determine("contender-1", "tool_status_fabrication", "REVOKED", "confirmed");
		await assert.rejects(
			reviewQuarantine(state, "contender-1", "REVOKED", recheck("eval_file_modification", true), det, ctx),
			/does not match the quarantine trigger/,
		);
	});

	it("operator keys are immutable — same keyid re-registered → rejected", async () => {
		const ctx = makeCtx();
		const operator = makeOperator();
		let state: AuthorityState = createAuthority(makeTask());
		state = await registerOperatorKeys(state, [{ public_key_der_hex: operator.publicKeyDerHex }], ctx);
		await assert.rejects(
			registerOperatorKeys(state, [{ public_key_der_hex: operator.publicKeyDerHex }], ctx),
			/immutable/,
		);
	});

	it("reviewing an already-reviewed quarantine → rejected (single-shot)", async () => {
		const ctx = makeCtx();
		const { state, operator } = await quarantinedSetup(ctx);
		const det = await operator.determine("contender-1", "eval_file_modification", "REVOKED", "confirmed fabrication");
		const once = await reviewQuarantine(
			state,
			"contender-1",
			"REVOKED",
			recheck("eval_file_modification", false),
			det,
			ctx,
		);
		const det2 = await operator.determine("contender-1", "eval_file_modification", "RELEASED", "changed mind");
		await assert.rejects(
			reviewQuarantine(once.state, "contender-1", "RELEASED", recheck("eval_file_modification", true), det2, ctx),
			/already REVOKED/,
		);
	});
});
