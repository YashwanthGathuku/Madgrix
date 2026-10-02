/**
 * WorkClaim validation + the live conflict graph (spec 2:
 * INTENT_AND_CONFLICT_GRAPH.md).
 *
 * Pure logic — no I/O, no network. All classifications are deterministic
 * set operations over the claim records; an LLM may EXPLAIN a
 * classification ("B's write to JWTClaims changes the input A's
 * verifyToken reads") but MUST NEVER determine one when deterministic
 * evidence is available (spec 2 §4).
 *
 * There is deliberately NO compensating score anywhere in this file.
 */

import type {
	ConflictLayers,
	ConflictReport,
	ConflictRisk,
	WorkClaim,
} from "./types.ts";

/** Claim fields the contender supplies; work_id/status/version are
 *  assigned by the task authority (see task-state.ts registerClaim). */
export type ClaimInput = Omit<WorkClaim, "work_id" | "status" | "version" | "agent_secret_sha256">;

export type ClaimValidation =
	| { ok: true }
	| { ok: false; error: string };

/**
 * Validate a contender-supplied claim before registration.
 * A claim with an empty scope.paths is INVALID — unbounded claims are
 * not admissible (spec 2 §2). The task/baseline match against the frozen
 * task is checked by the task authority (task-state.ts), not here.
 */
