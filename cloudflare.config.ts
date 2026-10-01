import { bindings, defineConfig, exports, triggers } from "cf/config";
import * as entrypoint from "./src/worker/index.ts" with { type: "cf-worker" };

export default defineConfig({
	worker: {
		name: "seam",
		compatibilityDate: "2026-10-01",
		entrypoint,
		// The task-authority Durable Object class is exported from the
		// entrypoint module (src/worker/index.ts re-exports TaskAuthority).
		// sqlite storage: the DO runs every state transition inside a
		// storage transaction (spec 5 §4).
		exports: {
			TaskAuthority: exports.durableObject({ storage: "sqlite" }),
		},
		env: {
			// Local dev note: workerd cannot reach the remote Artifacts service
			// through this sandbox's egress proxy, so `dev: { remote: true }`
			// fails here. It works on any machine with direct egress.
			ARTIFACTS: bindings.artifacts({ namespace: "default", dev: { remote: true } }),
			// Task authority (spec 5 §4): one Durable Object per task id.
			// Self-binding: the class is defined by this same Worker.
			TASK_AUTHORITY: bindings.durableObject({ worker: "seam", exportName: "TaskAuthority" }),
		},
		// Queue consumer (spec 5 §2–§3): Artifact lifecycle events arrive via
		// this queue (at-least-once, unordered) and are ingested by the
		// Worker's `queue()` export → per-task DO (event_key dedupe) → effects.
		// DEPLOY NOTE: the `seam-events` queue must exist in the account
		// before deploy (e.g. `cf queues create seam-events`); a dead-letter
		// queue is recommended for poison messages (see docs/PRODUCTION_DEPLOYMENT.md).
		triggers: [triggers.queue({ name: "seam-events", maxBatchSize: 10, maxBatchTimeout: 30 })],
	},
});
