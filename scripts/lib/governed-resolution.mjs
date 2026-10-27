/**
 * What the control plane records for one fork-crew run, in the order the
 * authority must receive it (specs/amendments/governed-resolution-v1.md).
 *
 *   COMPOSED          [COMPOSED (+ witness_check when witnesses are declared)]
 *   SEMANTIC_CONFLICT nothing: the text merged cleanly, but a frozen witness
 *                     shows a side's intent did not survive the merge
 *   CONFLICTED        [CONFLICTED] (no resolver configured)
 *   RESOLVED          [CONFLICTED, RESOLVED (+ resolution bound to the capsule)]
 *   REVIEW            [CONFLICTED]; nothing is admitted until a person either
 *                     clears an unwitnessed candidate or supplies a resolver
 *
 * A REVIEW can be cleared (reviewClearedBy) only for a candidate whose witness
 * verdict is REVIEW — a side had no discriminating witness, which is an
 * ambiguity a person may settle. A REFUSE verdict, or replay orders that
 * disagree, is never cleared here: a person answers it with a resolver command,
 * whose output is gated again.
 */


import { buildConflictCapsuleV2 } from "../../src/lib/conflict-capsule.ts";
import { safeGit } from "./safe-git.mjs";
import { buildAdmissionProof } from "./admission.mjs";
import { authorityComposition, deleteRunRefs } from "./fork-crew.mjs";
import { MainMovedError, publishMain, readMain, restoreCheckout } from "./main-ref.mjs";
import {
	REPLAYER_ENV_NAMES,
	findMergiraf,
	publishCandidate,
	resolutionRecord,
	resolveWithCommand,
	resolveWithLadder,
	sameLeasedText,
} from "./resolve-ladder.mjs";
import { witnessReport } from "./witness.mjs";

/**
 * @typedef {import("./witness.mjs").LoadedWitnesses} LoadedWitnesses
 * @typedef {ReturnType<typeof import("./witness.mjs").freezeWitnesses>} FrozenWitnesses
 * @typedef {import("./admission.mjs").WitnessSigner} WitnessSigner
 */

/**
 * @param {string} repo
 * @param {any} crewRun the result of runCrewOnFork
 * @param {{
 *   taskHash: string,
 *   contenderId: string,
 *   witnesses: LoadedWitnesses | null,
 *   frozen: FrozenWitnesses | null,
 *   mode: "none" | "ladder" | "command",
 *   command?: string | null,
 *   replayer?: string | null,
 *   replayerId?: string,
 *   replayerEnv?: Record<string, string | undefined>,
 *   mergiraf?: string | null | "auto",
 *   requiredSides?: string[],
 *   reviewClearedBy?: string | null,
 *   timeoutMs?: number,
 *   witnessSigner?: WitnessSigner,
 * }} opts
 */
export async function governCrewResult(repo, crewRun, opts) {
	const result = await governInner(repo, crewRun, opts);
	// Run refs keep the sub-agent commits reachable. Once the candidate is on
	// main they are reachable through its parents and are deleted; a run that
	// did not publish keeps them for forensics (prune with
	// `npm run prune:runs -- <repo> [--older-than-days N]`).
	const runRef = /** @type {{ run_ref?: string }} */ (crewRun).run_ref;
	/** @type {{ run_refs: "deleted" | "kept" | "none", forensic_ref: string | null }} */
	let refs = { run_refs: "none", forensic_ref: null };
	if (runRef) {
		const published = result.candidateSha !== null && readMain(repo) === result.candidateSha;
		if (published) {
			deleteRunRefs(repo, runRef);
			refs = { run_refs: "deleted", forensic_ref: null };
		} else refs = { run_refs: "kept", forensic_ref: runRef };
	}
	let proofs = null;
	/** @type {string | null} */
	let proofError = null;
	if (opts.witnessSigner && result.candidateSha) {
		try {
			proofs = await attachAdmissionProofs(repo, result.compositions, { ...opts, witnessSigner: opts.witnessSigner }, result);
		} catch (error) {
			// No proof can be built (e.g. a gitlink that tree-digest/v1 cannot bind).
			// Report it instead of throwing: the records stay proof-less, so an
			// authority with a pinned runner key refuses them.
			proofError = error instanceof Error ? error.message : String(error);
		}
	}
	return { ...result, ...refs, ...(proofs ? { compositions: proofs } : {}), ...(proofError ? { admission_proof_error: proofError } : {}) };
}

