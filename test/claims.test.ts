/**
 * Tests for the WorkClaim conflict graph (spec 2).
 * node --test test/claims.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	classifyPair,
	globsOverlap,
	reconcileClaims,
	validateClaim,
} from "../src/lib/claims.ts";
import type { WorkClaim } from "../src/lib/types.ts";

function makeClaim(overrides: Partial<WorkClaim> & { work_id: string }): WorkClaim {
	return {
		agent: "contender-x",
		task: "taskhash-abc",
		baseline: "base123",
		intent: { behavior: [] },
		scope: { paths: ["src/x/**"], symbols: [] },
		contracts: { reads: [], modifies: [] },
		interfaces: [],
		schema_changes: [],
		expected_tests: [],
		lease: { claimed_at: "2026-10-01T18:00:00Z", expires_at: "2026-10-01T20:00:00Z" },
		status: "claimed",
		version: 1,
		...overrides,
	};
}

describe("validateClaim", () => {
	it("rejects empty scope.paths — unbounded claims are inadmissible (spec 2 §2)", () => {
		const c = makeClaim({ work_id: "W-1", scope: { paths: [], symbols: [] } });
		const { work_id: _w, status: _s, version: _v, ...input } = c;
		const r = validateClaim(input);
		assert.equal(r.ok, false);
		assert.match((r as { ok: false; error: string }).error, /unbounded/i);
	});

	it("accepts a well-formed claim", () => {
		const c = makeClaim({ work_id: "W-1" });
		const { work_id: _w, status: _s, version: _v, ...input } = c;
		assert.deepEqual(validateClaim(input), { ok: true });
	});
});

describe("globsOverlap", () => {
	it("matches ** suffix overlap and exact match", () => {
		assert.equal(globsOverlap("src/auth/**", "src/auth/login.ts"), true);
		assert.equal(globsOverlap("src/auth/login.ts", "src/auth/login.ts"), true);
		assert.equal(globsOverlap("src/auth/**", "src/billing/**"), false);
		assert.equal(globsOverlap("**", "anything/at/all.ts"), true);
	});
});

describe("classifyPair", () => {
	it("the spec's JWTClaims worked example → RED contract conflict", () => {
		const a = makeClaim({
			work_id: "W-A",
			agent: "contender-a",
			scope: { paths: ["src/auth/**"], symbols: ["verifyToken"] },
			contracts: { reads: ["JWTClaims"], modifies: ["TokenValidationResult"] },
		});
		const b = makeClaim({
			work_id: "W-B",
			agent: "contender-b",
			scope: { paths: ["src/login/**"], symbols: ["LoginController"] },
			contracts: { reads: [], modifies: ["JWTClaims"] },
		});
		// Git would say NO CONFLICT (disjoint files). The graph must not.
		const r = classifyPair(a, b, { depMap: {} });
		assert.equal(r.risk, "RED");
		assert.deepEqual(r.layers.contract, ["JWTClaims"]);
		assert.equal(r.layers.text.length, 0); // disjoint paths — caught below the text layer
		assert.match(r.explanation, /RED/);
	});

	it("contract conflict is symmetric (A reads, B writes AND A writes, B reads)", () => {
		const a = makeClaim({
			work_id: "W-A",
			scope: { paths: ["src/a/**"], symbols: [] },
			contracts: { reads: ["S"], modifies: [] },
		});
		const b = makeClaim({
			work_id: "W-B",
			scope: { paths: ["src/b/**"], symbols: [] },
			contracts: { reads: [], modifies: ["S"] },
		});
		assert.equal(classifyPair(a, b, { depMap: {} }).risk, "RED");
	});

	it("BLOCKED on schema_changes collision", () => {
		const a = makeClaim({ work_id: "W-A", schema_changes: ["migration 042"] });
		const b = makeClaim({ work_id: "W-B", schema_changes: ["migration 042"] });
		const r = classifyPair(a, b, { depMap: {} });
		assert.equal(r.risk, "BLOCKED");
		assert.deepEqual(r.layers.state, ["migration 042"]);
	});

	it("RED on symbol intersection across different files", () => {
		const a = makeClaim({
			work_id: "W-A",
			scope: { paths: ["src/a/**"], symbols: ["verifyToken"] },
		});
		const b = makeClaim({
			work_id: "W-B",
			scope: { paths: ["src/b/**"], symbols: ["verifyToken"] },
		});
		const r = classifyPair(a, b, { depMap: {} });
		assert.equal(r.risk, "RED");
		assert.deepEqual(r.layers.symbol, ["verifyToken"]);
	});

	it("AMBER on shared dependency neighborhood (L2 impact)", () => {
		const a = makeClaim({
			work_id: "W-A",
			scope: { paths: ["src/a/**"], symbols: ["fa"] },
		});
		const b = makeClaim({
			work_id: "W-B",
			scope: { paths: ["src/b/**"], symbols: ["fb"] },
		});
		const depMap = { fa: ["shared"], fb: ["shared"], shared: [] };
		const r = classifyPair(a, b, { depMap });
		assert.equal(r.risk, "AMBER");
		assert.deepEqual(r.layers.impact, ["shared"]);
	});

	it("L2 unavailable → AMBER, never silent GREEN", () => {
		const a = makeClaim({ work_id: "W-A", scope: { paths: ["src/a/**"], symbols: ["fa"] } });
		const b = makeClaim({ work_id: "W-B", scope: { paths: ["src/b/**"], symbols: ["fb"] } });
		const r = classifyPair(a, b); // no depMap
		assert.equal(r.risk, "AMBER");
		assert.match(r.explanation, /L2 dependency analysis unavailable/);
	});

	it("amended claim (version > 1) → AMBER", () => {
		const a = makeClaim({ work_id: "W-A", version: 2 });
		const b = makeClaim({ work_id: "W-B" });
		assert.equal(classifyPair(a, b, { depMap: {} }).risk, "AMBER");
	});

	it("GREEN when nothing collides and L2 analysis ran", () => {
		const a = makeClaim({
			work_id: "W-A",
			scope: { paths: ["src/a/**"], symbols: ["fa"] },
		});
		const b = makeClaim({
			work_id: "W-B",
			scope: { paths: ["src/b/**"], symbols: ["fb"] },
		});
		const r = classifyPair(a, b, { depMap: { fa: [], fb: [] } });
		assert.equal(r.risk, "GREEN");
		assert.match(r.explanation, /no conflicts detected/);
	});
});

describe("reconcileClaims", () => {
	it("classifies live pairs only (claimed|active), one report per pair", () => {
		const a = makeClaim({ work_id: "W-A", status: "claimed" });
		const b = makeClaim({ work_id: "W-B", status: "active" });
		const c = makeClaim({ work_id: "W-C", status: "released" }); // not live
		const reports = reconcileClaims([a, b, c], { depMap: {} });
		assert.equal(reports.length, 1);
		assert.equal(reports[0].claim_a, "W-A");
		assert.equal(reports[0].claim_b, "W-B");
	});
});
