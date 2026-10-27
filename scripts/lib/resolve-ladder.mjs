/**
 * The resolution ladder (specs/amendments/governed-resolution-v1.md §4).
 *
 *   rung 1  structured  Mergiraf, when installed
 *   rung 2  replay      an untrusted replayer (e.g. an LLM), run in BOTH orders
 *   rung 3  REVIEW      no candidate is admitted; a person decides
 *
 * The ladder is control-plane code. Every resolver it runs is untrusted and
 * runs under the resolution lease (resolveComposition); every candidate a rung
 * produces goes through the same witness gate (witness.mjs). A rung's
 * candidate is admitted only on an ADMIT verdict.
 *
 * Dual-order replay: the replay rung builds R_AB (keep A, replay B's intent)
 * and R_BA (keep B, replay A's intent). Both ADMIT → the conflict commutes
 * under the witnesses; R_AB is kept (A and B are sorted by agent id, so the
 * choice is deterministic), and the record says whether the two agreed
 * byte-for-byte ("identical") or only on every witness ("behavioral"). Only
 * one ADMIT → the outcome depends on order, which is treated as a genuine
 * semantic conflict and escalated rather than letting one order win.
 *
 * A REVIEW verdict (some required side has no discriminating witness) stops
 * the ladder: another resolver cannot add the missing evidence.
 */

import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { minimalEnv } from "./child-env.mjs";
import { safeGit } from "./safe-git.mjs";
import { publishMain, publishWithRebase, restoreCheckout } from "./main-ref.mjs";
import { resolveComposition } from "./fork-crew.mjs";
import { emptyWitnessReport, witnessReport } from "./witness.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const MERGIRAF_RESOLVER = path.join(repoRoot, "scripts/resolvers/mergiraf-resolver.mjs");
export const REPLAY_RESOLVER = path.join(repoRoot, "scripts/resolvers/replay-resolver.mjs");

/** Variables a replayer may receive (a model API key and its settings). */
export const REPLAYER_ENV_NAMES = Object.freeze([
	"LLM_PROVIDER",
	"LLM_MODEL",
	"LLM_BASE_URL",
	"ANTHROPIC_API_KEY",
	"WORKERS_AI_ACCOUNT_ID",
	"WORKERS_AI_API_TOKEN",
]);

/**
 * The mergiraf binary to use, or null when none is installed.
 * @param {string | undefined} [explicit]
 */
export function findMergiraf(explicit = process.env.MERGIRAF_BIN) {
	const candidates = explicit ? [explicit] : ["mergiraf", path.join(process.env.HOME ?? "", ".cargo/bin/mergiraf")];
	for (const bin of candidates) {
		const r = spawnSync(bin, ["--version"], { encoding: "utf8", env: minimalEnv() });
		if (r.status === 0) return bin;
	}
	return null;
}

/**
 * @param {string} repo
 * @param {string} a
 * @param {string} b
 * @param {string[]} paths
 */
export function sameLeasedText(repo, a, b, paths) {
	for (const file of paths) {
		const blob = (/** @type {string} */ sha) =>
			safeGit(repo, ["rev-parse", `${sha}:${file}`], { allowFailure: true }).stdout.trim();
		if (blob(a) !== blob(b)) return false;
	}
	return true;
}

/**
 * @typedef {import("./witness.mjs").LoadedWitnesses} LoadedWitnesses
 * @typedef {ReturnType<typeof import("./witness.mjs").freezeWitnesses>} FrozenWitnesses
 * @typedef {{ rung: string, order: string | null, sha: string | null, error: string | null, verdict: string | null, report_sha256: string | null }} Attempt
 */

/**
 * Climb the ladder for one CONFLICTED crew result.
 *
 * @param {string} repo
 * @param {Parameters<typeof resolveComposition>[1]} crewResult
 * @param {{
 *   witnesses: LoadedWitnesses | null,
 *   frozen: FrozenWitnesses | null,
 *   capsuleId?: string | null,
 *   mergiraf?: string | null,
 *   replayer?: string | null,
 *   replayerId?: string,
 *   replayerEnv?: Record<string, string | undefined>,
 *   timeoutMs?: number,
 * }} opts
 */
