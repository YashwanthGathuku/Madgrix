import type { QueuePushEvent } from "./types.ts";

const TASK_ID_RE = /^task_[0-9a-f]{24}$/;
const FORK_OP_RE = /^[0-9a-f]{64}$/;
const CONTENDER_REPO_RE = /^mgx-(task_[0-9a-f]{24})-([0-9a-f]{12})$/;

/**
 * Contender repositories carry only the opaque task id plus a truncated
 * idempotent fork-operation digest. This lets an official Artifacts push event
 * route to the correct per-task Durable Object without a mutable global
 * repo→task registry.
 */
export function contenderRepoName(taskId: string, forkOpId: string): string {
	if (!TASK_ID_RE.test(taskId)) throw new Error("invalid task id for contender repo");
	if (!FORK_OP_RE.test(forkOpId)) throw new Error("invalid fork operation id");
	return `mgx-${taskId}-${forkOpId.slice(0, 12)}`;
}

export function taskIdFromContenderRepo(repo: string): string | null {
	const m = CONTENDER_REPO_RE.exec(repo);
	return m?.[1] ?? null;
}

export interface RoutedPushEvent {
	task_id: string;
	event: QueuePushEvent;
}

/**
 * Accept both:
 *  - the official Cloudflare Event Subscription envelope, and
 *  - MADGRIX's internal routed envelope used by deterministic tests.
 *
 * Other event types return null so a queue accidentally subscribed to a wider
 * Artifacts event set does not poison/retry forever.
 */
export function normalizeArtifactQueueBody(body: unknown): RoutedPushEvent | null {
	if (!body || typeof body !== "object") return null;
	const b = body as Record<string, unknown>;

	// Internal/test envelope.
	if (typeof b.task_id === "string" && b.event && typeof b.event === "object") {
		const e = b.event as Record<string, unknown>;
		if (
			typeof e.namespace === "string" &&
			typeof e.repo === "string" &&
			typeof e.ref === "string" &&
			typeof e.before === "string" &&
			typeof e.after === "string"
		) {
			return {
				task_id: b.task_id,
				event: {
					namespace: e.namespace,
					repo: e.repo,
					ref: e.ref,
					before: e.before,
					after: e.after,
				},
			};
		}
		return null;
	}

	if (b.type !== "cf.artifacts.repo.pushed") return null;
	const source = b.source as Record<string, unknown> | undefined;
	const payload = b.payload as Record<string, unknown> | undefined;
	if (
		!source ||
		source.type !== "artifacts.repo" ||
		typeof source.namespace !== "string" ||
		typeof source.repoName !== "string" ||
		!payload ||
		typeof payload.ref !== "string" ||
		typeof payload.before !== "string" ||
		typeof payload.after !== "string"
	) {
		return null;
	}
	const task_id = taskIdFromContenderRepo(source.repoName);
	if (task_id === null) {
		// Pushes from baseline/canonical/unrelated repositories may share the
		// namespace. They are intentionally outside contender task routing.
		return null;
	}
	return {
		task_id,
		event: {
			namespace: source.namespace,
			repo: source.repoName,
			ref: payload.ref,
			before: payload.before,
			after: payload.after,
		},
	};
}
