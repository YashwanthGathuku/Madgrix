import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

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
		},
	},
});