export function resolveWithLadder(repo, crewResult, opts) {
	if (crewResult.status !== "CONFLICTED" || crewResult.conflict === null) {
		throw new Error("resolveWithLadder requires a CONFLICTED result");
	}
	const conflict = crewResult.conflict;
	const requiredSides = [...new Set(conflict.files.flatMap((file) => file.sides.map((side) => side.agent_id)))].sort();
	const capsuleId = opts.capsuleId ?? null;
	/** @type {Attempt[]} */
	const attempts = [];

	/** @param {string} sha */
	const gate = (sha) =>
		opts.witnesses && opts.frozen
			? witnessReport(repo, sha, opts.witnesses, opts.frozen, { requiredSides, capsuleId, timeoutMs: opts.timeoutMs })
			: emptyWitnessReport(sha, requiredSides, capsuleId);

	/**
	 * @param {string} rung
	 * @param {string | null} order
	 * @param {string} command
	 * @param {Record<string, string>} env
	 * @param {string} resolverId
	 */
	const attempt = (rung, order, command, env, resolverId) => {
		try {
			const resolved = resolveComposition(repo, crewResult, command, {
				env,
				resolver: { id: resolverId, rung, order },
			});
			const witness = gate(resolved.sha);
			attempts.push({ rung, order, sha: resolved.sha, error: null, verdict: witness.verdict, report_sha256: witness.sha256 });
			return { resolved, witness };
		} catch (error) {
			attempts.push({ rung, order, sha: null, error: /** @type {Error} */ (error).message, verdict: null, report_sha256: null });
			return null;
		}
	};

	/** @param {string} reason @param {Array<{ resolved: ReturnType<typeof resolveComposition>, witness: ReturnType<typeof gate> }>} candidates */
	const review = (reason, candidates) => {
		resetToBaseline(repo, crewResult.baseline);
		return {
			status: /** @type {const} */ ("REVIEW"),
			reason,
			required_sides: requiredSides,
			attempts,
			candidates: candidates.map((c) => ({
				sha: c.resolved.sha,
				rung: c.resolved.resolver.rung,
				order: c.resolved.resolver.order,
				resolver_id: c.resolved.resolver.id,
				lease: c.resolved.lease,
				witness: c.witness,
			})),
		};
	};

	/**
	 * @param {{ resolved: ReturnType<typeof resolveComposition>, witness: ReturnType<typeof gate> }} chosen
	 * @param {"identical" | "behavioral" | null} agreement
	 */
	const admit = (chosen, agreement) => {
		const published = publishAdmitted(repo, crewResult, chosen.resolved.sha, (sha) => {
			const witness = gate(sha);
			return { ok: witness.verdict === "ADMIT", reason: `witnesses ${witness.verdict}`, witness };
		});
		if (!published.ok) return review(`the admitted candidate was not published: ${published.reason}`, [chosen]);
		return {
			status: /** @type {const} */ ("RESOLVED"),
			sha: published.sha,
			published_base: published.base,
			rebases: published.rebases,
			rung: chosen.resolved.resolver.rung,
			order: chosen.resolved.resolver.order,
			resolver_id: chosen.resolved.resolver.id,
			order_agreement: agreement,
			lease: chosen.resolved.lease,
			witness: published.witness ?? chosen.witness,
			attempts,
		};
	};

	// Rung 1 — structured merge.
	if (opts.mergiraf) {
		const r = attempt("structured", null, `node ${JSON.stringify(MERGIRAF_RESOLVER)}`, { MERGIRAF_BIN: opts.mergiraf }, "mergiraf");
		if (r?.witness.verdict === "ADMIT") return admit(r, null);
		if (r?.witness.verdict === "REVIEW") return review("structured merge produced a candidate, but a conflicting side has no discriminating witness", [r]);
	}

	// Rung 2 — dual-order intent replay.
	if (opts.replayer) {
		/** @type {Record<string, string>} */
		const env = { MADGRIX_REPLAYER: opts.replayer };
		for (const name of REPLAYER_ENV_NAMES) {
			const value = opts.replayerEnv?.[name];
			if (value !== undefined) env[name] = value;
		}
		const id = `replay:${opts.replayerId ?? "replayer"}`;
		const ab = attempt("replay", "AB", `node ${JSON.stringify(REPLAY_RESOLVER)}`, { ...env, MADGRIX_REPLAY_ORDER: "AB" }, id);
		const ba = attempt("replay", "BA", `node ${JSON.stringify(REPLAY_RESOLVER)}`, { ...env, MADGRIX_REPLAY_ORDER: "BA" }, id);
		const produced = [ab, ba].filter((x) => x !== null);
		if (ab && ba && ab.witness.verdict === "ADMIT" && ba.witness.verdict === "ADMIT") {
			const identical = sameLeasedText(repo, ab.resolved.sha, ba.resolved.sha, ab.resolved.lease.paths);
			return admit(ab, identical ? "identical" : "behavioral");
		}
		if (produced.some((x) => x.witness.verdict === "REVIEW") && produced.every((x) => x.witness.verdict !== "REFUSE")) {
			return review("replay produced candidates, but a conflicting side has no discriminating witness", produced);
		}
		if (produced.some((x) => x.witness.verdict === "ADMIT")) {
			return review("the two replay orders disagree: one is admitted and the other is not, so the result depends on order", produced);
		}
		return review("neither replay order produced an admissible candidate", produced);
	}

	return review(opts.mergiraf ? "structured merge did not produce an admissible candidate and no replayer is configured" : "no resolver rung is available", []);
}

