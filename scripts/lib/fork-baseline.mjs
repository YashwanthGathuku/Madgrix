/**
 * A contender fork must start at the frozen task baseline.
 *
 * Artifacts forks copy the source repository's CURRENT main. When the
 * baseline repository's main has moved past MADGRIX_BASELINE_COMMIT (an
 * earlier run promoted into it, for instance), the fork's main is not the
 * baseline. The task authority records fork_base = baseline, so the first
 * push event's `before` (the fork's real main) is not the observed tip and
 * every push is REQUIRES_RECONCILIATION: never applied. Fail fast instead.
 */
import { spawnSync } from "node:child_process";

/**
 * @param {string} dir   a clone of the fork
 * @param {string} baseline   the task's frozen baseline commit
 * @param {Record<string, string>} env
 */
export function assertForkAtBaseline(dir, baseline, env) {
	const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, env, encoding: "utf8" });
	if (r.status !== 0) throw new Error(`cannot read the fork's HEAD: ${r.stderr.trim()}`);
	const head = r.stdout.trim();
	if (head !== baseline) {
		throw new Error(
			`fork main is ${head.slice(0, 12)}, not the frozen baseline ${baseline.slice(0, 12)}: the baseline ` +
				"repository's main has moved. Set MADGRIX_BASELINE_COMMIT to the baseline repository's current main " +
				"(push events would otherwise all need reconciliation and never apply).",
		);
	}
	return head;
}
