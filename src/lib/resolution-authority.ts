/**
 * Authority rules for governed resolution
 * (specs/amendments/governed-resolution-v1.md §5).
 *
 * Pure validation and projection; task-state.ts applies them inside
 * recordComposition and finalize. The authority does not run witnesses or
 * resolvers: it binds what the control plane reports — the capsule a
 * resolution answers, the frozen witness manifest, the report digest and its
 * verdict — and refuses the states that must never be recorded.
 */

import type {
	AuthorityState,
	CompositionHunk,
	CompositionRecord,
	CompositionResolution,
	WitnessCheck,
} from "./types.ts";
import type { AdmissionProof } from "./admission-proof.ts";

const HEX64 = /^[0-9a-f]{64}$/;
const GIT_OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Hunk digests of one conflicted file, validated; undefined when absent. */
export function normalizeHunks(raw: unknown): CompositionHunk[] | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (!Array.isArray(raw) || raw.length === 0) throw new Error("recordComposition: hunks must be a non-empty list");
	return raw.map((hunk, i) => {
		if (!isRecord(hunk) || !Number.isInteger(hunk.index) || (hunk.index as number) < 0) {
			throw new Error(`recordComposition: hunk ${i} has no index`);
		}
		if (typeof hunk.base_sha256 !== "string" || !HEX64.test(hunk.base_sha256)) {
			throw new Error(`recordComposition: hunk ${i} has no base digest`);
		}
		if (!Array.isArray(hunk.sides) || hunk.sides.length < 2) {
			throw new Error(`recordComposition: hunk ${i} needs two sides`);
		}
		return {
			index: hunk.index as number,
			base_sha256: hunk.base_sha256,
			sides: hunk.sides.map((side) => {
				if (!isRecord(side) || typeof side.agent_id !== "string" || typeof side.sha256 !== "string" || !HEX64.test(side.sha256)) {
					throw new Error(`recordComposition: hunk ${i} has a malformed side`);
				}
				return { agent_id: side.agent_id, sha256: side.sha256 };
			}),
		};
	});
}

/** A digest field that may be null; throws when present and malformed. */
export function normalizeDigest(raw: unknown, label: string): string | null {
	if (raw === undefined || raw === null) return null;
	if (typeof raw !== "string" || !HEX64.test(raw)) throw new Error(`recordComposition: ${label} is not a SHA-256 digest`);
	return raw;
}

/**
 * A witness check the authority may record: ADMIT, or REVIEW cleared by a
 * named operator. REFUSE is never recordable — no review clears a lost
 * intent.
 */
export function normalizeWitnessCheck(raw: unknown, label: string): WitnessCheck {
	if (!isRecord(raw)) throw new Error(`recordComposition: ${label} is required`);
	const verdict = raw.verdict;
	if (verdict === "REFUSE") throw new Error(`recordComposition: ${label} REFUSED the candidate; a refused candidate cannot be recorded`);
	if (verdict !== "ADMIT" && verdict !== "REVIEW") throw new Error(`recordComposition: ${label} verdict must be ADMIT or REVIEW`);
	const cleared = typeof raw.review_cleared_by === "string" ? raw.review_cleared_by.trim() : "";
	if (verdict === "REVIEW" && cleared === "") {
		throw new Error(`recordComposition: ${label} is REVIEW and nobody cleared the review`);
	}
	const report = normalizeDigest(raw.witness_report_sha256, `${label}.witness_report_sha256`);
	if (report === null) throw new Error(`recordComposition: ${label} has no witness report digest`);
	return {
		witness_manifest_sha256: normalizeDigest(raw.witness_manifest_sha256, `${label}.witness_manifest_sha256`),
		witness_report_sha256: report,
		verdict,
		review_cleared_by: verdict === "REVIEW" ? cleared : null,
	};
}

