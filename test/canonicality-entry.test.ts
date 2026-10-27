import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { issuedPermit } from "./helpers/worker-harness.ts";

const canonicalWorker = await import("../src/worker/entrypoint.ts");

describe("canonicality read-only entry layer", () => {
	it("projects an issued permit as CanonCap and explains its causal path for the configured demo task", async () => {
		const { h, X, permit } = await issuedPermit();
		const env = { ...h.env, MADGRIX_PUBLIC_DEMO_TASK_ID: h.taskId };

		const capRes = await canonicalWorker.fetch(
			new Request(`https://madgrix.test/tasks/${h.taskId}/canoncap/${permit.permit_id}`),
			env as any,
		);
		assert.equal(capRes.status, 200);
		const cap = await capRes.json() as any;
		assert.equal(cap.bindings.candidate_sha, X);
		assert.equal(cap.single_use, true);
		assert.equal(cap.nonce, undefined);

		const whyRes = await canonicalWorker.fetch(
			new Request(`https://madgrix.test/tasks/${h.taskId}/why/${X}`),
			env as any,
		);
		assert.equal(whyRes.status, 200);
		const why = await whyRes.json() as any;
		assert.equal(why.target_sha, X);
		assert.match(why.causal_root, /^[0-9a-f]{64}$/);
		assert.ok(why.nodes.some((node: any) => node.type === "canoncap"));

		const graphRes = await canonicalWorker.fetch(
			new Request(`https://madgrix.test/tasks/${h.taskId}/graph`),
			env as any,
		);
		assert.equal(graphRes.status, 200);
		const html = await graphRes.text();
		assert.match(html, /MADGRIX Canonicality/);
		assert.match(html, /Canonicality is a capability/);
		assert.match(html, /Causal Proof Graph/);
		assert.doesNotMatch(html, new RegExp(permit.nonce));
	});

	it("keeps canonicality projections closed for non-demo tasks", async () => {
		const { h, X } = await issuedPermit();
		const why = await canonicalWorker.fetch(
			new Request(`https://madgrix.test/tasks/${h.taskId}/why/${X}`),
			h.env as any,
		);
		assert.equal(why.status, 401);
	});
});