/**
 * @param {string} repo
 * @param {Parameters<typeof governCrewResult>[1]} crewRun
 * @param {Parameters<typeof governCrewResult>[2]} opts
 */
async function governInner(repo, crewRun, opts) {
	const manifestSha = opts.witnesses?.sha256 ?? null;
	/**
	 * @param {"COMPOSED" | "CONFLICTED" | "RESOLVED"} status
	 * @param {string | null} sha
	 * @param {{ resolution?: any, witness_check?: any, rebased_onto?: string | null }} [extra]
	 */
	const record = (status, sha, extra = {}) =>
		authorityComposition({
			status,
			baseline: crewRun.baseline,
			commits: crewRun.commits,
			conflict: crewRun.conflict,
			sha,
			contender_id: opts.contenderId,
			witness_manifest_sha256: manifestSha,
			...extra,
		});

	if (crewRun.status === "COMPOSED") {
		if (!opts.witnesses || !opts.frozen) {
			return {
				status: /** @type {const} */ ("COMPOSED"),
				candidateSha: crewRun.sha,
				compositions: [record("COMPOSED", crewRun.sha, crewRun.published_base ? { rebased_onto: crewRun.published_base } : {})],
				witness: null,
			};
		}
		const witness = witnessReport(repo, crewRun.sha, opts.witnesses, opts.frozen, {
			requiredSides: opts.requiredSides ?? [],
			timeoutMs: opts.timeoutMs,
		});
		if (witness.verdict === "REFUSE") {
			const main_revert = revertComposed(repo, crewRun);
			return {
				status: /** @type {const} */ ("SEMANTIC_CONFLICT"),
				candidateSha: null,
				compositions: [],
				witness,
				detail: `the crew's edits merged cleanly as text, but ${witness.report.reasons.join("; ")}`,
				main_revert,
			};
		}
		if (witness.verdict === "REVIEW" && !opts.reviewClearedBy) {
			const main_revert = revertComposed(repo, crewRun);
			return { status: /** @type {const} */ ("REVIEW"), candidateSha: null, compositions: [], witness, detail: witness.report.reasons.join("; "), main_revert };
		}
		const witness_check = {
			witness_manifest_sha256: manifestSha,
			witness_report_sha256: witness.sha256,
			verdict: witness.verdict,
			review_cleared_by: witness.verdict === "REVIEW" ? opts.reviewClearedBy ?? null : null,
		};
		return {
			status: /** @type {const} */ ("COMPOSED"),
			candidateSha: crewRun.sha,
			compositions: [record("COMPOSED", crewRun.sha, { witness_check, ...(crewRun.published_base ? { rebased_onto: crewRun.published_base } : {}) })],
			witness,
		};
	}

	if (crewRun.status !== "CONFLICTED") throw new Error(`governCrewResult: unexpected crew status ${crewRun.status}`);
	const conflicted = record("CONFLICTED", null);
	const capsule = await buildConflictCapsuleV2(opts.taskHash, /** @type {any} */ (conflicted));
	const conflictedRecord = { ...conflicted, capsule_id: capsule.capsule_id };
	if (opts.mode === "none") {
		return { status: /** @type {const} */ ("CONFLICTED"), candidateSha: null, compositions: [conflictedRecord], capsule };
	}

	const ladderOpts = { witnesses: opts.witnesses, frozen: opts.frozen, capsuleId: capsule.capsule_id, timeoutMs: opts.timeoutMs };
	let result;
	if (opts.mode === "command") {
		if (!opts.command) throw new Error("governCrewResult: command mode needs a resolver command");
		result = resolveWithCommand(repo, crewRun, opts.command, ladderOpts);
	} else {
		/** @type {Record<string, string | undefined>} */
		const replayerEnv = {};
		for (const name of REPLAYER_ENV_NAMES) replayerEnv[name] = opts.replayerEnv?.[name];
		result = resolveWithLadder(repo, crewRun, {
			...ladderOpts,
			mergiraf: opts.mergiraf === "auto" || opts.mergiraf === undefined ? findMergiraf() : opts.mergiraf,
			replayer: opts.replayer ?? null,
			replayerId: opts.replayerId,
			replayerEnv,
		});
	}

	if (result.status === "REVIEW") {
		const clearable = clearableCandidate(repo, result.candidates);
		if (!opts.reviewClearedBy || !clearable) {
			return { status: /** @type {const} */ ("REVIEW"), candidateSha: null, compositions: [conflictedRecord], capsule, review: result };
		}
		const refused = publishCandidate(repo, crewRun, clearable.candidate.sha);
		if (refused) {
			return {
				status: /** @type {const} */ ("REVIEW"),
				candidateSha: null,
				compositions: [conflictedRecord],
				capsule,
				review: { ...result, reason: `the cleared candidate was not published: ${refused}` },
			};
		}
		const resolution = resolutionRecord(
			{ ...clearable.candidate, order_agreement: clearable.agreement },
			{ capsuleId: capsule.capsule_id, witnessManifestSha256: manifestSha, reviewClearedBy: opts.reviewClearedBy },
		);
		const clearedSha = clearable.candidate.sha;
		return {
			status: /** @type {const} */ ("RESOLVED"),
			candidateSha: clearedSha,
			compositions: [conflictedRecord, record("RESOLVED", clearedSha, { resolution })],
			capsule,
			review: result,
		};
	}

	const resolution = resolutionRecord(result, { capsuleId: capsule.capsule_id, witnessManifestSha256: manifestSha });
	return {
		status: /** @type {const} */ ("RESOLVED"),
		candidateSha: result.sha,
		compositions: [conflictedRecord, record("RESOLVED", result.sha, { resolution, ...(result.rebases?.length ? { rebased_onto: result.published_base } : {}) })],
		capsule,
		ladder: result,
	};
}

