/**
 * Frozen intent witnesses (specs/amendments/governed-resolution-v1.md §3).
 *
 * A witness is a small script that checks one agent's stated intent against a
 * tree: exit 0 means the behavior is there. The crew config declares them per
 * sub-agent (`witnesses: [{ id, script }]`) and crew-wide
 * (`regressions: [{ id, script }]`), with script paths relative to the config.
 *
 * Witnesses are frozen when the crew is loaded, before any agent commits and
 * before any resolver runs: their bytes are read once, hashed into a manifest,
 * and from then on executed from copies outside every candidate tree. A
 * resolver, or an agent, that edits test files in its tree cannot weaken them.
 *
 * A witness counts for side i only if it DISCRIMINATES that side: it fails on
 * the baseline and passes on side i's own commit. The gate on a candidate R:
 *
 *   REFUSE  some discriminating witness fails on R, or a check that passed on
 *           the baseline fails on R;
 *   REVIEW  otherwise, some required side has no discriminating witness —
 *           absence of a witness is not evidence that intent survived;
 *   ADMIT   otherwise.
 *
 * Node scripts (.mjs) run with `node`, shell scripts (.sh) with `bash`. The
 * working directory is a checkout of the tree under test; scripts reach its
 * files through process.cwd(), since the script itself lives elsewhere.
 * Children get the minimal environment only.
 */

import { runContained } from "./sandbox.mjs";

/** @param {string} s */
const shellQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { canonicalJson } from "../../src/lib/canonical.ts";
import { minimalEnv } from "./child-env.mjs";
import { safeGit } from "./safe-git.mjs";

export const WITNESS_MANIFEST_VERSION = "madgrix-witness-manifest/v1";
export const WITNESS_REPORT_VERSION = "madgrix-witness-report/v1";
const WITNESS_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DEFAULT_TIMEOUT_MS = 30_000;

/** @param {string | Buffer} input */
function sha256(input) {
	return createHash("sha256").update(input).digest("hex");
}

/**
 * @typedef {{ key: string, owner: string | null, id: string, kind: "node" | "bash", text: string, sha256: string }} WitnessScript
 * @typedef {{ format: string, sides: Array<{ agent_id: string, witnesses: Array<{ id: string, kind: string, sha256: string }> }>, regressions: Array<{ id: string, kind: string, sha256: string }> }} WitnessManifest
 * @typedef {{ manifest: WitnessManifest, sha256: string, scripts: WitnessScript[] }} LoadedWitnesses
 */

/**
 * @param {unknown} value
 * @param {string} label
 * @param {string} baseDir
 * @param {string | null} owner
 * @returns {WitnessScript[]}
 */
function readEntries(value, label, baseDir, owner) {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error(`${label} must be a list`);
	const seen = new Set();
	return value.map((entry, i) => {
		const row = /** @type {{ id?: unknown, script?: unknown }} */ (entry ?? {});
		if (typeof row.id !== "string" || !WITNESS_ID.test(row.id)) throw new Error(`${label}[${i}] needs an id`);
		if (seen.has(row.id)) throw new Error(`${label} repeats witness id ${row.id}`);
		seen.add(row.id);
		if (typeof row.script !== "string" || row.script.length === 0) throw new Error(`${label}[${i}] needs a script`);
		const kind = row.script.endsWith(".mjs") ? "node" : row.script.endsWith(".sh") ? "bash" : null;
		if (kind === null) throw new Error(`${label}[${i}] script must be .mjs or .sh`);
		const file = path.resolve(baseDir, row.script);
		if (!existsSync(file)) throw new Error(`${label}[${i}] script ${row.script} does not exist`);
		const text = readFileSync(file, "utf8");
		return { key: `${owner ?? "regression"}/${row.id}`, owner, id: row.id, kind, text, sha256: sha256(text) };
	});
}

/**
 * Read and freeze the witnesses a crew config declares. Returns null when the
 * config declares none. Agent ids must belong to the crew's sub-agents.
 *
 * @param {string} configPath
 * @param {{ subs: Array<{ id: string }> }} crew
 * @returns {LoadedWitnesses | null}
 */
export function loadWitnesses(configPath, crew) {
	const raw = JSON.parse(readFileSync(configPath, "utf8"));
	const baseDir = path.dirname(path.resolve(configPath));
	const subIds = new Set(crew.subs.map((sub) => sub.id));
	/** @type {WitnessScript[]} */
	const scripts = [];
	for (const [i, sub] of (raw.subs ?? []).entries()) {
		if (sub?.witnesses === undefined) continue;
		if (!subIds.has(sub.id)) throw new Error(`witnesses for unknown sub-agent ${sub?.id}`);
		scripts.push(...readEntries(sub.witnesses, `subs[${i}].witnesses`, baseDir, sub.id));
	}
	scripts.push(...readEntries(raw.regressions, "regressions", baseDir, null));
	if (scripts.length === 0) return null;
	/** @type {WitnessManifest} */
	const manifest = {
		format: WITNESS_MANIFEST_VERSION,
		sides: [...subIds]
			.sort()
			.map((agent_id) => ({
				agent_id,
				witnesses: scripts
					.filter((s) => s.owner === agent_id)
					.map((s) => ({ id: s.id, kind: s.kind, sha256: s.sha256 }))
					.sort((a, b) => a.id.localeCompare(b.id)),
			}))
			.filter((side) => side.witnesses.length > 0),
		regressions: scripts
			.filter((s) => s.owner === null)
			.map((s) => ({ id: s.id, kind: s.kind, sha256: s.sha256 }))
			.sort((a, b) => a.id.localeCompare(b.id)),
	};
	return { manifest, sha256: sha256(canonicalJson(manifest)), scripts };
}

