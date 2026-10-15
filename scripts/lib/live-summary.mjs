/**
 * Pure helpers for the live-e2e log and summary (scripts/live-e2e.ts).
 * Kept separate so the counts and the TheUstad line are unit-tested.
 */

/**
 * Agent counts for the run. A fork crew is ONE contender (one combined SHA)
 * run by a parent plus its sub-agents; a sibling race is N contenders, one
 * agent each.
 *
 * @param {boolean} forkCrew
 * @param {{ candidates?: unknown[], subagent_commits?: unknown[] }} run
 * @returns {{ concurrent_agents: number, contenders: number, sub_agents: number, parent_agents: number }}
 */
export function agentCounts(forkCrew, run) {
	const contenders = Array.isArray(run.candidates) ? run.candidates.length : 0;
	const subAgents = forkCrew && Array.isArray(run.subagent_commits) ? run.subagent_commits.length : 0;
	const parents = forkCrew ? contenders : 0;
	return {
		concurrent_agents: forkCrew ? parents + subAgents : contenders,
		contenders,
		sub_agents: subAgents,
		parent_agents: parents,
	};
}

/**
 * TheUstad's verdict for the live log. Only the fork crew runs the gate.
 *
 * @param {boolean} forkCrew
 * @param {{ theustad?: { final?: string } | null }} run
 * @returns {string}
 */
export function theustadVerdict(forkCrew, run) {
	if (!forkCrew) return "not run (sibling contenders; TheUstad gates the fork-crew combined commit)";
	const final = run.theustad?.final;
	return typeof final === "string" && /^FINAL \S+$/.test(final) ? final : "UNKNOWN (runner reported no FINAL line)";
}
