/**
 * Every error path answers JSON, and the Worker checks a response's
 * content-type before it calls .json() (specs/amendments/promotion-runtime-v1.md).
 *
 * The Worker router and the TaskAuthority Durable Object are driven with
 * stand-ins that fail the way the runtime can: an upstream that answers an
 * HTML error page, a dependency that throws, a request that is not JSON.
 *
 * node --test test/worker-errors.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { TaskAuthority } from "../src/do/TaskAuthority.ts";
import { FakeArtifacts } from "../src/lib/fake-artifacts.ts";
import { TOKENS, call, createContender, json, makeTask, memoryNamespace, worker } from "./helpers/worker-harness.ts";

/** A response that is not JSON, recording whether anyone tried to parse it. */
function htmlResponse(status: number, counter: { parsed: number }): Response {
	const res = new Response("<html><body>Internal Server Error</body></html>", { status, headers: { "content-type": "text/html; charset=utf-8" } });
	res.json = async () => {
		counter.parsed++;
		throw new SyntaxError("Unexpected token '<'");
	};
	return res;
}

function baseEnv(overrides: Record<string, unknown> = {}) {
	return {
		ARTIFACTS: new FakeArtifacts(),
		TASK_AUTHORITY: memoryNamespace((state) => new TaskAuthority(state as never, {})),
		PROMOTION_CONTAINER: memoryNamespace(() => ({ fetch: async () => json({ error: "unused" }, 500) })),
		CONTROL_SERVICE_TOKEN: TOKENS.control,
		AGENT_SERVICE_TOKEN: TOKENS.agent,
		EVALUATION_SERVICE_TOKEN: TOKENS.evaluation,
		...overrides,
	};
}

describe("the Worker checks content-type before .json()", () => {
	it("a task authority answering an HTML error page: never parsed; the Worker answers JSON 502", async () => {
		const counter = { parsed: 0 };
		const env = baseEnv({
			TASK_AUTHORITY: { idFromName: (n: string) => ({ toString: () => n }), get: () => ({ fetch: async () => htmlResponse(500, counter) }) },
		});
		for (const [method, path] of [
			["GET", "/tasks/task_x/ledger"],
			["GET", "/tasks/task_x/context"],
		] as const) {
			const res = await call({ env }, method, path, { token: TOKENS.control });
			assert.equal(res.status, 502, `${method} ${path}: ${JSON.stringify(res.body)}`);
			assert.match(res.contentType ?? "", /^application\/json/);
			assert.equal(res.body.error, "upstream_not_json");
			assert.equal(res.body.upstream, "task_authority");
			assert.equal(res.body.upstream_status, 500);
		}
		assert.equal(counter.parsed, 0, ".json() is never called on a non-JSON answer");
	});

	it("a task authority that fails is a 502, not a missing task", async () => {
		const env = baseEnv({
			TASK_AUTHORITY: {
				idFromName: (n: string) => ({ toString: () => n }),
				get: () => ({ fetch: async () => json({ error: "authority_internal_error" }, 500) }),
			},
		});
		for (const [method, path] of [
			["GET", "/tasks/task_x/ledger"],
			["GET", "/tasks/task_x/context"],
		] as const) {
			const res = await call({ env }, method, path, { token: TOKENS.control });
			assert.equal(res.status, 502, `${method} ${path}: ${JSON.stringify(res.body)}`);
			assert.deepEqual(res.body, {
				error: "task_authority_failed",
				task_id: "task_x",
				upstream_status: 500,
				detail: { error: "authority_internal_error" },
			});
		}
		// Only the authority's own 404 means there is no such task.
		const missing = await call({ env: baseEnv() }, "GET", "/tasks/task_nope/ledger", { token: TOKENS.control });
		assert.equal(missing.status, 404);
		assert.equal(missing.body.error, "task_not_found");
	});

	it("the queue consumer still fails the batch (for redelivery) when the authority's answer is not JSON", async () => {
		const counter = { parsed: 0 };
		const env = baseEnv({
			TASK_AUTHORITY: { idFromName: (n: string) => ({ toString: () => n }), get: () => ({ fetch: async () => htmlResponse(503, counter) }) },
		});
		const message = {
			body: { type: "madgrix.test.push", task_id: "task_x", event: { namespace: "n", repo: "r", ref: "refs/heads/main", before: "a", after: "b" } },
		};
		await assert.rejects(worker.queue({ messages: [message] } as never, env as never));
		assert.equal(counter.parsed, 0);
	});
});