/**
 * An operator-supplied resolver command (the "command" rung), held to the same
 * lease and the same witness gate as every ladder rung. Returns the ladder's
 * result shape.
 *
 * @param {string} repo
 * @param {Parameters<typeof resolveComposition>[1]} crewResult
 * @param {string} command
 * @param {{ witnesses: LoadedWitnesses | null, frozen: FrozenWitnesses | null, capsuleId?: string | null, timeoutMs?: number }} opts
 */
export function resolveWithCommand(repo, crewResult, command, opts) {
	if (crewResult.status !== "CONFLICTED" || crewResult.conflict === null) {
		throw new Error("resolveWithCommand requires a CONFLICTED result");
	}
	const requiredSides = [...new Set(crewResult.conflict.files.flatMap((file) => file.sides.map((side) => side.agent_id)))].sort();
	const capsuleId = opts.capsuleId ?? null;
	/** @type {Attempt[]} */
	const attempts = [];
	let resolved;
	try {
		resolved = resolveComposition(repo, crewResult, command, { resolver: { id: "command", rung: "command", order: null } });
	} catch (error) {
		attempts.push({ rung: "command", order: null, sha: null, error: /** @type {Error} */ (error).message, verdict: null, report_sha256: null });
		resetToBaseline(repo, crewResult.baseline);
		return { status: /** @type {const} */ ("REVIEW"), reason: "the resolver command did not produce a leased resolution", required_sides: requiredSides, attempts, candidates: [] };
	}
	const witness =
		opts.witnesses && opts.frozen
			? witnessReport(repo, resolved.sha, opts.witnesses, opts.frozen, { requiredSides, capsuleId, timeoutMs: opts.timeoutMs })
			: emptyWitnessReport(resolved.sha, requiredSides, capsuleId);
	attempts.push({ rung: "command", order: null, sha: resolved.sha, error: null, verdict: witness.verdict, report_sha256: witness.sha256 });
	const published =
		witness.verdict === "ADMIT"
			? publishAdmitted(repo, crewResult, resolved.sha, (sha) => {
					const w = opts.witnesses && opts.frozen
						? witnessReport(repo, sha, opts.witnesses, opts.frozen, { requiredSides, capsuleId, timeoutMs: opts.timeoutMs })
						: emptyWitnessReport(sha, requiredSides, capsuleId);
					return { ok: w.verdict === "ADMIT", reason: `witnesses ${w.verdict}`, witness: w };
				})
			: null;
	const refused = published && !published.ok ? published.reason : null;
	if (published && published.ok) {
		return {
			status: /** @type {const} */ ("RESOLVED"),
			sha: published.sha,
			published_base: published.base,
			rebases: published.rebases,
			rung: "command",
			order: null,
			resolver_id: "command",
			order_agreement: null,
			lease: resolved.lease,
			witness: published.witness ?? witness,
			attempts,
		};
	}
	resetToBaseline(repo, crewResult.baseline);
	return {
		status: /** @type {const} */ ("REVIEW"),
		reason: refused ? `the admitted candidate was not published: ${refused}` : witness.verdict === "REFUSE" ? "the resolver command's candidate lost a side's witnessed intent" : "a conflicting side has no discriminating witness",
		required_sides: requiredSides,
		attempts,
		candidates: [{ sha: resolved.sha, rung: "command", order: null, resolver_id: "command", lease: resolved.lease, witness }],
	};
}

