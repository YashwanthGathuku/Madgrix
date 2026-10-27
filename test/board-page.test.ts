/** GET /board: self-contained trust board built only from recorded data. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeHarness, worker } from "./helpers/worker-harness.ts";
import { BOARD_DATA } from "../src/worker/board-data.ts";

describe("GET /board", () => {
	it("serves a self-contained HTML page with a strict CSP", async () => {
		const h = await makeHarness();
		const res = await worker.fetch(new Request("https://madgrix.test/board"), h.env as any);
		assert.equal(res.status, 200);
		assert.match(res.headers.get("content-type") ?? "", /text\/html/);
		assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'none'/);
		const html = await res.text();
		assert.match(html, /trust board/);
		assert.match(html, /Approve &amp; promote/);
		assert.match(html, /Refused: mandatory gates cannot be waived/);
		assert.doesNotMatch(html, /<script[^>]+src=/);
		assert.doesNotMatch(html, /https?:\/\/[^"']*(cdn|unpkg|jsdelivr)/i);
		assert.doesNotMatch(html, /art_v2|Bearer /);
	});

	it("draws the mall: shops, checkout gates, quarantine room, parking, receipt", async () => {
		const h = await makeHarness();
		const html = await (await worker.fetch(new Request("https://madgrix.test/board"), h.env as any)).text();
		for (const s of ["the repo mall", "CHECKOUT", "Blind eval", "Hidden tests", "Provenance", "QUARANTINE ROOM", "PARKING", "LEDGER RECEIPT", "visualization"]) assert.ok(html.includes(s), s);
		assert.match(html, /scenario/);
		assert.match(html, /autoplay/);
		assert.match(html, /loop/);
		assert.match(html, /test\/base-url\.ts/);
		assert.match(html, /<svg/);
		assert.doesNotMatch(html, /<img[^>]+src=["']https?:/);
	});

	it("is linked from the landing page", async () => {
		const h = await makeHarness();
		const home = await (await worker.fetch(new Request("https://madgrix.test/"), h.env as any)).text();
		assert.match(home, /href="\/board"/);
	});

	it("carries the three recorded scenarios with their measured numbers", () => {
		const [crew, cheater, scale] = BOARD_DATA.scenarios as any;
		assert.equal(crew.task, "task_99f82dca34d72b85dc1ee92a");
		assert.equal(crew.agents.length, 13);
		assert.equal(crew.ustad, "FINAL VERIFIED");
		assert.equal(cheater.task, "task_6dce45beed286be0230b754e");
		assert.equal(cheater.quarantine.agent, "cheater-cal");
		assert.equal(cheater.quarantine.trigger, "eval_file_modification");
		assert.equal(scale.n, 3000);
		assert.equal(scale.overlaps_flagged, 149);
		assert.ok(BOARD_DATA.scenarios.every((s: any) => s.badge === "REAL" || s.badge === "SIMULATED"));
	});

	it("non-GET is not served as the board", async () => {
		const h = await makeHarness();
		const res = await worker.fetch(new Request("https://madgrix.test/board", { method: "POST" }), h.env as any);
		assert.notEqual(res.status, 200);
	});
});

describe("GET /tasks/:id/board-state", () => {
	it("404s for an unknown task and never leaks token fields", async () => {
		const h = await makeHarness();
		const res = await worker.fetch(new Request("https://madgrix.test/tasks/task_nope/board-state"), h.env as any);
		assert.notEqual(res.status, 200);
		const body = await res.text();
		assert.doesNotMatch(body, /token_id|art_v2|Bearer /);
	});
	it("board page allows same-origin polling for live mode", async () => {
		const h = await makeHarness();
		const res = await worker.fetch(new Request("https://madgrix.test/board?live=1"), h.env as any);
		assert.match(res.headers.get("content-security-policy") ?? "", /connect-src 'self'/);
		assert.match(await res.text(), /board-state/);
	});
});

describe("/board/new", () => {
	it("serves the import form", async () => {
		const h = await makeHarness();
		const res = await worker.fetch(new Request("https://madgrix.test/board/new"), h.env as any);
		assert.equal(res.status, 200);
		const html = await res.text();
		assert.match(html, /Demo access key/);
		assert.match(html, /do <b>not<\/b> start working/);
	});
	it("refuses without the demo key and never imports", async () => {
		const h = await makeHarness();
		const env = { ...(h.env as any), BOARD_DEMO_KEY: "right-key" };
		const body = new URLSearchParams({ repo: "https://github.com/a/b", instruction: "x", key: "wrong", agents: "1" });
		const res = await worker.fetch(new Request("https://madgrix.test/board/new", { method: "POST", body }), env);
		assert.equal(res.status, 400);
		assert.match(await res.text(), /Wrong demo access key/);
	});
	it("is disabled when no key is configured", async () => {
		const h = await makeHarness();
		const body = new URLSearchParams({ repo: "https://github.com/a/b", instruction: "x", key: "k" });
		const res = await worker.fetch(new Request("https://madgrix.test/board/new", { method: "POST", body }), { ...(h.env as any), BOARD_DEMO_KEY: undefined });
		assert.match(await res.text(), /disabled/);
	});
});