describe("every error path answers JSON", () => {
	it("an exception inside a route is a JSON 500, not a runtime error page", async (t) => {
		const logged = t.mock.method(console, "error", () => {});
		/** Artifacts whose repository reads fail mid-request. */
		class FlakyArtifacts extends FakeArtifacts {
			async get(name: string) {
				const repo = await super.get(name);
				return Object.assign(Object.create(repo), {
					readCommit: async () => {
						throw new Error("artifacts: connection reset");
					},
				});
			}
		}
		const fake = new FlakyArtifacts();
		await fake.create("baseline");
		const baseline = await fake.adminPush({ repo: "baseline", ref: "main", tree: { "a.txt": "a\n" }, message: "baseline" });
		const env = baseEnv({ ARTIFACTS: fake });
		const res = await call({ env }, "POST", "/tasks", {
			token: TOKENS.control,
			body: { intent: "x", baseline_repo: "baseline", baseline_commit: baseline, agent_ids: ["agent-a"] },
		});
		assert.equal(res.status, 500);
		assert.match(res.contentType ?? "", /^application\/json/);
		assert.deepEqual(res.body, { error: "internal_error" }, "the error's detail is logged, not returned");
		assert.equal(logged.mock.callCount(), 1);
	});

	it("a request body that is not JSON is a JSON 415", async () => {
		const res = await call({ env: baseEnv() }, "POST", "/tasks", {
			token: TOKENS.control,
			contentType: "text/plain",
			body: '{"intent":"x"}',
		});
		assert.equal(res.status, 415);
		assert.match(res.contentType ?? "", /^application\/json/);
		assert.equal(res.body.error, "content_type_must_be_json");
	});

	it("an unknown route is a JSON 404", async () => {
		const res = await call({ env: baseEnv() }, "GET", "/nope");
		assert.equal(res.status, 404);
		assert.match(res.contentType ?? "", /^application\/json/);
	});

	it("a retryable container failure while copying the baseline is a JSON 503, and the retried request finishes the copy", async () => {
		/** Artifacts whose fork endpoint fails as the beta one did (artifacts-port.ts, isBetaForkEndpointBug). */
		class BrokenForkArtifacts extends FakeArtifacts {
			async get(name: string) {
				const repo = await super.get(name);
				return Object.assign(Object.create(repo), {
					fork: async () => {
						throw new Error("[10101] Invalid repo name");
					},
				});
			}
		}
		const { h, secret } = await makeTask(new BrokenForkArtifacts());
		let unavailable = 1;
		h.containerAnswer = async (body) => {
			assert.equal(body.action, "copy_baseline");
			if (unavailable-- > 0) return json({ error: "container_not_running", retryable: true, attempts: 7 }, 503);
			// copy-baseline.sh over the fake: import into an empty repository.
			const destination = body.destination_remote.replace(/^fake:\/\//, "");
			const head = await (await h.fake.get(destination)).getHead();
			if (head === body.source_commit) return json({ outcome: "ALREADY_IMPORTED", head });
			if (head !== null) return json({ outcome: "DESTINATION_NOT_EMPTY", head }, 409);
			assert.ok(h.fake.importHistory(body.source_remote.replace(/^fake:\/\//, ""), destination, body.source_commit));
			assert.ok(h.fake.casRef(destination, "main", null, body.source_commit));
			return json({ outcome: "IMPORTED", head: body.source_commit });
		};

		const first = await createContender(h, secret);
		assert.equal(first.status, 503, JSON.stringify(first.body));
		assert.match(first.contentType ?? "", /^application\/json/);
		assert.equal(first.body.retryable, true);
		assert.equal(first.body.token, undefined, "no credential for a fork without the baseline");

		const retry = await createContender(h, secret);
		assert.equal(retry.status, 200, JSON.stringify(retry.body));
		assert.equal(typeof retry.body.token, "string");
		const fork = await h.fake.get(retry.body.fork_repo);
		assert.equal(await fork.getHead(), h.baseline, "the retry copied the frozen baseline");
		assert.equal(h.containerCalls.length, 2);
		const active = (await fork.listTokens()).filter((t) => t.state === "active");
		assert.equal(active.length, 1, "only the contender's credential is left active on the fork");
	});

	it("the TaskAuthority answers a JSON 500 when its storage throws", async (t) => {
		const logged = t.mock.method(console, "error", () => {});
		const authority = new TaskAuthority(
			{
				storage: {
					get: async () => {
						throw new Error("storage: unavailable");
					},
					put: async () => {},
					transaction: async <T>(fn: (txn: unknown) => Promise<T>) => fn(undefined),
				},
				id: { toString: () => "task_x" },
			} as never,
			{},
		);
		const res = await authority.fetch(new Request("https://task-authority/state"));
		assert.equal(res.status, 500);
		assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
		assert.deepEqual(await res.json(), { error: "authority_internal_error" });
		assert.equal(logged.mock.callCount(), 1);
	});
});
