/**
 * Causal Proof Graph — content-addressed explanation of why a SHA was allowed
 * to become canonical.
 *
 * Git gives ancestry. This graph gives authority causality: task intent → work
 * claims → composition → evaluation → verdict → CanonCap → promotion proof.
 * It is a read-only projection over TaskAuthority state; it never decides
 * eligibility and never contains credentials, secrets or free-text verifier
 * reasoning.
 */

import { canonicalJson, sha256Hex as defaultSha256Hex } from "./canonical.ts";
import { canonCapFromPermit } from "./canoncap.ts";
import type { AuthorityState, PermitRecord } from "./types.ts";

export const CAUSAL_PROOF_VERSION = "madgrix-causal-proof/v1";

export type CausalNodeType =
	| "task"
	| "claim"
	| "composition"
	| "evaluation"
	| "verdict"
	| "canoncap"
	| "promotion"
	| "canonical";

export interface CausalProofNode {
	id: string;
	type: CausalNodeType;
	label: string;
	digest: string;
	data: Record<string, unknown>;
}

export interface CausalProofEdge {
	from: string;
	to: string;
	relation: string;
}

export interface CausalProofGraph {
	format: typeof CAUSAL_PROOF_VERSION;
	task_id: string;
	target_sha: string;
	causal_root: string;
	nodes: CausalProofNode[];
	edges: CausalProofEdge[];
}

async function node(
	type: CausalNodeType,
	label: string,
	data: Record<string, unknown>,
	sha256Hex: (input: string | Uint8Array) => Promise<string>,
): Promise<CausalProofNode> {
	const digest = await sha256Hex(canonicalJson({ type, data }));
	return { id: `${type}:${digest.slice(0, 16)}`, type, label, digest, data };
}

function publicClaim(claim: AuthorityState["claims"][number]) {
	return {
		work_id: claim.work_id,
		agent: claim.agent,
		baseline: claim.baseline,
		intent: claim.intent,
		scope: claim.scope,
		contracts: claim.contracts,
		interfaces: claim.interfaces,
		schema_changes: claim.schema_changes,
		expected_tests: claim.expected_tests,
		status: claim.status,
		version: claim.version,
	};
}

function permitForTarget(state: AuthorityState, targetSha: string): PermitRecord | null {
	for (const permit of Object.values(state.permits)) {
		if (permit.winner_candidate_sha === targetSha) return permit;
	}
	return null;
}

