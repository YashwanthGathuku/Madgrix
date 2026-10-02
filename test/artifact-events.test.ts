import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	contenderRepoName,
	normalizeArtifactQueueBody,
	taskIdFromContenderRepo,
} from "../src/lib/artifact-events.ts";

describe("real Artifacts event routing", () => {
	const task = "task_0123456789abcdef01234567";
	const forkOp = "a".repeat(64);
	const repo = contenderRepoName(task, forkOp);

	it("embeds and recovers the opaque task id from contender repo names", () => {
		assert.equal(repo, `mgx-${task}-aaaaaaaaaaaa`);
		assert.equal(taskIdFromContenderRepo(repo), task);
		assert.equal(taskIdFromContenderRepo("starter-repo"), null);
	});

	it("normalizes the official cf.artifacts.repo.pushed envelope", () => {
		assert.deepEqual(
			normalizeArtifactQueueBody({
				type: "cf.artifacts.repo.pushed",
				source: { type: "artifacts.repo", namespace: "default", repoName: repo },
				payload: {
					ref: "refs/heads/main",
					before: "1".repeat(40),
					after: "2".repeat(40),
					commits: [],
				},
				metadata: { eventTimestamp: "2026-10-01T00:00:00Z" },
			}),
			{
				task_id: task,
				event: {
					namespace: "default",
					repo,
					ref: "refs/heads/main",
					before: "1".repeat(40),
					after: "2".repeat(40),
				},
			},
		);
	});

	it("ignores pushes to unrelated repositories and unrelated event types", () => {
		assert.equal(
			normalizeArtifactQueueBody({
				type: "cf.artifacts.repo.pushed",
				source: { type: "artifacts.repo", namespace: "default", repoName: "canonical" },
				payload: { ref: "refs/heads/main", before: "a", after: "b" },
			}),
			null,
		);
		assert.equal(
			normalizeArtifactQueueBody({
				type: "cf.artifacts.repo.token.created",
				source: { type: "artifacts.repo", namespace: "default", repoName: repo },
				payload: {},
			}),
			null,
		);
	});

	it("keeps the internal deterministic-test envelope compatible", () => {
		assert.deepEqual(
			normalizeArtifactQueueBody({
				task_id: task,
				event: { namespace: "default", repo, ref: "refs/heads/main", before: "x", after: "y" },
			}),
			{
				task_id: task,
				event: { namespace: "default", repo, ref: "refs/heads/main", before: "x", after: "y" },
			},
		);
	});
});
