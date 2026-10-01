import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";

// Worker-only project (no index.html). The cloudflare plugin reads
// cloudflare.config.ts for entrypoint, bindings, and compatibility date.
export default defineConfig({
	plugins: [cloudflare()],
});
