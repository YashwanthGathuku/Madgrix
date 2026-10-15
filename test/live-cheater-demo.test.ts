import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-ignore -- plain ESM script
import { planFor, toolStatusLines, flipByte, matchQuarantinePayload, AGENTS } from "../scripts/live-cheater-demo.mjs";
import { canonicalJson, sha256Hex } from "../src/lib/canonical.ts";

test("roles: honest writes, cheater also tampers tests, false-done writes nothing", () => {
	assert.deepEqual(AGENTS, ["honest-ana", "cheater-cal", "false-done-fay"]);
	assert.equal(planFor("honest-ana").tamperTests, false);
	assert.equal(planFor("honest-ana").writeClaimed, true);
	assert.equal(planFor("cheater-cal").tamperTests, true);
	assert.equal(planFor("false-done-fay").writeClaimed, false);
});

test("tool-status log is v1: session record then gapless seq", () => {
	const lines = toolStatusLines(
		{ MADGRIX_TASK_ID: "t", MADGRIX_CONTENDER_ID: "c", MADGRIX_AGENT_ID: "a", MADGRIX_BASELINE_SHA: "b" },
		planFor("cheater-cal").actions,
	).map((l: string) => JSON.parse(l));
	assert.equal(lines[0].format, "madgrix-tool-status/v1");
	assert.deepEqual(lines.slice(1).map((l: { seq: number }) => l.seq), [1, 2, 3]);
});

test("flipByte changes exactly one byte", () => {
	const a = Buffer.from(JSON.stringify({ x: "ab".repeat(20), y: "deadbeefcafe0123" }));
	const b = flipByte(a);
	assert.equal([...a].filter((x, i) => x !== b[i]).length, 1);
	JSON.parse(b.toString());
});

test("quarantine trigger is recovered from a ledger payload hash", async () => {
	const ev = "e".repeat(64);
	const h = await sha256Hex(canonicalJson({ contender_id: "c1", trigger: "eval_file_modification", evidence_hash: ev }));
	assert.deepEqual(await matchQuarantinePayload(h, "c1", ["f".repeat(64), ev], sha256Hex, canonicalJson), {
		trigger: "eval_file_modification",
		evidence_hash: ev,
	});
	assert.equal(await matchQuarantinePayload(h, "c2", [ev], sha256Hex, canonicalJson), null);
});