/**
 * Checkouts of commits, made on demand and removed by dispose().
 * @param {string} repo
 */
function checkouts(repo) {
	const root = mkdtempSync(path.join(os.tmpdir(), "madgrix-witness-trees-"));
	chmodSync(root, 0o700);
	const scriptsDir = mkdtempSync(path.join(os.tmpdir(), "madgrix-witness-scripts-"));
	/** @type {Map<string, string>} */
	const trees = new Map();
	return {
		/** @param {string} sha */
		tree(sha) {
			const known = trees.get(sha);
			if (known) return known;
			const dir = path.join(root, `t${trees.size}`);
			// No `git worktree add` / `checkout`: those run hooks a resolver or a
			// sub-agent could have planted. A private index plus checkout-index
			// writes the tree (modes included) and runs nothing. The tree is not
			// a git repository.
			mkdirSync(dir, { recursive: true });
			const index = path.join(root, `index-${trees.size}`);
			try {
				safeGit(repo, ["read-tree", sha], { env: { GIT_INDEX_FILE: index } });
				safeGit(repo, ["checkout-index", "-a", "-f", `--prefix=${dir}${path.sep}`], { env: { GIT_INDEX_FILE: index } });
			} catch (error) {
				throw new Error(`witness checkout of ${sha} failed: ${/** @type {Error} */ (error).message}`);
			} finally {
				rmSync(index, { force: true });
			}
			trees.set(sha, dir);
			return dir;
		},
		/** @param {WitnessScript} script */
		scriptFile(script) {
			const file = path.join(scriptsDir, `${script.key.replace(/[^A-Za-z0-9._-]/g, "_")}.${script.kind === "node" ? "mjs" : "sh"}`);
			if (!existsSync(file)) {
				mkdirSync(path.dirname(file), { recursive: true });
				writeFileSync(file, script.text);
			}
			return file;
		},
		dispose() {
			rmSync(root, { recursive: true, force: true });
			rmSync(scriptsDir, { recursive: true, force: true });
		},
	};
}

/**
 * @param {ReturnType<typeof checkouts>} trees
 * @param {WitnessScript} script
 * @param {string} sha
 * @param {number} timeoutMs
 * @returns {"pass" | "fail"}
 */
function run(trees, script, sha, timeoutMs) {
	const cwd = trees.tree(sha);
	const file = trees.scriptFile(script);
	// The replay runs candidate code: contained like a resolver (bubblewrap,
	// fail closed; sandbox.mjs). Only its own checkout is writable.
	const interpreter = script.kind === "node" ? process.execPath : "bash";
	const r = runContained({
		command: `exec ${shellQuote(interpreter)} ${shellQuote(file)}`,
		cwd,
		writable: [cwd],
		env: minimalEnv({ MADGRIX_WITNESS_ID: script.id }),
		timeoutMs,
		purpose: "witness",
	});
	return r.status === 0 && !r.timedOut && !r.error ? "pass" : "fail";
}

/**
 * Outcomes of every frozen witness on the baseline and on its own side's
 * commit. Run once, before any resolver sees the conflict.
 *
 * @param {string} repo
 * @param {string} baseline
 * @param {Array<{ id: string, sha: string }>} commits
 * @param {LoadedWitnesses} loaded
 * @param {{ timeoutMs?: number }} [opts]
 */
export function freezeWitnesses(repo, baseline, commits, loaded, opts = {}) {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const shaOf = new Map(commits.map((c) => [c.id, c.sha]));
	const trees = checkouts(repo);
	try {
		/** @type {Record<string, { baseline: "pass" | "fail", own: "pass" | "fail" | null }>} */
		const outcomes = {};
		for (const script of loaded.scripts) {
			const base = run(trees, script, baseline, timeoutMs);
			const ownSha = script.owner === null ? null : shaOf.get(script.owner) ?? null;
			const own = ownSha === null ? null : run(trees, script, ownSha, timeoutMs);
			outcomes[script.key] = { baseline: base, own };
		}
		return { witness_manifest_sha256: loaded.sha256, baseline, outcomes };
	} finally {
		trees.dispose();
	}
}

