/**
 * Idempotent promotion keys.
 *
 * Cloudflare Queues deliver at-least-once: a push event can arrive twice,
 * and a retried verdict must never promote twice. The promotion key binds
 * the exact decision inputs; the promotion store is single-consume —
 * the second attempt with the same key is a no-op, not a second merge.
 */

export async function sha256Hex(input: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * promotion_id = SHA256(task_id | baseline_commit | candidate_commit | policy_version)
 *
 * Any change to the inputs — a different candidate commit, a policy bump —
 * is a *different* promotion and must be re-verified from scratch.
 */
export function promotionId(
	taskId: string,
	baselineCommit: string,
	candidateCommit: string,
	policyVersion: string,
): Promise<string> {
	return sha256Hex([taskId, baselineCommit, candidateCommit, policyVersion].join("|"));
}