/** Build a proof graph for a candidate/canonical SHA already known to the authority. */
export async function buildCausalProofGraph(
	state: AuthorityState,
	targetSha: string,
	sha256Hex: (input: string | Uint8Array) => Promise<string> = defaultSha256Hex,
): Promise<CausalProofGraph> {
	const evaluation = state.evaluations[targetSha];
	const verdict = [...state.verdicts].reverse().find((v) => v.winner_sha === targetSha) ?? null;
	const permit = permitForTarget(state, targetSha);
	const promotion = permit ? state.promotion_bundles?.[permit.permit_id] ?? null : null;
	const composition = state.composition?.candidate_sha === targetSha ? state.composition : null;
	if (!evaluation && !verdict && !permit && !promotion && !composition) {
		throw new Error(`causal proof: ${targetSha} is not known as a governed candidate`);
	}

	const nodes: CausalProofNode[] = [];
	const edges: CausalProofEdge[] = [];
	const taskNode = await node(
		"task",
		"Frozen task intent",
		{
			task_id: state.task.task_id,
			task_hash: state.task.task_hash,
			intent: state.task.intent,
			baseline_repo: state.task.baseline_repo,
			baseline_commit: state.task.baseline_commit,
			policy_version: state.task.policy_version,
		},
		sha256Hex,
	);
	nodes.push(taskNode);

	const claimNodes = new Map<string, CausalProofNode>();
	for (const claim of state.claims) {
		const n = await node("claim", `WorkClaim ${claim.work_id}`, publicClaim(claim), sha256Hex);
		claimNodes.set(claim.work_id, n);
		nodes.push(n);
		edges.push({ from: taskNode.id, to: n.id, relation: "declares" });
	}

	let previous: CausalProofNode = taskNode;
	if (composition) {
		const compositionNode = await node(
			"composition",
			`Composition ${composition.status}`,
			{
				status: composition.status,
				contender_id: composition.contender_id,
				baseline: composition.baseline,
				contributing_shas: composition.contributing_shas,
				candidate_sha: composition.candidate_sha,
				files: composition.files.map((f) => ({ path: f.path, classification: f.classification })),
				...(composition.capsule_id ? { capsule_id: composition.capsule_id } : {}),
				...(composition.resolution
					? {
							resolution: {
								rung: composition.resolution.rung,
								resolver_id: composition.resolution.resolver_id,
								order_agreement: composition.resolution.order_agreement ?? null,
								witness_verdict: composition.resolution.witness.verdict,
								review_cleared_by: composition.resolution.witness.review_cleared_by ?? null,
							},
						}
					: {}),
				...(composition.witness_check ? { witness_verdict: composition.witness_check.verdict } : {}),
			},
			sha256Hex,
		);
		nodes.push(compositionNode);
		for (const agent of composition.agents) {
			const claimNode = agent.claim_work_id ? claimNodes.get(agent.claim_work_id) : undefined;
			if (claimNode) edges.push({ from: claimNode.id, to: compositionNode.id, relation: "contributes" });
		}
		if (!composition.agents.some((a) => a.claim_work_id && claimNodes.has(a.claim_work_id))) {
			edges.push({ from: taskNode.id, to: compositionNode.id, relation: "composes" });
		}
		previous = compositionNode;
	}

	if (evaluation) {
		const evaluationNode = await node(
			"evaluation",
			"Independent evaluation",
			{
				candidate_sha: evaluation.candidate_sha,
				tree_sha256: evaluation.tree_sha256,
				contender_id: evaluation.contender_id,
				bundle_hash: evaluation.bundle_hash,
				admission: evaluation.admission,
				tainted: evaluation.tainted,
				evaluation_base: evaluation.evaluation_base ?? null,
				evaluation_config_sha256: evaluation.evaluation_config_sha256 ?? null,
			},
			sha256Hex,
		);
		nodes.push(evaluationNode);
		edges.push({ from: previous.id, to: evaluationNode.id, relation: "evaluated-as" });
		previous = evaluationNode;
	}

	if (verdict) {
		const verdictNode = await node(
			"verdict",
			`Verdict ${verdict.state}`,
			{
				state: verdict.state,
				candidate_shas: verdict.candidate_shas,
				evidence_hashes: verdict.evidence_hashes,
				policy_hash: verdict.policy_hash,
				selector_policy_version: verdict.selector_policy_version,
				winner_sha: verdict.winner_sha,
			},
			sha256Hex,
		);
		nodes.push(verdictNode);
		edges.push({ from: previous.id, to: verdictNode.id, relation: "supports-verdict" });
		previous = verdictNode;
	}

	if (permit) {
		const cap = await canonCapFromPermit(permit, sha256Hex);
		const capNode = await node(
			"canoncap",
			`CanonCap ${cap.status}`,
			{
				canoncap_id: cap.canoncap_id,
				permit_id: cap.permit_id,
				bindings: cap.bindings,
				single_use: cap.single_use,
				status: cap.status,
				issued_at: cap.issued_at,
				consumed_at: cap.consumed_at,
			},
			sha256Hex,
		);
		nodes.push(capNode);
		edges.push({ from: previous.id, to: capNode.id, relation: "authorizes-canonicalization" });
		previous = capNode;
	}

	if (promotion && permit) {
		const promotionNode = await node(
			"promotion",
			"Signed promotion proof",
			{
				permit_id: permit.permit_id,
				candidate_sha: permit.winner_candidate_sha,
				destination_repo: permit.destination_repo,
				bundle_version: promotion.version,
				statements: promotion.statements.length,
			},
			sha256Hex,
		);
		nodes.push(promotionNode);
		edges.push({ from: previous.id, to: promotionNode.id, relation: "consumed-by" });
		previous = promotionNode;
	}

	const canonicalNode = await node(
		"canonical",
		"Canonical Git state",
		{ sha: targetSha, destination_repo: permit?.destination_repo ?? null },
		sha256Hex,
	);
	nodes.push(canonicalNode);
	edges.push({ from: previous.id, to: canonicalNode.id, relation: "ships-exact-state" });

	const stableNodes = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
	const stableEdges = [...edges].sort((a, b) => `${a.from}\0${a.to}\0${a.relation}`.localeCompare(`${b.from}\0${b.to}\0${b.relation}`));
	const causal_root = await sha256Hex(
		canonicalJson({ format: CAUSAL_PROOF_VERSION, task_id: state.task.task_id, target_sha: targetSha, nodes: stableNodes, edges: stableEdges }),
	);
	return { format: CAUSAL_PROOF_VERSION, task_id: state.task.task_id, target_sha: targetSha, causal_root, nodes: stableNodes, edges: stableEdges };
}
