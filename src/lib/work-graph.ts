/**
 * Live work-graph data for one task. The demo worker owns presentation.
 * This module only names the crew, its members, and the composition state
 * the authority has recorded. A promotable SHA appears only for COMPOSED
 * and RESOLVED.
 */

import type { AuthorityState, CompositionStatus, CrewContender, CrewMember } from "./types.ts";

export interface WorkGraphDependency {
	from: string;
	to: string;
	relation: "baseline" | "overlap" | "claim-conflict";
}

export interface WorkGraphOverlap {
	path: string;
	classification: string;
	agents: string[];
}

export interface WorkGraph {
	task: { task_id: string; intent: string; status: string; baseline_commit: string };
	crew: CrewContender | null;
	members: CrewMember[];
	dependencies: WorkGraphDependency[];
	overlaps: WorkGraphOverlap[];
	composition_state: CompositionStatus | null;
	/** The one SHA promotion may use. Null unless the state is COMPOSED or RESOLVED. */
	candidate_sha: string | null;
}

function promotable(status: CompositionStatus): boolean {
	return status === "COMPOSED" || status === "RESOLVED";
}

/** The parent fork plus its member agents. Null until a composition is recorded. */
export function crewContenderOf(state: AuthorityState): CrewContender | null {
	const composition = state.composition;
	if (!composition) return null;
	const contender = state.contenders[composition.contender_id];
	if (!contender) return null;
	const members: CrewMember[] = composition.agents.map((agent) => {
		const claim = agent.claim_work_id
			? state.claims.find((row) => row.work_id === agent.claim_work_id)
			: undefined;
		return {
			agent_id: agent.id,
			role: agent.role,
			intent: agent.intent,
			scope: agent.paths,
			claim_work_id: agent.claim_work_id,
			commit_sha: agent.sha.length > 0 ? agent.sha : null,
			status: claim?.status ?? (agent.sha.length > 0 ? "committed" : "pending"),
		};
	});
	return {
		contender_id: contender.contender_id,
		parent: {
			agent_id: contender.agent_id,
			authority: "parent",
			contender_id: contender.contender_id,
			fork_repo: contender.fork_repo,
		},
		members,
		baseline: composition.baseline,
		outcome: composition.status,
		candidate_sha: promotable(composition.status) ? composition.candidate_sha : null,
	};
}

/** Task, crew, members, commits, dependencies, overlaps, and composition state. */
export function buildWorkGraph(state: AuthorityState): WorkGraph {
	const crew = crewContenderOf(state);
	const composition = state.composition ?? null;
	const overlaps: WorkGraphOverlap[] = (composition?.files ?? []).map((file) => ({
		path: file.path,
		classification: file.classification,
		agents: file.sides.map((side) => side.agent_id),
	}));
	const dependencies: WorkGraphDependency[] = [];
	if (crew) {
		for (const member of crew.members) {
			if (member.commit_sha) {
				dependencies.push({ from: member.commit_sha, to: crew.baseline, relation: "baseline" });
			}
		}
	}
	for (const file of overlaps) {
		for (let i = 0; i < file.agents.length; i += 1) {
			for (let j = i + 1; j < file.agents.length; j += 1) {
				dependencies.push({ from: file.agents[i], to: file.agents[j], relation: "overlap" });
			}
		}
	}
	for (const report of state.conflict_reports ?? []) {
		dependencies.push({ from: report.claim_a, to: report.claim_b, relation: "claim-conflict" });
	}
	return {
		task: {
			task_id: state.task.task_id,
			intent: state.task.intent,
			status: state.task_status,
			baseline_commit: state.task.baseline_commit,
		},
		crew,
		members: crew?.members ?? [],
		dependencies,
		overlaps,
		composition_state: composition?.status ?? null,
		candidate_sha: composition && promotable(composition.status) ? composition.candidate_sha : null,
	};
}
