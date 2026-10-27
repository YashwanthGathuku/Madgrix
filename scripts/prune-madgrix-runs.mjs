#!/usr/bin/env node
/**
 * Delete refs/madgrix/runs/* left by crews that did not publish (kept for
 * forensics). Local git only.
 *
 *   npm run prune:runs -- <repo> [--older-than-days N] [--dry-run]
 */
import { pruneRunRefs } from "./lib/fork-crew.mjs";
import { safeGit } from "./lib/safe-git.mjs";

const args = process.argv.slice(2);
const repo = args.find((a) => !a.startsWith("--"));
const daysAt = args.indexOf("--older-than-days");
const days = daysAt === -1 ? 0 : Number(args[daysAt + 1]);
if (!repo || !Number.isFinite(days) || days < 0) {
	console.error("usage: prune-madgrix-runs <repo> [--older-than-days N] [--dry-run]");
	process.exit(2);
}
if (args.includes("--dry-run")) {
	console.log(safeGit(repo, ["for-each-ref", "--format=%(refname)", "refs/madgrix/runs/"]).stdout.trim() || "(no run refs)");
	process.exit(0);
}
const pruned = pruneRunRefs(repo, { olderThanMs: days * 86_400_000 });
console.log(`pruned ${pruned.length} run ref(s)`);