/**
 * @param {string} repo
 * @param {string} baseline
 */
function resetToBaseline(repo, baseline) {
	// main was never moved for a CONFLICTED crew; only the checkout returns.
	restoreCheckout(repo, baseline);
}

/**
 * Publish an admitted candidate: main moves from the crew's main (CAS).
 * Returns null on success, or the refusal message when main moved.
 * @param {string} repo
 * @param {{ baseline: string, main_before?: string | null }} crewResult
 * @param {string} sha
 */
export function publishCandidate(repo, crewResult, sha) {
	const expected = crewResult.main_before === undefined ? crewResult.baseline : crewResult.main_before;
	try {
		publishMain(repo, sha, expected);
		return null;
	} catch (error) {
		restoreCheckout(repo, crewResult.baseline);
		return /** @type {Error} */ (error).message;
	}
}

/**
 * Publish an admitted candidate with compare-and-swap. When another run moved
 * main, the candidate is rebased onto the new main and published only if
 * `reverify` (the witness gate on the rebased commit) admits it again, at
 * most MADGRIX_MAIN_REBASE_RETRIES times (default 3; 0 refuses at once).
 * @template W
 * @param {string} repo
 * @param {{ baseline: string, main_before?: string | null }} crewResult
 * @param {string} sha
 * @param {(sha: string) => { ok: boolean, reason?: string, witness?: W }} reverify
 */
export function publishAdmitted(repo, crewResult, sha, reverify) {
	const expected = crewResult.main_before === undefined ? crewResult.baseline : crewResult.main_before;
	const result = publishWithRebase(repo, sha, expected, { reverify });
	if (!result.ok) restoreCheckout(repo, crewResult.baseline);
	return result;
}

/**
 * The resolution block a RESOLVED composition record carries
 * (CompositionResolution in src/lib/types.ts).
 *
 * @param {{ sha: string, rung: string, resolver_id: string, order_agreement?: string | null, lease: { paths: string[], precomposed_tree: string }, witness: { sha256: string, verdict: string, report: { witness_manifest_sha256: string | null } } }} result
 * @param {{ capsuleId: string, witnessManifestSha256: string | null, reviewClearedBy?: string | null }} binding
 * @returns {import("../../src/lib/types.ts").CompositionResolution}
 */
export function resolutionRecord(result, binding) {
	if (result.rung !== "structured" && result.rung !== "replay" && result.rung !== "command") {
		throw new Error(`resolutionRecord: unknown rung ${result.rung}`);
	}
	if (result.witness.verdict !== "ADMIT" && result.witness.verdict !== "REVIEW") {
		throw new Error(`resolutionRecord: a ${result.witness.verdict} candidate cannot be recorded`);
	}
	const agreement = result.order_agreement ?? null;
	if (agreement !== null && agreement !== "identical" && agreement !== "behavioral") {
		throw new Error(`resolutionRecord: unknown order agreement ${agreement}`);
	}
	return {
		format: "madgrix-resolution/v1",
		capsule_id: binding.capsuleId,
		resolver_id: result.resolver_id,
		rung: result.rung,
		order_agreement: agreement,
		lease: { paths: result.lease.paths, precomposed_tree: result.lease.precomposed_tree },
		witness: {
			witness_manifest_sha256: binding.witnessManifestSha256 ?? null,
			witness_report_sha256: result.witness.sha256,
			verdict: result.witness.verdict,
			review_cleared_by: result.witness.verdict === "REVIEW" ? binding.reviewClearedBy ?? null : null,
		},
	};
}
