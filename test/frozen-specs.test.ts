/**
 * Frozen spec content hashes (specs/FROZEN.json).
 *
 * FROZEN.json: "To verify: `sha256sum <file>` must reproduce the hash above.
 * Any mismatch means the frozen contract was altered — treat as an
 * unrecorded amendment and halt." This test runs that check on every
 * recorded file, so an edit to a frozen spec fails `npm test` (and CI)
 * instead of waiting to be noticed by hand.
 *
 * node --test test/frozen-specs.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SPECS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "specs");

/** The `- \`<file>\`: \`sha256:<hex>\`` entries of FROZEN.json, in order. */
async function recordedHashes(): Promise<Array<[string, string]>> {
	const text = await readFile(path.join(SPECS, "FROZEN.json"), "utf8");
	return [...text.matchAll(/^- `([^`]+)`: `sha256:([0-9a-f]{64})`/gm)].map((m) => [m[1], m[2]]);
}

describe("specs/FROZEN.json", () => {
	it("records every spec file", async () => {
		assert.deepEqual(
			(await recordedHashes()).map(([file]) => file).sort(),
			[
				"ATTESTATION_PROTOCOL.md",
				"BENCHMARK_PROTOCOL.md",
				"CLOUDFLARE_RUNTIME_MODEL.md",
				"EVALUATION_THREAT_MODEL.md",
				"INTENT_AND_CONFLICT_GRAPH.md",
				"PROMOTION_PROTOCOL.md",
				"README.md",
			],
		);
	});

	it("every recorded hash reproduces from the file (sha256sum)", async () => {
		const mismatched: string[] = [];
		for (const [file, recorded] of await recordedHashes()) {
			const actual = createHash("sha256").update(await readFile(path.join(SPECS, file))).digest("hex");
			if (actual !== recorded) mismatched.push(`${file}: recorded ${recorded}, actual ${actual}`);
		}
		assert.deepEqual(mismatched, [], "a frozen spec changed without a recorded amendment");
	});
});