/** A RESOLVED record's resolution block, validated against the record it resolves. */
export function normalizeResolution(raw: unknown, current: CompositionRecord): CompositionResolution {
	if (!isRecord(raw)) throw new Error("recordComposition: RESOLVED requires a resolution block");
	if (raw.format !== "madgrix-resolution/v1") throw new Error("recordComposition: resolution format is not madgrix-resolution/v1");
	if (typeof current.capsule_id !== "string" || current.capsule_id === "") {
		throw new Error("recordComposition: the conflicted record has no capsule to resolve");
	}
	if (raw.capsule_id !== current.capsule_id) {
		throw new Error("recordComposition: the resolution answers another conflict capsule");
	}
	if (typeof raw.resolver_id !== "string" || raw.resolver_id === "") throw new Error("recordComposition: resolution names no resolver");
	if (raw.rung !== "structured" && raw.rung !== "replay" && raw.rung !== "command") {
		throw new Error("recordComposition: resolution rung must be structured, replay or command");
	}
	const agreement = raw.order_agreement ?? null;
	if (agreement !== null && agreement !== "identical" && agreement !== "behavioral") {
		throw new Error("recordComposition: order_agreement must be identical, behavioral or null");
	}
	if (raw.rung === "replay" && agreement === null) {
		throw new Error("recordComposition: a replay resolution must record how its two orders agreed");
	}
	const lease = raw.lease;
	if (!isRecord(lease) || !Array.isArray(lease.paths) || typeof lease.precomposed_tree !== "string" || !GIT_OBJECT_ID.test(lease.precomposed_tree)) {
		throw new Error("recordComposition: resolution lease is malformed");
	}
	const leased = [...(lease.paths as unknown[])].map(String).sort();
	const conflicted = current.files.map((file) => file.path).sort();
	if (JSON.stringify(leased) !== JSON.stringify(conflicted)) {
		throw new Error("recordComposition: the resolution lease is not the conflicted paths");
	}
	const witness = normalizeWitnessCheck(raw.witness, "resolution.witness");
	if (witness.witness_manifest_sha256 !== (current.witness_manifest_sha256 ?? null)) {
		throw new Error("recordComposition: the resolution was checked against another witness manifest than the one frozen with the conflict");
	}
	return {
		format: "madgrix-resolution/v1",
		capsule_id: current.capsule_id,
		resolver_id: raw.resolver_id,
		rung: raw.rung,
		order_agreement: agreement,
		lease: { paths: leased, precomposed_tree: lease.precomposed_tree },
		witness,
	};
}

/** The payload a `resolution_recorded` ledger entry hashes, and the bundle carries. */
export interface ResolutionPayload {
	candidate_sha: string;
	contender_id: string;
	baseline: string;
	resolution: CompositionResolution;
	/**
	 * Present when the authority verified an admission proof: the proof as
	 * recorded, and what offline verify needs to check it again.
	 */
	contributing_shas?: string[];
	rebased_onto?: string | null;
	admission_proof?: AdmissionProof;
}

export function resolutionPayload(composition: CompositionRecord): ResolutionPayload | null {
	if (composition.status !== "RESOLVED" || !composition.resolution || typeof composition.candidate_sha !== "string") return null;
	return {
		candidate_sha: composition.candidate_sha,
		contender_id: composition.contender_id,
		baseline: composition.baseline,
		resolution: composition.resolution,
		...(composition.admission_proof
			? {
					contributing_shas: [...composition.contributing_shas].sort(),
					rebased_onto: composition.rebased_onto ?? null,
					admission_proof: composition.admission_proof,
				}
			: {}),
	};
}

/**
 * The member claim pairs whose stored conflict report is RED or BLOCKED. A
 * COMPOSED record over such a pair merged cleanly as text while the claims
 * said the agents touch the same symbol, contract or state; the authority
 * then requires a witness check before the candidate can be recorded.
 */
export function riskyMemberPairs(state: AuthorityState, composition: CompositionRecord): Array<[string, string]> {
	const members = new Set(composition.agents.map((agent) => agent.claim_work_id).filter((id): id is string => typeof id === "string"));
	return (state.conflict_reports ?? [])
		.filter((r) => (r.risk === "RED" || r.risk === "BLOCKED") && members.has(r.claim_a) && members.has(r.claim_b))
		.map((r) => [r.claim_a, r.claim_b] as [string, string]);
}
