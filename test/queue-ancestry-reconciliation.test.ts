/**
 * Forward-only ancestry for a Queue push that skipped its causal predecessor.
 * The live 2026-10-14 failure is the first case: tip B, missing B→C1, delivered C1→C2.
 *
 * node --test test/queue-ancestry-reconciliation.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { lookupForwardAncestry, validateAncestryProof, type AncestryProof } from "../src/lib/ancestry-proof.ts";
import { canonicalJson, sha256Hex } from "../src/lib/canonical.ts";
import { planQueueIngest } from "../src/lib/queue-reconcile.ts";
import { createAuthority, ingestQueueEvent, type Ctx } from "../src/lib/task-state.ts";
import type { AuthorityState, ContenderRecord, QueuePushEvent } from "../src/lib/types.ts";
import { worker } from "./helpers/worker-harness.ts";

const B = "b".repeat(40);
const C1 = "1".repeat(40);
const C2 = "2".repeat(40);
const C = "c".repeat(40);
const D = "d".repeat(40);
const A = "a".repeat(40);
const X = "4".repeat(40);
const M = "5".repeat(40);
const REPO = "mgx-task_048aca8851f9e0db31e0f3-91f65b8a6d4d";

function makeCtx(): Ctx {
	return {
		now: () => "2026-10-14T01:39:47.228Z",
		randomHex: (n: number) => "e".repeat(n * 2),
		sha256Hex,
		selectorPolicyHash: "policyhash",
		policyVersion: "seam-policy/0.1.0",
	};
}

function stateAt(tip: string | null): AuthorityState {
	const state = createAuthority({
		task_id: "task_048aca8851f9e0db31e0f391",
		task_hash: "task-hash",
		intent: "marker",
		baseline_repo: "starter-repo",
		baseline_commit: B,
		behavior_contract: "marker exists",
		policy_version: "seam-policy/0.1.0",
		frozen_at: "2026-10-14T01:37:47.351Z",
	});
	const contender: ContenderRecord = {
		contender_id: "agent-02-contender",
		agent_id: "agent-02",
		fork_repo: REPO,
		fork_lineage: { parent_repo: "starter-repo", parent_commit: B },
		fork_base: B,
		token_id: "tok",
		status: "forked",
		claim_work_id: null,
		latest_commit: tip,
	};
	return { ...state, contenders: { [contender.contender_id]: contender } };
}

function push(before: string, after: string): QueuePushEvent {
	return { namespace: "default", repo: REPO, ref: "refs/heads/main", before, after };
}

function commits(edges: Record<string, string[]>) {
	return async (hash: string) => (hash in edges ? { hash, parents: edges[hash] } : null);
}

const liveGraph = commits({ [C1]: [B], [C2]: [C1] });

describe("forward ancestry reconciliation", () => {
	it("reproduces the live gap, then advances only when C2 descends from the tip", async () => {
		const ctx = makeCtx();
		const start = stateAt(B);
		const withoutProof = await ingestQueueEvent(start, push(C1, C2), ctx);
		assert.equal(withoutProof.outcome, "REQUIRES_RECONCILIATION");
		assert.equal(withoutProof.state.contenders["agent-02-contender"].latest_commit, B);
		assert.equal(withoutProof.state.ledger.at(-1)?.kind, "queue_event_requires_reconciliation");

		const lookup = await lookupForwardAncestry(C2, B, liveGraph);
		assert.equal(lookup.status, "forward");
		if (lookup.status !== "forward") return;
		const repaired = await ingestQueueEvent(stateAt(B), push(C1, C2), ctx, { reconciliation: lookup.proof });
		assert.equal(repaired.outcome, "RECONCILED_NEW");
		assert.equal(repaired.state.contenders["agent-02-contender"].latest_commit, C2);
		const reconciled = repaired.state.ledger.filter((entry) => entry.kind === "queue_event_reconciled");
		assert.equal(reconciled.length, 1);
		const proofDigest = await sha256Hex(canonicalJson(lookup.proof));
		assert.equal(
			reconciled[0].payload_hash,
			await sha256Hex(
				canonicalJson({
					event_key: repaired.event_key,
					contender_id: "agent-02-contender",
					repo: REPO,
					ref: "refs/heads/main",
					observed_tip: B,
					before: C1,
					after: C2,
					proof_digest: proofDigest,
					proof_path_length: lookup.proof.path.length,
				}),
			),
		);
		assert.equal(repaired.state.ledger.some((entry) => entry.kind === "queue_event_applied"), false);
	});

	it("a premature reconciliation record strands a later proof as ACK_DUP", async () => {
		const ctx = makeCtx();
		const first = await ingestQueueEvent(stateAt(B), push(C1, C2), ctx);
		const lookup = await lookupForwardAncestry(C2, B, liveGraph);
		assert.equal(lookup.status, "forward");
		if (lookup.status !== "forward") return;
		const second = await ingestQueueEvent(first.state, push(C1, C2), ctx, { reconciliation: lookup.proof });
		assert.equal(second.outcome, "ACK_DUP");
		assert.equal(second.state, first.state);
		assert.equal(second.state.contenders["agent-02-contender"].latest_commit, B);
	});

	it("does not move a newer tip back to an older commit", async () => {
		const ctx = makeCtx();
		const start = stateAt(C2);
		const lookup = await lookupForwardAncestry(C1, C2, commits({ [C1]: [B], [B]: [] }));
		assert.equal(lookup.status, "closed_refusal");
		const stale = await ingestQueueEvent(start, push(B, C1), ctx);
		assert.equal(stale.outcome, "REQUIRES_RECONCILIATION");
		assert.equal(stale.state.contenders["agent-02-contender"].latest_commit, C2);
	});

	it("does not treat a sibling as forward progress", async () => {
		const ctx = makeCtx();
		const graph = commits({ [C]: [B], [D]: [B], [B]: [] });
		const lookup = await lookupForwardAncestry(D, C, graph);
		assert.equal(lookup.status, "closed_refusal");
		const diverged = await ingestQueueEvent(stateAt(C), push(B, D), ctx);
		assert.equal(diverged.outcome, "REQUIRES_RECONCILIATION");
		assert.equal(diverged.state.contenders["agent-02-contender"].latest_commit, C);
		const forced = await planQueueIngest(stateAt(C), push(C, D), graph);
		assert.equal(forced.action, "post");
		if (forced.action !== "post") return;
		assert.equal(forced.reconciliation?.relation, "closed_refusal");
		const refused = await ingestQueueEvent(stateAt(C), push(C, D), ctx, { reconciliation: forced.reconciliation });
		assert.equal(refused.outcome, "REQUIRES_RECONCILIATION");
		assert.equal(refused.state.contenders["agent-02-contender"].latest_commit, C);
	});

	it("does not follow a ref rewind from C back to B", async () => {
		const ctx = makeCtx();
		const graph = commits({ [C]: [B], [B]: [] });
		const plan = await planQueueIngest(stateAt(C), push(C, B), graph);
		assert.equal(plan.action, "post");
		if (plan.action !== "post") return;
		assert.equal(plan.reconciliation?.relation, "closed_refusal");
		const rewound = await ingestQueueEvent(stateAt(C), push(C, B), ctx, { reconciliation: plan.reconciliation });
		assert.equal(rewound.outcome, "REQUIRES_RECONCILIATION");
		assert.equal(rewound.state.contenders["agent-02-contender"].latest_commit, C);
	});

	it("follows a merge through a non-first parent", async () => {
		const ctx = makeCtx();
		const graph = commits({ [M]: [A, X], [A]: [B], [X]: [B], [B]: [] });
		const lookup = await lookupForwardAncestry(M, X, graph);
		assert.equal(lookup.status, "forward");
		if (lookup.status !== "forward") return;
		assert.equal(lookup.proof.path.find((edge) => edge.hash === M)?.parents[0], A);
		assert.equal(lookup.proof.path.find((edge) => edge.hash === M)?.parents[1], X);
		const merged = await ingestQueueEvent(stateAt(X), push(A, M), ctx, { reconciliation: lookup.proof });
		assert.equal(merged.outcome, "RECONCILED_NEW");
		assert.equal(merged.state.contenders["agent-02-contender"].latest_commit, M);
	});

	it("acks a second delivery of the same reconciled event without a second ledger entry", async () => {
		const ctx = makeCtx();
		const lookup = await lookupForwardAncestry(C2, B, liveGraph);
		assert.equal(lookup.status, "forward");
		if (lookup.status !== "forward") return;
		const first = await ingestQueueEvent(stateAt(B), push(C1, C2), ctx, { reconciliation: lookup.proof });
		const second = await ingestQueueEvent(first.state, push(C1, C2), ctx, { reconciliation: lookup.proof });
		assert.equal(first.outcome, "RECONCILED_NEW");
		assert.equal(second.outcome, "ACK_DUP");
		assert.equal(second.state, first.state);
		assert.equal(second.state.ledger.filter((entry) => entry.kind === "queue_event_reconciled").length, 1);
		assert.equal(second.state.seen_event_keys.length, 1);
	});

	it("leaves the event unseen when Artifacts cannot be read", async () => {
		const start = stateAt(B);
		let reads = 0;
		const plan = await planQueueIngest(start, push(C1, C2), async () => {
			reads += 1;
			throw new Error("artifacts: connection reset");
		});
		assert.equal(plan.action, "retry");
		if (plan.action !== "retry") return;
		assert.equal(plan.reason, "transient");
		assert.equal(reads, 1);
		assert.equal(start.seen_event_keys.length, 0);
		const missing = await planQueueIngest(start, push(C1, C2), async () => null);
		assert.deepEqual(missing, { action: "retry", reason: "missing" });
		assert.equal(start.seen_event_keys.length, 0);
	});

	it("does not apply a proof built for a tip that is no longer current", async () => {
		const ctx = makeCtx();
		const lookup = await lookupForwardAncestry(D, B, commits({ [D]: [B] }));
		assert.equal(lookup.status, "forward");
		if (lookup.status !== "forward") return;
		const moved = stateAt(C);
		const stale = await ingestQueueEvent(moved, push(B, D), ctx, { reconciliation: lookup.proof });
		assert.equal(stale.outcome, "RETRY_RECONCILIATION");
		assert.equal(stale.state, moved);
		assert.equal(stale.state.seen_event_keys.length, 0);
		assert.equal(stale.state.contenders["agent-02-contender"].latest_commit, C);
		assert.equal(stale.state.ledger.some((entry) => entry.kind === "queue_event_reconciled"), false);
	});

	it("retries instead of guessing when the cone exceeds 256 commits", async () => {
		const edges: Record<string, string[]> = {};
		const id = (n: number) => n.toString(16).padStart(40, "0");
		for (let n = 1; n <= 257; n++) edges[id(n)] = [id(n - 1)];
		const lookup = await lookupForwardAncestry(id(257), id(0), commits(edges));
		assert.deepEqual(lookup, { status: "retry", reason: "bound" });
	});

	it("rejects a cyclic or reversed proof without recording the event", async () => {
		const ctx = makeCtx();
		const start = stateAt(C);
		const reversed: AncestryProof = {
			observed_tip: C,
			target_after: B,
			path: [{ hash: B, parents: [] }],
			source: "artifacts.readCommit",
			relation: "forward",
		};
		assert.equal(validateAncestryProof(reversed).ok, false);
		const refused = await ingestQueueEvent(start, push(C, B), ctx, { reconciliation: reversed });
		assert.equal(refused.outcome, "RETRY_RECONCILIATION");
		assert.equal(refused.state, start);
		assert.equal(refused.state.contenders["agent-02-contender"].latest_commit, C);
	});
});

describe("the queue consumer proves ancestry before the authority transition", () => {
	it("does not POST /event when readCommit fails", async () => {
		const posts: string[] = [];
		await assert.rejects(
			worker.queue(
				{ messages: [{ body: { task_id: "task_048aca8851f9e0db31e0f391", event: push(C1, C2) } }] },
				{
					TASK_AUTHORITY: {
						idFromName: (name: string) => ({ toString: () => name }),
						get: () => ({
							fetch: async (request: Request) => {
								if (request.method === "GET") {
									return new Response(JSON.stringify(stateAt(B)), {
										status: 200,
										headers: { "content-type": "application/json" },
									});
								}
								posts.push(new URL(request.url).pathname);
								return new Response(JSON.stringify({ outcome: "RECONCILED_NEW", effects: [] }), {
									status: 200,
									headers: { "content-type": "application/json" },
								});
							},
						}),
					},
					ARTIFACTS: {
						get: async () => ({
							info: async () => ({ name: REPO, remote: "r", defaultBranch: "main" }),
							readCommit: async () => {
								throw new Error("artifacts: connection reset");
							},
						}),
					},
					PROMOTION_WORKFLOW: {},
				} as never,
			),
			/ancestry transient/,
		);
		assert.deepEqual(posts, []);
	});

	it("attaches the forward proof for the live C1 to C2 gap", async () => {
		let posted: unknown = null;
		await worker.queue(
			{ messages: [{ body: { task_id: "task_048aca8851f9e0db31e0f391", event: push(C1, C2) } }] },
			{
				TASK_AUTHORITY: {
					idFromName: (name: string) => ({ toString: () => name }),
					get: () => ({
						fetch: async (request: Request) => {
							if (request.method === "GET") {
								return new Response(JSON.stringify(stateAt(B)), {
									status: 200,
									headers: { "content-type": "application/json" },
								});
							}
							posted = await request.json();
							return new Response(JSON.stringify({ outcome: "RECONCILED_NEW", effects: [] }), {
								status: 200,
								headers: { "content-type": "application/json" },
							});
						},
					}),
				},
				ARTIFACTS: {
					get: async () => ({
						info: async () => ({ name: REPO, remote: "r", defaultBranch: "main" }),
						readCommit: async (hash: string) => {
							const parents = hash === C2 ? [C1] : hash === C1 ? [B] : null;
							if (parents === null) return null;
							return { hash, treeHash: "t".repeat(40), parents, message: "contender" };
						},
					}),
				},
				PROMOTION_WORKFLOW: {},
			} as never,
		);
		const body = posted as { event: QueuePushEvent; reconciliation: AncestryProof };
		assert.equal(body.event.after, C2);
		assert.equal(body.reconciliation.relation, "forward");
		assert.equal(body.reconciliation.observed_tip, B);
		assert.equal(body.reconciliation.target_after, C2);
		assert.equal(validateAncestryProof(body.reconciliation).ok, true);
	});
});
