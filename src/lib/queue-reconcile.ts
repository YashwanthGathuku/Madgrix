/**
 * Decide what the Worker may hand to TaskAuthority for one Queue push.
 *
 * Artifacts is read here, before the authoritative transition. A retry result
 * means the caller must not POST /event: the event key is still unseen, so a
 * Queue redelivery can try again. specs/amendments/queue-ancestry-reconciliation-v1.md
 */

import { lookupForwardAncestry, type AncestryProof, type CommitParents } from "./ancestry-proof.ts";
import { classifyQueuePush } from "./task-state.ts";
import type { AuthorityState, QueuePushEvent } from "./types.ts";

export type QueueIngestPlan =
	| { action: "post"; reconciliation?: AncestryProof }
	| { action: "retry"; reason: "transient" | "bound" | "missing" | "malformed" };

/**
 * Fast-path and gap events with real commit ids get an Artifacts walk.
 * Symbolic ids, unknown repos, and invalid events post unchanged, with no proof.
 * A proven forward walk is attached even when `before` is already the tip, so a
 * tip that moves before the transaction is retried instead of recorded as a
 * permanent gap. A closed refusal is attached only when `before` is the tip:
 * that is the rewind / force-push case the causal fast path would otherwise apply.
 */
export async function planQueueIngest(
	state: AuthorityState,
	event: QueuePushEvent,
	readCommit: (hash: string) => Promise<CommitParents | null>,
): Promise<QueueIngestPlan> {
	const placed = classifyQueuePush(state, event);
	if (placed.kind !== "fast" && placed.kind !== "gap") return { action: "post" };
	const lookup = await lookupForwardAncestry(event.after, placed.tip, readCommit);
	if (lookup.status === "retry") return { action: "retry", reason: lookup.reason };
	if (lookup.status === "unprovable") return { action: "post" };
	if (lookup.status === "forward") return { action: "post", reconciliation: lookup.proof };
	if (placed.kind === "fast") return { action: "post", reconciliation: lookup.proof };
	return { action: "post" };
}
