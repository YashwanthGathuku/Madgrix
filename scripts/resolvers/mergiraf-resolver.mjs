#!/usr/bin/env node
/**
 * Rung 1 of the resolution ladder: Mergiraf's syntax-aware three-way merge
 * (https://mergiraf.org, GPL-3.0; run as an external binary, never vendored).
 *
 * Runs under the resolution lease (specs/amendments/resolution-lease-v1.md):
 * it reads the conflict from MADGRIX_CONFLICT_PATH and writes only the leased
 * files. For each conflicted file it merges the baseline text with every
 * side, folding sides in order. If Mergiraf leaves any conflict in any file,
 * this resolver writes nothing and exits 1, so the ladder moves on.
 *
 * MERGIRAF_BIN names the binary (default: `mergiraf` on PATH).
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const forbidden = Object.keys(process.env).filter((name) =>
	/CONTROL_SERVICE_TOKEN|EVALUATION_SERVICE_TOKEN|AGENT_SERVICE_TOKEN|AUTHORITY_SIGNING_KEY/.test(name),
);
if (forbidden.length > 0) {
	console.error("resolver refuses to run with a service credential in its environment");
	process.exit(2);
}
const conflictPath = process.env.MADGRIX_CONFLICT_PATH;
if (!conflictPath) {
	console.error("resolver requires MADGRIX_CONFLICT_PATH");
	process.exit(2);
}
const bin = process.env.MERGIRAF_BIN || "mergiraf";
const conflict = JSON.parse(readFileSync(conflictPath, "utf8"));
const work = mkdtempSync(path.join(os.tmpdir(), "madgrix-mergiraf-"));

/**
 * @param {string} file repo-relative path, used for language detection
 * @param {string} base
 * @param {string} left
 * @param {string} right
 * @returns {string | null}
 */
function merge(file, base, left, right) {
	const ext = path.extname(file) || ".txt";
	const b = path.join(work, `base${ext}`);
	const l = path.join(work, `left${ext}`);
	const r = path.join(work, `right${ext}`);
	const o = path.join(work, `out${ext}`);
	writeFileSync(b, base);
	writeFileSync(l, left);
	writeFileSync(r, right);
	rmSync(o, { force: true });
	const result = spawnSync(bin, ["merge", b, l, r, "-o", o, "-p", file], { encoding: "utf8", timeout: 60_000 });
	if (result.error || result.status !== 0) return null;
	const out = readFileSync(o, "utf8");
	return /^(<{7}|>{7})/m.test(out) ? null : out;
}

/** @type {Array<{ path: string, text: string }>} */
const writes = [];
try {
	for (const file of conflict.files ?? []) {
		const sides = file.sides ?? [];
		if (sides.length < 2) throw new Error(`${file.path}: fewer than two sides`);
		let merged = sides[0].text;
		for (let i = 1; i < sides.length; i++) {
			const next = merge(file.path, file.base ?? "", merged, sides[i].text);
			if (next === null) {
				console.error(`mergiraf left a conflict in ${file.path}`);
				process.exit(1);
			}
			merged = next;
		}
		writes.push({ path: file.path, text: merged });
	}
} finally {
	rmSync(work, { recursive: true, force: true });
}
for (const { path: file, text } of writes) {
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, text);
}
