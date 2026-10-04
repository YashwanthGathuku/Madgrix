/**
 * The promotion-container Durable Object's lifecycle around each script run
 * (specs/amendments/promotion-runtime-v1.md):
 *
 * - after start(), exec is retried while the container is not yet running,
 *   waiting 100, 200, 400, 800, 1600 and 3200 ms (at most six retries);
 * - each script run has a 60 s deadline; on expiry the process is killed and
 *   the answer is a retryable 503;
 * - the container is destroyed after every operation (copy_baseline,
 *   promote, rebase), whatever its outcome;
 * - every answer, error or not, is JSON.
 *
 * src/do/PromotionContainer.ts runs against a fake container; the clock is
 * node:test's mock timers, so no test waits in real time.
 *
 * node --test test/promotion-container.test.ts
 */
import { describe, it, type TestContext } from "node:test";
import assert from "node:assert/strict";

import { PromotionContainer } from "../src/do/PromotionContainer.ts";

const HEX40 = (c: string) => c.repeat(40);
const HEX64 = (c: string) => c.repeat(64);
const enc = (s: string) => new TextEncoder().encode(s).buffer;

const PROMOTED_STDOUT =
	`OUTCOME=PROMOTED\nPROMOTED_SHA=${HEX40("c")}\nTREE_DIGEST=${HEX64("d")}\nBASE=${HEX40("b")}\nPARENT=${HEX40("b")}\n`;

interface FakeOptions {
	/** exec throws a "not running" error this many times first. */
	notRunningFor?: number;
	/** exec throws this (any other failure). */
	execError?: string;
	/** exec takes this long to return its process. */
	execDelayMs?: number;
	/** start() throws this. */
	startError?: string;
	/** The script's result, or "hang": output() never settles. */
	result?: { exitCode: number; stdout: string; stderr?: string } | "hang";
}

function fakeContainer(opts: FakeOptions) {
	const calls = { start: 0, exec: [] as { at: number; argv: string[] }[], kill: 0, destroy: 0, events: [] as string[] };
	let running = false;
	const container = {
		get running() {
			return running;
		},
		start() {
			calls.start++;
			calls.events.push("start");
			if (opts.startError) throw new Error(opts.startError);
		},
		async exec(argv: string[]) {
			calls.exec.push({ at: Date.now(), argv });
			calls.events.push("exec");
			if (opts.execError) throw new Error(opts.execError);
			if (calls.exec.length <= (opts.notRunningFor ?? 0)) throw new Error("Error: the container is not running, consider calling start()");
			if (opts.execDelayMs) await new Promise((resolve) => setTimeout(resolve, opts.execDelayMs));
			running = true;
			const result = opts.result ?? { exitCode: 0, stdout: PROMOTED_STDOUT };
			return {
				output: () =>
					result === "hang"
						? new Promise<never>(() => {})
						: Promise.resolve({ exitCode: result.exitCode, stdout: enc(result.stdout), stderr: enc(result.stderr ?? "") }),
				kill: () => {
					calls.kill++;
					calls.events.push("kill");
				},
			};
		},
		async destroy() {
			calls.destroy++;
			calls.events.push("destroy");
			running = false;
		},
	};
	return { container, calls };
}

const remote = (name: string) => `https://${name}.artifacts.cloudflare.net/git/${name}.git`;

const REQUESTS = {
	promote: {
		permit_id: HEX64("1"),
		source_remote: remote("fork"),
		source_token: "t-source",
		candidate_sha: HEX40("c"),
		destination_remote: remote("canonical"),
		destination_token: "t-destination",
		expected_destination_head: HEX40("b"),
		winning_tree_sha256: HEX64("d"),
		issued_at: "2026-10-03T00:00:00Z",
	},
	copy_baseline: {
		action: "copy_baseline",
		op_id: "2".repeat(32),
		source_remote: remote("baseline"),
		source_token: "t-source",
		source_commit: HEX40("b"),
		destination_remote: remote("fork"),
		destination_token: "t-destination",
	},
	rebase: {
		action: "rebase",
		op_id: "3".repeat(32),
		fork_remote: remote("fork"),
		fork_token: "t-fork",
		candidate_sha: HEX40("c"),
		destination_remote: remote("canonical"),
		destination_token: "t-destination",
		onto: HEX40("e"),
	},
} as const;

/** Drive the Durable Object's fetch on the mocked clock, 50 ms at a time. */
async function drive(t: TestContext, object: PromotionContainer, body: unknown, maxMs = 70_000) {
	let settled = false;
	const pending = object
		.fetch(new Request("https://promotion/run", { method: "POST", body: JSON.stringify(body) }))
		.finally(() => (settled = true));
	const flush = () => new Promise((resolve) => setImmediate(resolve));
	for (let elapsed = 0; elapsed < maxMs && !settled; elapsed += 50) {
		await flush();
		t.mock.timers.tick(50);
	}
	await flush();
	assert.ok(settled, `no answer within ${maxMs} ms of (mocked) time`);
	const res = await pending;
	return { res, status: res.status, contentType: res.headers.get("content-type"), body: (await res.json()) as any, at: Date.now() };
}

function newObject(container: unknown) {
	return new PromotionContainer({ container } as never, {} as never);
}

const deltas = (times: number[]) => times.slice(1).map((t, i) => t - times[i]);

