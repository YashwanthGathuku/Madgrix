/**
 * The Worker's verdict, rebase and promote routes when the destination moves
 * (specs/amendments/rebase-ancestry-v1.md), and the promotion container's
 * answers as the PromotionWorkflow sees them
 * (specs/amendments/promotion-runtime-v1.md).
 *
 * Drives the real Worker router and real TaskAuthority Durable Objects over
 * FakeArtifacts with the shared harness (test/helpers/worker-harness.ts): the
 * promotion container runs the container's procedures over the same
 * repositories (src/harness/fake-container.ts, the model
 * test/promotion-fixtures.test.ts holds to container/promote.sh and
 * container/rebase.sh) or returns a canned answer, and the Workflow binding
 * runs the Worker's PromotionWorkflow when a test drains it.
 *
 * node --test test/rebase-route.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { verifyWithTrustedKey } from "../src/cli/verify.ts";
import {
	BASELINE_TREE,
	FIXED_TREE,
	TOKENS,
	authorityState,
	call,
	evidence,
	issuedPermit,
	json,
	makeHarness,
	moveDestination,
	observe,
	push,
	verdict,
	worker,
	type Harness,
} from "./helpers/worker-harness.ts";

function promote(h: Harness, permit_id: string) {
	return call(h, "POST", `/tasks/${h.taskId}/promote`, { token: TOKENS.control, body: { permit_id } });
}

function poll(h: Harness, permit_id: string) {
	return call(h, "GET", `/tasks/${h.taskId}/promotions/${permit_id}`, { token: TOKENS.control });
}

describe("the destination moved after the candidate was reviewed", () => {
	it("verdict → 409 REBASE_REQUIRED; /rebase → a new SHA, evaluated again; its permit at the new head PROMOTES with base and parent", async () => {
		const h = await makeHarness();
		const X = await push(h, FIXED_TREE, h.baseline);
		await evidence(h, X, "2026-10-03T09:10:00Z");
		const H2 = await moveDestination(h, { ...BASELINE_TREE, "docs/usage.md": "# Usage\n" });

		const refused = await verdict(h, X);
		assert.equal(refused.status, 409, JSON.stringify(refused.body));
		assert.equal(refused.body.verdict.state, "ACCEPT");
		assert.equal(refused.body.permit, null);
		assert.equal(refused.body.outcome, "REBASE_REQUIRED");
		assert.equal(refused.body.destination_head, H2);
		assert.deepEqual(refused.body.bases, [h.baseline]);
		assert.deepEqual(Object.keys((await authorityState(h)).permits), [], "no permit exists");

		const forkTokensBefore = (await (await h.fake.get(h.forkRepo)).listTokens()).length;
		const rebased = await call(h, "POST", `/tasks/${h.taskId}/rebase`, {
			token: TOKENS.control,
			body: { contender_id: h.contenderId, destination_repo: "canonical" },
		});
		assert.equal(rebased.status, 200, JSON.stringify(rebased.body));
		assert.equal(rebased.body.outcome, "REBASED");
		assert.equal(rebased.body.onto, H2);
		assert.equal(rebased.body.candidate_sha, X);
		assert.equal(rebased.body.authority, "RECORDED");
		const X2 = rebased.body.rebased_sha;
		assert.notEqual(X2, X, "the rebase makes a new SHA");
		assert.equal(await (await h.fake.get(h.forkRepo)).getHead(), X2, "pushed to the contender's fork");
		assert.equal(await (await h.fake.get("canonical")).getHead(), H2, "nothing written to the destination");
		const forkTokens = await (await h.fake.get(h.forkRepo)).listTokens();
		assert.equal(forkTokens.length, forkTokensBefore + 1, "one fork write token minted for the rebase");
		assert.equal(forkTokens.at(-1)?.state, "revoked", "and revoked when it finished");
		assert.equal(h.containerCalls.at(-1).action, "rebase");

		let state = await authorityState(h);
		assert.equal(state.contenders[h.contenderId].latest_commit, X2, "the rebased commit re-enters evaluation");
		assert.deepEqual(
			state.contenders[h.contenderId].rebases?.map((r) => [r.outcome, r.from_sha, r.onto, r.new_sha]),
			[["REBASED", X, H2, X2]],
		);
		assert.equal(state.evaluations[X2], undefined, "no evidence yet for the new SHA");

		await observe(h, X, X2); // the rebase's push, as the queue delivers it
		await evidence(h, X2, "2026-10-03T09:20:00Z");
		const issued = await verdict(h, X2);
		assert.equal(issued.status, 200, JSON.stringify(issued.body));
		assert.equal(issued.body.outcome, "ISSUED");
		assert.equal(issued.body.permit.winner_candidate_sha, X2);
		assert.equal(issued.body.permit.expected_destination_head, H2);

		const started = await promote(h, issued.body.permit.permit_id);
		assert.equal(started.status, 202, JSON.stringify(started.body));
		await h.workflow.drain();
		const promoted = await poll(h, issued.body.permit.permit_id);
		assert.equal(promoted.body.status, "complete", JSON.stringify(promoted.body));
		assert.equal(promoted.body.result.status, 200);
		assert.equal(promoted.body.result.body.outcome, "PROMOTED");
		assert.equal(promoted.body.result.body.promoted_sha, X2);
		assert.equal(await (await h.fake.get("canonical")).getHead(), X2, "fast-forwarded to the rebased commit");

		state = await authorityState(h);
		assert.equal(state.permits[issued.body.permit.permit_id].consumed, true);
		const bundle = (await call(h, "GET", `/tasks/${h.taskId}/bundle`, { token: TOKENS.control })).body;
		assert.equal(bundle.version, 3);
		assert.deepEqual([bundle.ship.commit, bundle.ship.base, bundle.ship.parent], [X2, H2, H2]);
		const verified = await verifyWithTrustedKey(bundle, h.pinnedKeyDerHex);
		assert.equal(verified.verified, true, JSON.stringify(verified.lines));
		assert.equal(verified.lines.find((l) => l.label === "destination base")?.status, "OK");
	});

	it("/rebase CONFLICT → 409 with the paths; the task is escalated with the paths as data; nothing is pushed", async () => {
		const h = await makeHarness();
		const X = await push(h, { ...FIXED_TREE, "README.md": "acme api (contender)\n" }, h.baseline);
		await evidence(h, X, "2026-10-03T09:10:00Z");
		await moveDestination(h, { ...BASELINE_TREE, "README.md": "acme api (destination)\n" });

		const res = await call(h, "POST", `/tasks/${h.taskId}/rebase`, {
			token: TOKENS.control,
			body: { contender_id: h.contenderId, destination_repo: "canonical" },
		});
		assert.equal(res.status, 409, JSON.stringify(res.body));
		assert.equal(res.body.outcome, "CONFLICT");
		assert.deepEqual(res.body.paths, ["README.md"]);
		assert.equal(res.body.authority, "ESCALATED");
		assert.equal(await (await h.fake.get(h.forkRepo)).getHead(), X, "the fork is unchanged");

		const state = await authorityState(h);
		assert.equal(state.task_status, "escalated");
		const escalation = state.escalations.at(-1)!;
		assert.deepEqual(escalation.data, {
			kind: "rebase_conflict",
			contender_id: h.contenderId,
			candidate_sha: X,
			onto: res.body.onto,
			paths: ["README.md"],
			paths_total: 1,
		});
		assert.ok(!escalation.reason.includes("README.md"));
		assert.equal(state.contenders[h.contenderId].rebases, undefined, "a conflict records no ancestry");
	});

	it("/rebase passes a container's retryable 503 through as a JSON 503", async () => {
		const h = await makeHarness();
		const X = await push(h, FIXED_TREE, h.baseline);
		await moveDestination(h, { ...BASELINE_TREE, "docs/usage.md": "# Usage\n" });
		h.containerAnswer = async () => json({ error: "container_not_running", retryable: true, attempts: 7 }, 503);
		const res = await call(h, "POST", `/tasks/${h.taskId}/rebase`, {
			token: TOKENS.control,
			body: { contender_id: h.contenderId, destination_repo: "canonical" },
		});
		assert.equal(res.status, 503, JSON.stringify(res.body));
		assert.equal(res.body.error, "container_not_running");
		assert.equal(res.body.retryable, true);
		assert.equal(res.body.candidate_sha, X);
		assert.equal((await authorityState(h)).contenders[h.contenderId].rebases, undefined, "nothing recorded");
	});

	it("/rebase refuses a quarantined contender and needs the control plane", async () => {
		const h = await makeHarness();
		const X = await push(h, FIXED_TREE, h.baseline);
		const anon = await call(h, "POST", `/tasks/${h.taskId}/rebase`, {
			token: TOKENS.agent,
			body: { contender_id: h.contenderId, destination_repo: "canonical" },
		});
		assert.equal(anon.status, 401);
		await evidence(h, X, "2026-10-03T09:10:00Z");
		// Evidence naming a changed evaluation file quarantines the contender.
		const tampered = await h.fake.pushAsToken({
			repo: h.forkRepo,
			ref: "main",
			tree: { ...FIXED_TREE, "test/a.test.js": "process.exit(0)\n" },
			message: "tamper",
			parents: [X],
			token: h.forkToken,
		});
		await observe(h, X, tampered);
		await evidence(h, tampered, "2026-10-03T09:30:00Z", {
			admission: { exact_baseline: true, scope_compliance: true, valid_tool_states: true, no_eval_tampering: false, provenance_complete: true },
			eval_file_changes: ["test/a.test.js"],
		});
		const calls = h.containerCalls.length;
		const res = await call(h, "POST", `/tasks/${h.taskId}/rebase`, {
			token: TOKENS.control,
			body: { contender_id: h.contenderId, destination_repo: "canonical" },
		});
		assert.equal(res.status, 409);
		assert.equal(res.body.error, "contender_quarantined");
		assert.equal(h.containerCalls.length, calls, "the container is never asked");
	});
});

describe("promote: the container's answers, as the PromotionWorkflow sees them", () => {
	for (const [outcome, exit] of [
		["PUSH_REJECTED", 44],
		["UNSUPPORTED_TREE_ENTRY", 46],
	] as const) {
		it(`a terminal ${outcome} (promote.sh exit ${exit}) completes the instance with the 409, unretried; the permit stays unconsumed`, async () => {
			const { h, permit } = await issuedPermit();
			h.containerAnswer = async () => json({ outcome }, 409);
			assert.equal((await promote(h, permit.permit_id)).status, 202);
			await h.workflow.drain();
			const done = await poll(h, permit.permit_id);
			assert.equal(done.body.status, "complete", JSON.stringify(done.body));
			assert.equal(done.body.result.status, 409);
			assert.equal(done.body.result.body.outcome, outcome);
			assert.equal(h.workflow.instances.get(permit.permit_id)!.attempts, 1, "returned, not thrown: a step retries only a throw");
			assert.equal((await authorityState(h)).permits[permit.permit_id].consumed, false);
		});
	}

	it("a git failure is a 502 the step retries (five retries, exponential from 10 s), then the instance errors", async () => {
		const { h, permit } = await issuedPermit();
		h.containerAnswer = async () => json({ outcome: "GIT_ERROR", detail: "fatal: unable to access" }, 502);
		const direct = await worker.runPromotion(h.env as never, h.taskId, permit.permit_id);
		assert.equal(direct.status, 502);

		const steps: Array<[string, unknown]> = [];
		const workflow = new worker.PromotionWorkflow({} as never, h.env as never);
		await assert.rejects(
			workflow.run({ payload: { task_id: h.taskId, permit_id: permit.permit_id } }, {
				do: (name: string, config: unknown, fn: () => Promise<unknown>) => (steps.push([name, config]), fn()),
			} as never),
			/promotion attempt failed: HTTP 502/,
		);
		assert.deepEqual(steps, [[`promote/${permit.permit_id}`, worker.PROMOTION_STEP_CONFIG]]);
		assert.deepEqual(worker.PROMOTION_STEP_CONFIG.retries, { limit: 5, delay: "10 seconds", backoff: "exponential" });

		assert.equal((await promote(h, permit.permit_id)).status, 202);
		await h.workflow.drain();
		const done = await poll(h, permit.permit_id);
		assert.equal(done.body.status, "errored", JSON.stringify(done.body));
		assert.match(done.body.error.message, /HTTP 502/);
		assert.equal(h.workflow.instances.get(permit.permit_id)!.attempts, 6);
		assert.equal((await authorityState(h)).permits[permit.permit_id].consumed, false);
	});

	it("a PROMOTED answer whose base or commit is not the permit's is not finalized", async () => {
		const { h, X, permit } = await issuedPermit();
		const good = { outcome: "PROMOTED", promoted_sha: X, tree_sha256: permit.winning_tree_sha256, base: permit.expected_destination_head, parent: h.baseline };
		for (const bad of [{ ...good, base: "f".repeat(64) }, { ...good, promoted_sha: "e".repeat(64) }, { ...good, parent: undefined }]) {
			h.containerAnswer = async () => json(bad, 200);
			const res = await worker.runPromotion(h.env as never, h.taskId, permit.permit_id);
			assert.equal(res.status, 502, JSON.stringify(bad));
			assert.equal(res.body.error, "promotion_container_invalid_result");
		}
		assert.equal((await authorityState(h)).permits[permit.permit_id].consumed, false);
		// The real fast-forward then promotes; the ship's parent comes from the commit.
		h.containerAnswer = null;
		assert.equal((await promote(h, permit.permit_id)).status, 202);
		await h.workflow.drain();
		const done = await poll(h, permit.permit_id);
		assert.equal(done.body.result?.status, 200, JSON.stringify(done.body));
		const bundle = (await call(h, "GET", `/tasks/${h.taskId}/bundle`, { token: TOKENS.control })).body;
		assert.deepEqual([bundle.ship.commit, bundle.ship.base, bundle.ship.parent], [X, h.baseline, h.baseline]);
	});
});
