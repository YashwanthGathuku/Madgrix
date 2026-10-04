/**
 * POST /tasks/:id/promote starts a PromotionWorkflow instance whose id is the
 * permit id, and GET /tasks/:id/promotions/:permit_id reports its status
 * (specs/amendments/promotion-runtime-v1.md; spec 5 §5: the promote operation
 * id is the permit id).
 *
 * The Workflow binding is a stand-in (test/helpers/fake-workflow.ts): its
 * instances run the Worker's real PromotionWorkflow class when a test drains
 * them. Everything else is the shared Worker harness
 * (test/helpers/worker-harness.ts).
 *
 * node --test test/promotion-workflow.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	FIXED_TREE,
	TOKENS,
	authorityState,
	call,
	evidence,
	issuedPermit,
	json,
	push,
	type Harness,
} from "./helpers/worker-harness.ts";

function promote(h: Harness, permit_id: string) {
	return call(h, "POST", `/tasks/${h.taskId}/promote`, { token: TOKENS.control, body: { permit_id } });
}

function poll(h: Harness, permit_id: string) {
	return call(h, "GET", `/tasks/${h.taskId}/promotions/${permit_id}`, { token: TOKENS.control });
}

describe("POST /promote starts one PromotionWorkflow instance per permit", () => {
	it("answers 202 with the instance id (= permit id); the promotion runs in the instance; polling returns its result", async () => {
		const { h, X, permit } = await issuedPermit();
		const started = await promote(h, permit.permit_id);
		assert.equal(started.status, 202, JSON.stringify(started.body));
		assert.deepEqual(started.body, {
			instance_id: permit.permit_id,
			status: "queued",
			status_url: `/tasks/${h.taskId}/promotions/${permit.permit_id}`,
		});
		assert.deepEqual([...h.workflow.instances.keys()], [permit.permit_id]);
		assert.deepEqual(h.workflow.instances.get(permit.permit_id)!.params, { task_id: h.taskId, permit_id: permit.permit_id });
		assert.equal(h.containerCalls.length, 0, "nothing is promoted until the instance runs");
		assert.equal(await (await h.fake.get("canonical")).getHead(), h.baseline);

		const queued = await poll(h, permit.permit_id);
		assert.equal(queued.status, 200);
		assert.equal(queued.body.status, "queued");

		await h.workflow.drain();
		const done = await poll(h, permit.permit_id);
		assert.equal(done.status, 200, JSON.stringify(done.body));
		assert.equal(done.body.instance_id, permit.permit_id);
		assert.equal(done.body.status, "complete");
		assert.equal(done.body.result.status, 200);
		assert.equal(done.body.result.body.outcome, "PROMOTED");
		assert.equal(done.body.result.body.promoted_sha, X);
		assert.equal(await (await h.fake.get("canonical")).getHead(), X);
		assert.equal((await authorityState(h)).permits[permit.permit_id].consumed, true);
	});

	it("a repeated POST /promote does not start a second instance", async () => {
		const { h, permit } = await issuedPermit();
		const first = await promote(h, permit.permit_id);
		const second = await promote(h, permit.permit_id);
		assert.equal(first.status, 202);
		assert.equal(second.status, 202);
		assert.equal(second.body.instance_id, permit.permit_id);
		assert.equal(h.workflow.instances.size, 1);
		await h.workflow.drain();
		const third = await promote(h, permit.permit_id);
		assert.equal(third.status, 202);
		assert.equal(third.body.status, "complete", "the existing instance's status, not a new run");
		assert.equal(h.workflow.instances.size, 1);
	});

	it("an unknown or malformed permit id starts nothing", async () => {
		const { h } = await issuedPermit();
		const unknown = await promote(h, "a".repeat(64));
		assert.equal(unknown.status, 404);
		assert.equal(unknown.body.outcome, "UNKNOWN_PERMIT");
		const malformed = await promote(h, "../not-a-permit");
		assert.equal(malformed.status, 400);
		assert.equal(h.workflow.createCalls, 0);
		const neverStarted = await poll(h, "a".repeat(64));
		assert.equal(neverStarted.status, 404);
		assert.equal(neverStarted.body.outcome, "UNKNOWN_PERMIT", "a permit this task does not hold");
		// A permit the task holds, with no instance yet.
		const { h: other, permit } = await issuedPermit();
		const notStarted = await poll(other, permit.permit_id);
		assert.equal(notStarted.status, 404);
		assert.deepEqual(notStarted.body, { error: "promotion_not_started", permit_id: permit.permit_id });
		// Another task's URL does not reach this task's instance.
		await promote(other, permit.permit_id);
		const elsewhere = await call(other, "GET", `/tasks/${h.taskId}/promotions/${permit.permit_id}`, { token: TOKENS.control });
		assert.equal(elsewhere.status, 404);
	});

	it("a retryable container failure is retried by the Workflow; a terminal refusal completes the instance with the 409", async () => {
		const { h, X, permit } = await issuedPermit();
		let failures = 1;
		h.containerAnswer = async (body) => {
			if (failures-- > 0) return json({ error: "container_exec_timeout", retryable: true, deadline_ms: 60_000 }, 503);
			h.containerAnswer = null;
			return h.env.PROMOTION_CONTAINER.get(h.env.PROMOTION_CONTAINER.idFromName("model")).fetch(
				new Request("https://promotion/run", { method: "POST", body: JSON.stringify(body) }),
			);
		};
		await promote(h, permit.permit_id);
		await h.workflow.drain();
		const done = await poll(h, permit.permit_id);
		assert.equal(done.body.status, "complete", JSON.stringify(done.body));
		assert.equal(done.body.result.body.promoted_sha, X);
		assert.equal(h.workflow.instances.get(permit.permit_id)!.attempts, 2, "one retry");

		const other = await issuedPermit();
		other.h.containerAnswer = async () => json({ outcome: "PUSH_REJECTED", detail: "refused" }, 409);
		await promote(other.h, other.permit.permit_id);
		await other.h.workflow.drain();
		const refused = await poll(other.h, other.permit.permit_id);
		assert.equal(refused.body.status, "complete");
		assert.equal(refused.body.result.status, 409);
		assert.equal(refused.body.result.body.outcome, "PUSH_REJECTED");
		assert.equal(other.h.workflow.instances.get(other.permit.permit_id)!.attempts, 1, "a 409 is not retried");
		assert.equal((await authorityState(other.h)).permits[other.permit.permit_id].consumed, false);
	});

	it("a task authority that fails while the step runs is retried, not taken for a missing task", async () => {
		const { h, X, permit } = await issuedPermit();
		await promote(h, permit.permit_id);
		// The authority's next /state read fails (a storage outage: its JSON 500).
		const real = h.env.TASK_AUTHORITY;
		let failures = 1;
		h.env.TASK_AUTHORITY = {
			idFromName: (name: string) => real.idFromName(name),
			get(id: { toString(): string }) {
				const stub = real.get(id);
				return {
					fetch: async (request: Request) =>
						new URL(request.url).pathname === "/state" && failures-- > 0
							? json({ error: "authority_internal_error" }, 500)
							: stub.fetch(request),
				};
			},
		};
		await h.workflow.drain();
		const done = await poll(h, permit.permit_id);
		assert.equal(done.body.status, "complete", JSON.stringify(done.body));
		assert.equal(done.body.result.status, 200, JSON.stringify(done.body.result));
		assert.equal(done.body.result.body.promoted_sha, X);
		assert.equal(h.workflow.instances.get(permit.permit_id)!.attempts, 2, "one retry");
	});

	it("an answer the Worker cannot parse is never passed to .json(); the Workflow retries it, then reports the error", async () => {
		const { h, permit } = await issuedPermit();
		let parsed = 0;
		h.containerAnswer = async () => {
			const res = new Response("<html>502 Bad Gateway</html>", { status: 503, headers: { "content-type": "text/html" } });
			res.json = async () => {
				parsed++;
				throw new SyntaxError("Unexpected token <");
			};
			return res;
		};
		await promote(h, permit.permit_id);
		await h.workflow.drain();
		const done = await poll(h, permit.permit_id);
		assert.equal(done.body.status, "errored", JSON.stringify(done.body));
		assert.match(done.body.error.message, /upstream_not_json/);
		assert.equal(parsed, 0);
		assert.ok(h.workflow.instances.get(permit.permit_id)!.attempts > 1, "retried before giving up");

		// The container recovers; a repeated POST /promote restarts the errored
		// instance (same id) rather than leaving the permit stuck behind it.
		h.containerAnswer = null;
		const again = await promote(h, permit.permit_id);
		assert.equal(again.status, 202);
		assert.equal(again.body.status, "queued");
		assert.equal(h.workflow.instances.size, 1);
		await h.workflow.drain();
		const recovered = await poll(h, permit.permit_id);
		assert.equal(recovered.body.status, "complete", JSON.stringify(recovered.body));
		assert.equal(recovered.body.result.body.outcome, "PROMOTED");
	});
});

describe("quarantine cancels the contender's pending promotions (cancel_workflow)", () => {
	it("a tamper quarantine terminates the queued PromotionWorkflow instance of the contender's permit", async () => {
		const { h, X, permit } = await issuedPermit();
		await promote(h, permit.permit_id);
		// The contender then pushes a candidate that changes a test file; the
		// evaluator reports it and the authority quarantines the contender.
		const tampered = await push(h, { ...FIXED_TREE, "test/a.test.js": "process.exit(0)\n" }, X);
		await evidence(h, tampered, "2026-10-03T09:30:00Z", {
			admission: { exact_baseline: true, scope_compliance: true, valid_tool_states: true, no_eval_tampering: false, provenance_complete: true },
			eval_file_changes: ["test/a.test.js"],
		});
		assert.equal((await authorityState(h)).quarantine[h.contenderId]?.status, "QUARANTINED");
		const cancelled = await poll(h, permit.permit_id);
		assert.equal(cancelled.body.status, "terminated");
		await h.workflow.drain();
		assert.equal(h.containerCalls.length, 0, "the terminated instance never promotes");
	});
});