describe("PromotionContainer: start-up retries", () => {
	it("after start(), exec is retried after 100, 200 and 400 ms while the container is not running, then the script runs", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
		const { container, calls } = fakeContainer({ notRunningFor: 3 });
		const r = await drive(t, newObject(container), REQUESTS.promote);
		assert.equal(r.status, 200, JSON.stringify(r.body));
		assert.equal(r.body.outcome, "PROMOTED");
		assert.equal(calls.start, 1);
		assert.equal(calls.exec.length, 4);
		assert.deepEqual(deltas(calls.exec.map((c) => c.at)), [100, 200, 400]);
	});

	it("still not running after six retries (100 ms … 3.2 s): a retryable JSON 503", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
		const { container, calls } = fakeContainer({ notRunningFor: Infinity });
		const r = await drive(t, newObject(container), REQUESTS.promote);
		assert.equal(r.status, 503);
		assert.match(r.contentType ?? "", /^application\/json/);
		assert.deepEqual(r.body, { error: "container_not_running", retryable: true, attempts: 7 });
		assert.deepEqual(deltas(calls.exec.map((c) => c.at)), [100, 200, 400, 800, 1600, 3200]);
		assert.equal(calls.destroy, 1, "the container is destroyed even when it never ran the script");
	});

	it("a start() that throws is a retryable JSON 500, and the container is still destroyed", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
		const { container, calls } = fakeContainer({ startError: "start: no capacity" });
		const r = await drive(t, newObject(container), REQUESTS.promote);
		assert.equal(r.status, 500);
		assert.match(r.contentType ?? "", /^application\/json/);
		assert.deepEqual(r.body, { error: "promotion_container_internal_error", retryable: true, detail: "start: no capacity" });
		assert.deepEqual(calls.events, ["start", "destroy"]);
	});

	it("any other exec failure is not retried: a retryable JSON 502", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
		const { container, calls } = fakeContainer({ execError: "exec: permission denied" });
		const r = await drive(t, newObject(container), REQUESTS.promote);
		assert.equal(r.status, 502);
		assert.match(r.contentType ?? "", /^application\/json/);
		assert.equal(r.body.error, "container_exec_failed");
		assert.equal(r.body.retryable, true);
		assert.equal(calls.exec.length, 1);
		assert.equal(calls.destroy, 1);
	});
});

describe("PromotionContainer: the 60 s deadline", () => {
	it("a script still running at 60 s is killed; the answer is a retryable JSON 503", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
		const { container, calls } = fakeContainer({ result: "hang" });
		const r = await drive(t, newObject(container), REQUESTS.promote, 120_000);
		assert.equal(r.status, 503);
		assert.match(r.contentType ?? "", /^application\/json/);
		assert.deepEqual(r.body, { error: "container_exec_timeout", retryable: true, deadline_ms: 60_000 });
		assert.ok(r.at >= 60_000 && r.at <= 60_100, `answered at ${r.at} ms`);
		assert.equal(calls.kill, 1);
		assert.deepEqual(calls.events.slice(-2), ["kill", "destroy"], "killed, then the container destroyed");
	});

	it("an exec that only returns after 60 s: answered at 60 s, and the process it returns late is killed", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
		const { container, calls } = fakeContainer({ execDelayMs: 61_000, result: "hang" });
		const r = await drive(t, newObject(container), REQUESTS.promote, 120_000);
		assert.equal(r.status, 503);
		assert.deepEqual(r.body, { error: "container_exec_timeout", retryable: true, deadline_ms: 60_000 });
		assert.ok(r.at >= 60_000 && r.at <= 60_100, `answered at ${r.at} ms`);
		assert.equal(calls.kill, 0, "no process to kill yet");
		for (let elapsed = 0; elapsed < 2_000; elapsed += 50) {
			await new Promise((resolve) => setImmediate(resolve));
			t.mock.timers.tick(50);
		}
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(calls.kill, 1, "the late process is killed when exec returns it");
		assert.deepEqual(calls.events, ["start", "exec", "destroy", "kill"]);
	});
});

describe("PromotionContainer: one container per operation", () => {
	for (const [action, stdout] of [
		["promote", PROMOTED_STDOUT],
		["copy_baseline", `OUTCOME=IMPORTED\nHEAD=${HEX40("b")}\n`],
		["rebase", `OUTCOME=REBASED\nREBASED_SHA=${HEX40("f")}\nONTO=${HEX40("e")}\n`],
	] as const) {
		it(`${action}: the container is destroyed after a success and after a refusal`, async (t) => {
			t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
			const ok = fakeContainer({ result: { exitCode: 0, stdout } });
			const success = await drive(t, newObject(ok.container), REQUESTS[action]);
			assert.equal(success.status, 200, JSON.stringify(success.body));
			assert.deepEqual(ok.calls.events, ["start", "exec", "destroy"]);

			const refused = fakeContainer({ result: { exitCode: 42, stdout: "OUTCOME=EXPIRED_HEAD_MOVED\n" } });
			const failure = await drive(t, newObject(refused.container), REQUESTS[action]);
			assert.equal(failure.status, 409, JSON.stringify(failure.body));
			assert.match(failure.contentType ?? "", /^application\/json/);
			assert.equal(refused.calls.destroy, 1);
		});
	}
});
