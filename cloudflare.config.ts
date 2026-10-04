import { bindings, defineConfig, defineContainer, exports, triggers } from "cf/config";
import * as entrypoint from "./src/worker/index.ts" with { type: "cf-worker" };

const promotionContainer = defineContainer({
	name: "madgrix-promotion",
	image: { dockerfile: "./container/Dockerfile" },
	instanceType: "lite",
	maxInstances: 4,
});

export default defineConfig({
	worker: {
		name: "madgrix",
		compatibilityDate: "2026-10-01",
		entrypoint,
		// The task-authority Durable Object class is exported from the
		// entrypoint module (src/worker/index.ts re-exports TaskAuthority).
		// sqlite storage: the DO runs every state transition inside a
		// storage transaction (spec 5 §4).
		exports: {
			TaskAuthority: exports.durableObject({ storage: "sqlite" }),
			PromotionContainer: exports.durableObject({ storage: "sqlite", container: promotionContainer }),
			PromotionWorkflow: exports.workflow({
				name: "madgrix-promotion",
				limits: { steps: 8 },
				defaultRetention: { successRetention: "3 days", errorRetention: "7 days" },
			}),
		},
		env: {
			// Local dev note: workerd cannot reach the remote Artifacts service
			// through this sandbox's egress proxy, so `dev: { remote: true }`
			// fails here. It works on any machine with direct egress.
			ARTIFACTS: bindings.artifacts({ namespace: "default", dev: { remote: true } }),
			// Task authority (spec 5 §4): one Durable Object per task id.
			// Self-binding: the class is defined by this same Worker.
			TASK_AUTHORITY: bindings.durableObject({ worker: "madgrix", exportName: "TaskAuthority" }),
			// Evaluation evidence is accepted only when this secret is presented
			// as a Bearer token at the Worker edge. The caller's JSON body can
			// never self-assert the evaluation-domain trust zone.
			EVALUATION_SERVICE_TOKEN: bindings.secret(),
			CONTROL_SERVICE_TOKEN: bindings.secret(),
			AGENT_SERVICE_TOKEN: bindings.secret(),
			// Ed25519 PKCS8 private key the TaskAuthority signs promotion bundles
			// with; its public key is pinned in keys/authority.pub (keys/README.md).
			AUTHORITY_SIGNING_KEY: bindings.secret(),
			PROMOTION_CONTAINER: bindings.durableObject({ worker: "madgrix", exportName: "PromotionContainer" }),
			// POST /tasks/:id/promote creates one instance per permit, with the
			// permit id as the instance id (spec 5 §5;
			// specs/amendments/promotion-runtime-v1.md).
			PROMOTION_WORKFLOW: bindings.workflow({ name: "madgrix-promotion", worker: "madgrix", exportName: "PromotionWorkflow" }),
		},
		// Queue consumer (spec 5 §2–§3): Artifact lifecycle events arrive via
		// this queue (at-least-once, unordered) and are ingested by the
		// Worker's `queue()` export → per-task DO (event_key dedupe) → effects.
		// DEPLOY NOTE: the `madgrix-events` queue must exist in the account
		// before deploy (e.g. `cf queues create madgrix-events`); a dead-letter
		// queue is recommended for poison messages (see docs/PRODUCTION_DEPLOYMENT.md).
		triggers: [triggers.queue({ name: "madgrix-events", maxBatchSize: 10, maxBatchTimeout: 30 })],
	},
	containers: [promotionContainer],
});