export function validateClaim(input: ClaimInput): ClaimValidation {
	if (typeof input.task !== "string" || input.task.length === 0) {
		return { ok: false, error: "claim.task (task_hash) is required" };
	}
	if (typeof input.baseline !== "string" || input.baseline.length === 0) {
		return { ok: false, error: "claim.baseline (baseline commit) is required" };
	}
	if (!input.scope || !Array.isArray(input.scope.paths) || input.scope.paths.length === 0) {
		return {
			ok: false,
			error: "empty scope.paths — unbounded claims are inadmissible (spec 2 §2)",
		};
	}
	if (!input.scope.paths.every((p) => typeof p === "string" && p.length > 0)) {
		return { ok: false, error: "scope.paths must be non-empty strings" };
	}
	if (!input.contracts || !Array.isArray(input.contracts.reads) || !Array.isArray(input.contracts.modifies)) {
		return { ok: false, error: "contracts.reads and contracts.modifies must be arrays" };
	}
	return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Glob matching (L0). Supports `**` suffix and exact match.           */
/* ------------------------------------------------------------------ */

/** Does a repo-relative path fall inside a claim's scope glob? */
export function globMatchesPath(glob: string, path: string): boolean {
	if (glob === "**") return true;
	if (glob.endsWith("/**")) {
		const prefix = glob.slice(0, -3);
		return path === prefix || path.startsWith(prefix + "/");
	}
	return glob === path;
}

/**
 * Deterministic representative path for a glob: wildcards become a fixed
 * token. Two globs are reported as overlapping when either glob matches
 * the other's representative. This is a heuristic, not a full glob-algebra
 * solver; it is deterministic and conservative enough for the slice.
 */
function representativePath(glob: string): string {
	return glob.replace(/\*\*/g, "__STARSTAR__").replace(/\*/g, "__STAR__");
}

/** Do two scope globs potentially cover a common path? */
export function globsOverlap(a: string, b: string): boolean {
	return (
		globMatchesPath(a, representativePath(b)) ||
		globMatchesPath(b, representativePath(a))
	);
}

/* ------------------------------------------------------------------ */
/* Dependency closure (L2).                                            */
/* ------------------------------------------------------------------ */

/** Transitive dependency closure of `seeds` over depMap (symbol → deps). */
export function dependencyClosure(
	seeds: string[],
	depMap: Record<string, string[]>,
): Set<string> {
	const seen = new Set<string>(seeds);
	const queue = [...seeds];
	while (queue.length > 0) {
		const sym = queue.pop() as string;
		for (const dep of depMap[sym] ?? []) {
			if (!seen.has(dep)) {
				seen.add(dep);
				queue.push(dep);
			}
		}
	}
	return seen;
}

function intersect(a: string[], b: string[]): string[] {
	const bs = new Set(b);
	return [...new Set(a)].filter((x) => bs.has(x)).sort();
}

function union(a: string[], b: string[]): string[] {
	return [...new Set([...a, ...b])].sort();
}

/* ------------------------------------------------------------------ */
/* Pairwise classification (spec 2 §§3–4).                              */
/* ------------------------------------------------------------------ */

export interface PairInput {
	/** Optional deterministic dependency map (symbol → direct deps).
	 *  Absent → L2 analysis is unavailable → classification is at least
	 *  AMBER, never silent GREEN (spec 2 §4, §7). */
	depMap?: Record<string, string[]>;
}

/**
 * Classify the conflict between two live claims on the same task.
 * Risk ladder (spec 2 §4):
 *   BLOCKED := state ≠ ∅
 *   RED     := symbol ≠ ∅ OR contract ≠ ∅
 *   AMBER   := impact ≠ ∅ OR L2 unavailable OR either claim amended (version > 1)
 *   GREEN   := none of the above
 */
export function classifyPair(
	a: WorkClaim,
	b: WorkClaim,
	input: PairInput = {},
): ConflictReport {
	const text: string[] = [];
	for (const g of a.scope.paths) {
		for (const h of b.scope.paths) {
			if (globsOverlap(g, h)) text.push(`${g} ∩ ${h}`);
		}
	}

	const symbol = intersect(a.scope.symbols, b.scope.symbols);

	let impact: string[] = [];
	const l2Unavailable = input.depMap === undefined;
	if (!l2Unavailable) {
		const ia = dependencyClosure(a.scope.symbols, input.depMap as Record<string, string[]>);
		const ib = dependencyClosure(b.scope.symbols, input.depMap as Record<string, string[]>);
		impact = [...ia].filter((x) => ib.has(x)).sort();
	}

	// L3 contract: Writes(A) ∩ (Reads(B) ∪ Writes(B)), symmetric both ways.
	const writesA = a.contracts.modifies;
	const writesB = b.contracts.modifies;
	const contract = union(
		intersect(writesA, union(b.contracts.reads, writesB)),
		intersect(writesB, union(a.contracts.reads, writesA)),
	);

	// L3 state: collisions on schema_changes, config keys, or interfaces.
	const state = union(
		intersect(a.schema_changes, b.schema_changes),
		intersect(a.interfaces, b.interfaces),
	);

	const amended = a.version > 1 || b.version > 1;

	let risk: ConflictRisk;
	if (state.length > 0) risk = "BLOCKED";
	else if (symbol.length > 0 || contract.length > 0) risk = "RED";
	else if (impact.length > 0 || l2Unavailable || amended) risk = "AMBER";
	else risk = "GREEN";

	const layers: ConflictLayers = { text, symbol, impact, contract, state };
	return {
		claim_a: a.work_id,
		claim_b: b.work_id,
		risk,
		layers,
		explanation: explain(a, b, layers, risk, l2Unavailable, amended),
	};
}

function explain(
	a: WorkClaim,
	b: WorkClaim,
	layers: ConflictLayers,
	risk: ConflictRisk,
	l2Unavailable: boolean,
	amended: boolean,
): string {
	const parts: string[] = [];
	if (layers.state.length > 0)
		parts.push(`state collision on [${layers.state.join(", ")}]`);
	if (layers.contract.length > 0)
		parts.push(
			`contract conflict on [${layers.contract.join(", ")}]: ` +
				`one claim mutates state the other reads or mutates`,
		);
	if (layers.symbol.length > 0)
		parts.push(`symbol conflict on [${layers.symbol.join(", ")}]`);
	if (layers.impact.length > 0)
		parts.push(`shared dependency neighborhood [${layers.impact.join(", ")}]`);
	if (layers.text.length > 0)
		parts.push(`path overlap [${layers.text.join("; ")}]`);
	if (l2Unavailable)
		parts.push("L2 dependency analysis unavailable — absence of analysis is not evidence of safety");
	if (amended) parts.push("a claim was amended after registration");
	if (parts.length === 0) parts.push("no conflicts detected on any layer");
	return `${risk}: ${a.work_id} (${a.agent}) vs ${b.work_id} (${b.agent}) — ${parts.join("; ")}.`;
}

/**
 * Reconcile all live claims on a task (spec 2 §5): classify every pair
 * with status claimed|active. Called on registration, amendment, and new
 * claims; the caller notifies affected contenders on escalation.
 */
export function reconcileClaims(claims: WorkClaim[], input: PairInput = {}): ConflictReport[] {
	const live = claims.filter((c) => c.status === "claimed" || c.status === "active");
	const reports: ConflictReport[] = [];
	for (let i = 0; i < live.length; i++) {
		for (let j = i + 1; j < live.length; j++) {
			reports.push(classifyPair(live[i], live[j], input));
		}
	}
	return reports;
}
