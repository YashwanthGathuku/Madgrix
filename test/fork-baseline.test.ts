/** A fork whose main moved past the frozen baseline is refused before any agent runs. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { assertForkAtBaseline } from "../scripts/lib/fork-baseline.mjs";

const env = { PATH: process.env.PATH ?? "", HOME: os.tmpdir(), GIT_CONFIG_NOSYSTEM: "1" };
const git = (cwd: string, ...a: string[]) =>
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false", ...a], { cwd, env, encoding: "utf8" }).trim();

describe("assertForkAtBaseline", () => {
	it("accepts a fork at the baseline and refuses one whose main moved", () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "fork-base-"));
		try {
			git(dir, "init", "-q");
			writeFileSync(path.join(dir, "a"), "1");
			git(dir, "add", "a");
			git(dir, "commit", "-qm", "baseline");
			const baseline = git(dir, "rev-parse", "HEAD");
			assert.equal(assertForkAtBaseline(dir, baseline, env), baseline);
			writeFileSync(path.join(dir, "a"), "2");
			git(dir, "commit", "-qam", "promoted by an earlier run");
			assert.throws(() => assertForkAtBaseline(dir, baseline, env), /baseline repository's main has moved/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
