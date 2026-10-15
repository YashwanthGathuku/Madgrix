/**
 * Forward-only Git ancestry for a Queue push that skipped a causal predecessor.
 *
 * The Worker reads commit parents from Artifacts (`repo.readCommit`). TaskAuthority
 * validates the resulting proof against its current tip and does not call Artifacts.
 * specs/amendments/queue-ancestry-reconciliation-v1.md
 *
 * The walk visits at most ANCESTRY_VISIT_BOUND commits. A deeper cone is retried,
 * not guessed. Merge commits are followed through every parent.
 */

/** Commits read from Artifacts during one ancestry walk, excluding the tip itself. */
export const ANCESTRY_VISIT_BOUND = 256;

/** Real Git SHA-1, or the harness SHA-256. Symbolic test ids are not commit ids. */
const COMMIT_ID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

export interface AncestryEdge {
	hash: string;
	parents: string[];
}

/**
 * `forward`: observed_tip is a parent-walk ancestor of target_after.
 * `closed_refusal`: every parent in the cone was read, and the tip is absent.
 * The refusal form is how a ref update whose `before` is the tip is still
 * rejected when Artifacts shows that update is not forward.
 */
export interface AncestryProof {
	observed_tip: string;
	target_after: string;
	path: AncestryEdge[];
	source: "artifacts.readCommit";
	relation: "forward" | "closed_refusal";
}

export type ProofVerdict =
	| { ok: true; relation: "forward" | "closed_refusal" }
	| { ok: false; reason: "malformed" | "unbound" | "cycle" | "incomplete" };

export interface CommitParents {
	hash: string;
	parents: string[];
}

export type AncestryLookup =
	| { status: "forward" | "closed_refusal"; proof: AncestryProof }
	| { status: "retry"; reason: "transient" | "bound" | "missing" | "malformed" }
	| { status: "unprovable" };

export function isCommitId(value: string): boolean {
	return COMMIT_ID.test(value);
}

/**
 * Check that a proof's own edges make `observed_tip` an ancestor of
 * `target_after`, or that the cone is closed and the tip is absent.
 * This does not compare the proof with authority state. The caller does that.
 */
export function validateAncestryProof(proof: AncestryProof): ProofVerdict {
	if (!proof || proof.source !== "artifacts.readCommit") return { ok: false, reason: "malformed" };
	if (proof.relation !== "forward" && proof.relation !== "closed_refusal") return { ok: false, reason: "malformed" };
	if (!isCommitId(proof.observed_tip) || !isCommitId(proof.target_after)) return { ok: false, reason: "malformed" };
	if (proof.observed_tip === proof.target_after) return { ok: false, reason: "malformed" };
	if (!Array.isArray(proof.path) || proof.path.length === 0) return { ok: false, reason: "malformed" };
	if (proof.path.length > ANCESTRY_VISIT_BOUND) return { ok: false, reason: "unbound" };

	const nodes = new Map<string, string[]>();
	for (const edge of proof.path) {
		if (!edge || typeof edge.hash !== "string" || !isCommitId(edge.hash)) return { ok: false, reason: "malformed" };
		if (nodes.has(edge.hash)) return { ok: false, reason: "cycle" };
		if (!Array.isArray(edge.parents)) return { ok: false, reason: "malformed" };
		const parents: string[] = [];
		for (const parent of edge.parents) {
			if (typeof parent !== "string" || !isCommitId(parent) || parent === edge.hash) {
				return { ok: false, reason: parent === edge.hash ? "cycle" : "malformed" };
			}
			parents.push(parent);
		}
		nodes.set(edge.hash, parents);
	}
	if (!nodes.has(proof.target_after)) return { ok: false, reason: "malformed" };
	// The tip is the end of a forward walk, not a commit whose own parents are claimed.
	if (nodes.has(proof.observed_tip)) return { ok: false, reason: "malformed" };

	const seen = new Set<string>();
	const queue = [proof.target_after];
	let reachedTip = false;
	while (queue.length > 0) {
		const hash = queue.shift();
		if (hash === undefined) break;
		if (hash === proof.observed_tip) {
			reachedTip = true;
			continue;
		}
		if (seen.has(hash)) return { ok: false, reason: "cycle" };
		seen.add(hash);
		if (seen.size > ANCESTRY_VISIT_BOUND) return { ok: false, reason: "unbound" };
		const parents = nodes.get(hash);
		if (parents === undefined) return { ok: false, reason: "incomplete" };
		for (const parent of parents) {
			if (parent === proof.observed_tip) {
				reachedTip = true;
				continue;
			}
			if (!nodes.has(parent)) return { ok: false, reason: "incomplete" };
			queue.push(parent);
		}
	}
	for (const hash of nodes.keys()) {
		if (!seen.has(hash)) return { ok: false, reason: "malformed" };
	}
	if (proof.relation === "forward") {
		if (!reachedTip) return { ok: false, reason: "incomplete" };
		return { ok: true, relation: "forward" };
	}
	if (reachedTip) return { ok: false, reason: "malformed" };
	return { ok: true, relation: "closed_refusal" };
}

/**
 * Read the ancestor cone of `descendant` from Artifacts.
 * A forward proof stops including the ancestor as a node.
 * A missing or throwing read is retryable. An exhausted cone that never
 * sees the ancestor is a closed refusal, not a guess.
 */
export async function lookupForwardAncestry(
	descendant: string,
	ancestor: string,
	readCommit: (hash: string) => Promise<CommitParents | null>,
): Promise<AncestryLookup> {
	if (!isCommitId(descendant) || !isCommitId(ancestor) || descendant === ancestor) {
		return { status: "unprovable" };
	}
	const nodes = new Map<string, string[]>();
	const pending: string[] = [descendant];
	const queued = new Set<string>([descendant]);
	let reached = false;
	while (pending.length > 0) {
		const hash = pending.shift();
		if (hash === undefined) break;
		if (hash === ancestor) {
			reached = true;
			continue;
		}
		if (nodes.has(hash)) continue;
		if (nodes.size >= ANCESTRY_VISIT_BOUND) return { status: "retry", reason: "bound" };
		let commit: CommitParents | null;
		try {
			commit = await readCommit(hash);
		} catch {
			return { status: "retry", reason: "transient" };
		}
		if (commit === null) return { status: "retry", reason: "missing" };
		if (commit.hash !== hash || !Array.isArray(commit.parents)) return { status: "retry", reason: "malformed" };
		const parents: string[] = [];
		for (const parent of commit.parents) {
			if (typeof parent !== "string" || !isCommitId(parent) || parent === hash) {
				return { status: "retry", reason: "malformed" };
			}
			parents.push(parent);
		}
		nodes.set(hash, parents);
		for (const parent of parents) {
			if (parent === ancestor) {
				reached = true;
				continue;
			}
			if (!nodes.has(parent) && !queued.has(parent)) {
				queued.add(parent);
				pending.push(parent);
			}
		}
	}
	if (nodes.size === 0) return { status: "retry", reason: "missing" };
	const path: AncestryEdge[] = [...nodes.entries()].map(([hash, parents]) => ({ hash, parents: [...parents] }));
	const relation = reached ? "forward" : "closed_refusal";
	const proof: AncestryProof = {
		observed_tip: ancestor,
		target_after: descendant,
		path,
		source: "artifacts.readCommit",
		relation,
	};
	const verdict = validateAncestryProof(proof);
	if (!verdict.ok) return { status: "retry", reason: verdict.reason === "unbound" ? "bound" : "malformed" };
	return { status: relation, proof };
}