/**
 * The REVIEW candidate a person may clear, and how its replay orders agreed.
 * A structured or command candidate with a REVIEW verdict is clearable. A
 * replay candidate is clearable only when both orders produced it
 * byte-for-byte: without witnesses, identical text is the only evidence that
 * the orders agree.
 *
 * @param {string} repo
 * @param {Array<{ sha: string, rung: string, order: string | null, resolver_id: string, lease: { paths: string[], precomposed_tree: string }, witness: { verdict: string, sha256: string, report: any } }>} candidates
 */
function clearableCandidate(repo, candidates) {
	const reviewable = candidates.filter((c) => c.witness.verdict === "REVIEW");
	const single = reviewable.find((c) => c.rung !== "replay");
	if (single) return { candidate: single, agreement: /** @type {null} */ (null) };
	const ab = reviewable.find((c) => c.rung === "replay" && c.order === "AB");
	const ba = reviewable.find((c) => c.rung === "replay" && c.order === "BA");
	if (ab && ba && sameLeasedText(repo, ab.sha, ba.sha, ab.lease.paths)) {
		return { candidate: ab, agreement: /** @type {const} */ ("identical") };
	}
	return null;
}

/**
 * Take a refused COMPOSED candidate back off main with compare-and-swap: main
 * returns to where it was before the crew only if it is still at the
 * candidate. When another run moved main since, main is left alone and the
 * result says so.
 * @param {string} repo
 * @param {{ baseline: string, sha: string | null, main_before?: string | null }} crewRun
 * @returns {"reverted" | string}
 */
function revertComposed(repo, crewRun) {
	const before = crewRun.main_before === undefined ? crewRun.baseline : crewRun.main_before;
	if (!crewRun.sha || before === null) {
		restoreCheckout(repo, crewRun.baseline);
		return "reverted";
	}
	try {
		publishMain(repo, before, crewRun.sha);
		return "reverted";
	} catch (error) {
		restoreCheckout(repo, crewRun.baseline);
		if (error instanceof MainMovedError) return `not reverted: ${error.message}`;
		throw error;
	}
}

/**
 * Add an admission proof (src/lib/admission-proof.ts, scripts/lib/admission.mjs)
 * to each COMPOSED or RESOLVED record of the published candidate.
 *
 * @param {string} repo
 * @param {any[]} compositions
 * @param {{ taskHash: string, witnessSigner: WitnessSigner }} opts
 * @param {{ candidateSha: string | null }} result
 */
async function attachAdmissionProofs(repo, compositions, opts, result) {
	/** @type {string | null} */
	const capsule = compositions.find((c) => c.status === "CONFLICTED")?.capsule_id ?? null;
	const out = [];
	for (const record of compositions) {
		if ((record.status !== "COMPOSED" && record.status !== "RESOLVED") || record.candidate_sha !== result.candidateSha) {
			out.push(record);
			continue;
		}
		const admission_proof = await buildAdmissionProof(repo, record, { taskHash: opts.taskHash, capsuleId: capsule, signer: opts.witnessSigner });
		out.push({ ...record, admission_proof });
	}
	return out;
}
