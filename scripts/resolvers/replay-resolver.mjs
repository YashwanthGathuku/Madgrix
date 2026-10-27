#!/usr/bin/env node
/**
 * Rung 2 of the resolution ladder: intent replay in one order
 * (specs/amendments/governed-resolution-v1.md §4).
 *
 * Instead of asking a model to "merge the markers", the replayer is asked to
 * re-apply one side's intent onto the other side's version of each hunk.
 * MADGRIX_REPLAY_ORDER=AB keeps A's version and replays B's intent onto it;
 * BA does the reverse. A and B are the two sides sorted by agent id, so the
 * orders are fixed whatever the crew's file order. The ladder runs both orders
 * as separate leased resolutions and compares them.
 *
 * MADGRIX_REPLAYER is the replayer command. It is run once per hunk with a
 * JSON request on stdin and must print the replacement text for that hunk.
 * Only two-sided conflicts are supported; three or more sides exit 3.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const forbidden = Object.keys(process.env).filter((name) =>
	/CONTROL_SERVICE_TOKEN|EVALUATION_SERVICE_TOKEN|AGENT_SERVICE_TOKEN|AUTHORITY_SIGNING_KEY/.test(name),
);
if (forbidden.length > 0) {
	console.error("resolver refuses to run with a service credential in its environment");
	process.exit(2);
}
const conflictPath = process.env.MADGRIX_CONFLICT_PATH;
const order = process.env.MADGRIX_REPLAY_ORDER;
const replayer = process.env.MADGRIX_REPLAYER;
if (!conflictPath || (order !== "AB" && order !== "BA") || !replayer) {
	console.error("replay resolver requires MADGRIX_CONFLICT_PATH, MADGRIX_REPLAY_ORDER=AB|BA and MADGRIX_REPLAYER");
	process.exit(2);
}
const conflict = JSON.parse(readFileSync(conflictPath, "utf8"));
const replayCommand = replayer;
const CONTEXT_LINES = 20;

/** @param {string} text @param {"head" | "tail"} end */
function clip(text, end) {
	const lines = text.split("\n");
	return end === "head" ? lines.slice(0, CONTEXT_LINES).join("\n") : lines.slice(-CONTEXT_LINES).join("\n");
}

/**
 * @param {Record<string, unknown>} request
 * @returns {string}
 */
function replay(request) {
	const result = spawnSync("bash", ["-c", replayCommand], {
		input: JSON.stringify(request),
		encoding: "utf8",
		timeout: 180_000,
		env: process.env,
	});
	if (result.error || result.status !== 0) {
		const detail = (result.stderr ?? "").trim().split("\n").slice(-1)[0];
		throw new Error(`replayer failed on ${request.path}#${request.hunk_index ?? "file"}${detail ? `: ${detail}` : ""}`);
	}
	return result.stdout ?? "";
}

/** @type {Array<{ path: string, text: string }>} */
const writes = [];
try {
	for (const file of conflict.files ?? []) {
		const sides = [...(file.sides ?? [])].sort((a, b) => String(a.agent_id).localeCompare(String(b.agent_id)));
		if (sides.length !== 2) {
			console.error(`${file.path}: replay supports exactly two sides`);
			process.exit(3);
		}
		const [a, b] = sides;
		const [target, source] = order === "AB" ? [a, b] : [b, a];
		if (Array.isArray(file.hunks) && Array.isArray(file.segments)) {
			const fills = file.hunks.map((/** @type {{ index: number, base: string, sides: Array<{ agent_id: string, text: string }> }} */ hunk) => {
				const textOf = (/** @type {string} */ id) => hunk.sides.find((s) => s.agent_id === id)?.text ?? "";
				return replay({
					format: "madgrix-replay-request/v1",
					path: file.path,
					hunk_index: hunk.index,
					order,
					base: hunk.base,
					target: { agent_id: target.agent_id, intent: target.intent, text: textOf(target.agent_id) },
					source: { agent_id: source.agent_id, intent: source.intent, text: textOf(source.agent_id) },
					context: { before: clip(file.segments[hunk.index], "tail"), after: clip(file.segments[hunk.index + 1], "head") },
				});
			});
			writes.push({
				path: file.path,
				text: file.segments.reduce(
					(/** @type {string} */ text, /** @type {string} */ seg, /** @type {number} */ i) => text + seg + (i < fills.length ? fills[i] : ""),
					"",
				),
			});
		} else {
			writes.push({
				path: file.path,
				text: replay({
					format: "madgrix-replay-request/v1",
					path: file.path,
					hunk_index: null,
					order,
					base: file.base ?? "",
					target: { agent_id: target.agent_id, intent: target.intent, text: target.text },
					source: { agent_id: source.agent_id, intent: source.intent, text: source.text },
					context: { before: "", after: "" },
				}),
			});
		}
	}
} catch (error) {
	console.error(/** @type {Error} */ (error).message);
	process.exit(1);
}
for (const { path: file, text } of writes) {
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, text);
}
