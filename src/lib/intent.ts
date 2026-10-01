/**
 * Intent Registry — the answer to "how do agents know what other agents
 * are working on?"
 *
 * Before touching code, an agent registers a structured work claim: what it
 * intends to change (paths, symbols, APIs), the behavior contract it will
 * uphold, and the baseline it builds from. Other agents (and the verdict
 * seam) can then see *semantic* collisions — two agents editing different
 * files that alter the same behavior — which Git's file-level conflict model
 * cannot express.
 */

export interface ClaimedScope {
	/** Repository-relative path prefixes, e.g. ["packages/auth/"] */
	paths: string[];
	/** Code symbols the agent intends to touch, e.g. ["validateToken()"] */
	symbols?: string[];
	/** API surface the agent intends to touch, e.g. ["POST /login"] */
	apis?: string[];
}

export type ClaimStatus = "claimed" | "working" | "submitted" | "released";

export interface WorkClaim {
	work_id: string;
	agent_id: string;
	task_intent: string;
	baseline_commit: string;
	claimed_scope: ClaimedScope;
	/** A falsifiable statement, e.g. "Expired JWT must return 401" */
	behavior_contract: string;
	expected_tests: string[];
	fork_repo?: string;
	status: ClaimStatus;
	claimed_at: string;
}

export type CollisionLevel = "none" | "file" | "semantic";

export interface Collision {
	with_work_id: string;
	with_agent_id: string;
	level: CollisionLevel;
	detail: string;
}

function pathsOverlap(a: string[], b: string[]): string[] {
	const hits: string[] = [];
	for (const p of a) {
		for (const q of b) {
			if (p === q || p.startsWith(q + "/") || q.startsWith(p + "/")) {
				hits.push(`${p} ~ ${q}`);
			}
		}
	}
	return hits;
}

function setOverlap(a: string[] = [], b: string[] = []): string[] {
	const bs = new Set(b);
	return a.filter((x) => bs.has(x));
}

/**
 * Compare one claim against the live claims on the same task.
 * Released (finished) claims are ignored; everything else is fair game.
 */
export function detectCollisions(claim: WorkClaim, others: WorkClaim[]): Collision[] {
	const out: Collision[] = [];
	for (const o of others) {
		if (o.work_id === claim.work_id) continue;
		if (o.status === "released") continue;

		const pathHits = pathsOverlap(claim.claimed_scope.paths, o.claimed_scope.paths);
		const symbolHits = setOverlap(claim.claimed_scope.symbols, o.claimed_scope.symbols);
		const apiHits = setOverlap(claim.claimed_scope.apis, o.claimed_scope.apis);

		if (pathHits.length > 0) {
			out.push({
				with_work_id: o.work_id,
				with_agent_id: o.agent_id,
				level: "file",
				detail: `overlapping paths: ${pathHits.join(", ")}`,
			});
		} else if (symbolHits.length > 0 || apiHits.length > 0) {
			const what = [...symbolHits.map((s) => `symbol ${s}`), ...apiHits.map((a) => `API ${a}`)];
			out.push({
				with_work_id: o.work_id,
				with_agent_id: o.agent_id,
				level: "semantic",
				detail: `shared ${what.join(", ")} across disjoint files — possible behavioral collision`,
			});
		}
	}
	return out;
}