/**
 * The witness gate on one candidate commit.
 *
 * @param {string} repo
 * @param {string} candidateSha
 * @param {LoadedWitnesses} loaded
 * @param {ReturnType<typeof freezeWitnesses>} frozen
 * @param {{ requiredSides: string[], capsuleId?: string | null, timeoutMs?: number }} opts
 */
export function witnessReport(repo, candidateSha, loaded, frozen, opts) {
	if (frozen.witness_manifest_sha256 !== loaded.sha256) {
		throw new Error("witness outcomes were frozen for another manifest");
	}
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const required = new Set(opts.requiredSides);
	const trees = checkouts(repo);
	/** @type {string[]} */
	const reasons = [];
	try {
		/** @type {Map<string, "pass" | "fail">} */
		const candidate = new Map();
		for (const script of loaded.scripts) candidate.set(script.key, run(trees, script, candidateSha, timeoutMs));

		const owners = [...new Set([...required, ...loaded.scripts.flatMap((s) => (s.owner ? [s.owner] : []))])].sort();
		const sides = owners.map((agent_id) => {
			const witnesses = loaded.scripts
				.filter((s) => s.owner === agent_id)
				.map((s) => {
					const before = frozen.outcomes[s.key];
					const discriminating = before.baseline === "fail" && before.own === "pass";
					return {
						id: s.id,
						baseline: before.baseline,
						own: before.own,
						candidate: candidate.get(s.key) ?? "fail",
						discriminating,
					};
				})
				.sort((a, b) => a.id.localeCompare(b.id));
			const counted = witnesses.filter((w) => w.discriminating);
			/** @type {"PRESERVED" | "LOST" | "UNWITNESSED"} */
			let status = "PRESERVED";
			if (counted.length === 0) status = "UNWITNESSED";
			else if (counted.some((w) => w.candidate !== "pass")) status = "LOST";
			for (const w of counted) {
				if (w.candidate !== "pass") reasons.push(`${agent_id}: witness ${w.id} fails on the candidate`);
			}
			for (const w of witnesses) {
				// A witness that already passed on the baseline does not show this
				// side's intent, but it still must not regress.
				if (!w.discriminating && w.baseline === "pass" && w.candidate !== "pass") {
					reasons.push(`${agent_id}: witness ${w.id} passed on the baseline and fails on the candidate`);
				}
			}
			if (status === "UNWITNESSED" && required.has(agent_id)) {
				reasons.push(`${agent_id}: no witness tells its work apart from the baseline`);
			}
			return { agent_id, required: required.has(agent_id), status, witnesses };
		});
		const regressions = loaded.scripts
			.filter((s) => s.owner === null)
			.map((s) => {
				const base = frozen.outcomes[s.key].baseline;
				const now = candidate.get(s.key) ?? "fail";
				if (base === "pass" && now !== "pass") reasons.push(`regression ${s.id} passed on the baseline and fails on the candidate`);
				return { id: s.id, baseline: base, candidate: now, enforced: base === "pass" };
			})
			.sort((a, b) => a.id.localeCompare(b.id));

		const regressed =
			regressions.some((r) => r.enforced && r.candidate !== "pass") ||
			sides.some((side) => side.witnesses.some((w) => !w.discriminating && w.baseline === "pass" && w.candidate !== "pass"));
		/** @type {"ADMIT" | "REFUSE" | "REVIEW"} */
		let verdict = "ADMIT";
		if (sides.some((side) => side.status === "LOST") || regressed) verdict = "REFUSE";
		else if (sides.some((side) => side.required && side.status === "UNWITNESSED")) verdict = "REVIEW";

		const report = {
			format: WITNESS_REPORT_VERSION,
			candidate_sha: candidateSha,
			capsule_id: opts.capsuleId ?? null,
			witness_manifest_sha256: loaded.sha256,
			sides,
			regressions,
			verdict,
			reasons,
		};
		return { report, sha256: sha256(canonicalJson(report)), verdict };
	} finally {
		trees.dispose();
	}
}

/**
 * A report that the gate could not run at all: no witnesses declared. Every
 * required side is UNWITNESSED, so the verdict is REVIEW (or ADMIT when no side
 * is required).
 *
 * @param {string} candidateSha
 * @param {string[]} requiredSides
 * @param {string | null} [capsuleId]
 */
export function emptyWitnessReport(candidateSha, requiredSides, capsuleId = null) {
	const sides = [...requiredSides].sort().map((agent_id) => ({ agent_id, required: true, status: "UNWITNESSED", witnesses: [] }));
	const report = {
		format: WITNESS_REPORT_VERSION,
		candidate_sha: candidateSha,
		capsule_id: capsuleId,
		witness_manifest_sha256: null,
		sides,
		regressions: [],
		verdict: sides.length > 0 ? "REVIEW" : "ADMIT",
		reasons: sides.map((side) => `${side.agent_id}: no witnesses declared`),
	};
	return { report, sha256: sha256(canonicalJson(report)), verdict: /** @type {"ADMIT" | "REVIEW"} */ (report.verdict) };
}
