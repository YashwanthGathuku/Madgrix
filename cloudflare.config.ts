import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./src/worker/index.ts" with { type: "cf-worker" };

export default defineConfig({
	worker: {
		name: "seam",
		compatibilityDate: "2026-10-01",
		entrypoint,
		env: {
			// Local dev note: workerd cannot reach the remote Artifacts service
			// through this sandbox's egress proxy, so `dev: { remote: true }`
			// fails here. It works on any machine with direct egress.
			ARTIFACTS: bindings.artifacts({ namespace: "default", dev: { remote: true } }),
			// TODO (DO binding — add on a direct-egress machine where the cf
			// config API can be verified; do NOT guess the binding helper):
			// the task-authority Durable Object (TaskAuthority, exported from
			// src/worker/index.ts) needs a binding here, e.g. something like
			//   TASK_AUTHORITY: bindings.durableObject({ className: "TaskAuthority" }),
			// with the exact helper name/shape confirmed against the cf
			// package docs. The Worker code reads it structurally via
			// src/do/workers.d.ts, so only this config line is missing.
		},
	},
});
