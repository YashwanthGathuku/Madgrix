#!/usr/bin/env node
/**
 * One resolver behaviour for the governed-resolution benchmark
 * (scripts/bench-resolution.mjs). Usage, as a resolver command:
 *
 *   node scripts/bench/resolution-strategy.mjs <strategy> <scenario-dir>
 *
 * It runs under either resolve protocol:
 *   - the pre-lease protocol (commit ee421f0): inputs inside the repository,
 *     and the resolver must rebuild every clean file itself;
 *   - the lease (resolution-lease-v1 and later): MADGRIX_LEASED_PATHS is set,
 *     the authority has already written every clean file.
 *
 * Strategies, each a behaviour real resolvers show:
 *   ours        keep the first side's file (sides sorted by agent id)
 *   theirs      keep the second side's file
 *   union       git's union merge: both sides' lines, no markers
 *   markers     leave git's conflict markers in the file
 *   reference   the careful developer's resolution
 *   tamper      the reference, plus deleting another agent's clean file
 *   drop-clean  the reference, but (pre-lease) without rebuilding clean files
 *   mergiraf    Mergiraf's syntax-aware merge; exits 1 if it leaves a conflict
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const [strategy, scenarioDir] = process.argv.slice(2);
const conflict = JSON.parse(readFileSync(/** @type {string} */ (process.env.MADGRIX_CONFLICT_PATH), "utf8"));
const baseline = /** @type {string} */ (process.env.MADGRIX_BASELINE_SHA);
const leased = typeof process.env.MADGRIX_LEASED_PATHS === "string";
const conflictedPaths = new Set(conflict.files.map((/** @type {{ path: string }} */ f) => f.path));

/** @param {string[]} args */
function git(args) {
	return spawnSync("git", args, { encoding: "utf8" });
}

/** @param {string} file @param {string} text */
function write(file, text) {
	mkdirSync(path.dirname(file) || ".", { recursive: true });
	writeFileSync(file, text);
}

/**
 * Text of git merge-file over (ours, base, theirs), with or without --union.
 * @param {string} base @param {string} ours @param {string} theirs @param {boolean} union
 */
function mergeFile(base, ours, theirs, union) {
	const dir = mkdtempSync(path.join(os.tmpdir(), "bench-merge-"));
	try {
		writeFileSync(path.join(dir, "o"), ours);
		writeFileSync(path.join(dir, "b"), base);
		writeFileSync(path.join(dir, "t"), theirs);
		const r = spawnSync("git", ["merge-file", "-p", ...(union ? ["--union"] : []), "o", "b", "t"], { cwd: dir, encoding: "utf8" });
		return r.stdout ?? "";
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** @param {string} file @param {string} base @param {string} ours @param {string} theirs */
function mergiraf(file, base, ours, theirs) {
	const dir = mkdtempSync(path.join(os.tmpdir(), "bench-mergiraf-"));
	const ext = path.extname(file) || ".txt";
	try {
		for (const [name, text] of [["b", base], ["o", ours], ["t", theirs]]) writeFileSync(path.join(dir, name + ext), text);
		const out = path.join(dir, `out${ext}`);
		const r = spawnSync(process.env.MERGIRAF_BIN || "mergiraf", ["merge", path.join(dir, `b${ext}`), path.join(dir, `o${ext}`), path.join(dir, `t${ext}`), "-o", out, "-p", file], { encoding: "utf8" });
		if (r.status !== 0) return null;
		return readFileSync(out, "utf8");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// Pre-lease protocol: the resolver itself must rebuild every clean file.
if (!leased && strategy !== "drop-clean") {
	for (const agent of conflict.agents ?? []) {
		const names = (git(["diff", "--name-only", baseline, agent.commit]).stdout ?? "").split("\n").filter(Boolean);
		for (const name of names) {
			if (conflictedPaths.has(name) || name.startsWith(".madgrix/")) continue;
			mkdirSync(path.dirname(name) || ".", { recursive: true });
			git(["checkout", agent.commit, "--", name]);
		}
	}
}

for (const file of conflict.files) {
	const sides = [...file.sides].sort((a, b) => String(a.agent_id).localeCompare(String(b.agent_id)));
	const base = typeof file.base === "string" ? file.base : git(["show", `${baseline}:${file.path}`]).stdout ?? "";
	const [a, b] = sides;
	let text;
	switch (strategy) {
		case "ours":
			text = a.text;
			break;
		case "theirs":
			text = b.text;
			break;
		case "union":
			text = mergeFile(base, a.text, b.text, true);
			break;
		case "markers":
			text = mergeFile(base, a.text, b.text, false);
			break;
		case "reference":
		case "tamper":
		case "drop-clean":
			text = readFileSync(path.join(scenarioDir, "reference", file.path), "utf8");
			break;
		case "mergiraf": {
			const merged = mergiraf(file.path, base, a.text, b.text);
			if (merged === null) {
				console.error(`mergiraf left a conflict in ${file.path}`);
				process.exit(1);
			}
			text = merged;
			break;
		}
		default:
			console.error(`unknown strategy ${strategy}`);
			process.exit(2);
	}
	write(file.path, text);
}

if (strategy === "tamper") rmSync("CHANGELOG.md", { force: true });
