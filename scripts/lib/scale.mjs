/**
 * Pure helpers for scripts/scale-agents.mjs (tested in test/scale-agents.test.ts).
 */

/** Agent plan: each agent gets a distinct path; every `overlapEvery`-th agent
 *  ALSO claims the previous agent's path, seeding a known path overlap. */
/** @param {number} n @param {{overlapEvery?: number, prefix?: string}} [opts] @returns {{id: string, paths: string[], overlapsWith: string | null}[]} */
export function planAgents(n, { overlapEvery = 20, prefix = "scale" } = {}) {
	/** @type {{id: string, paths: string[], overlapsWith: string | null}[]} */
	const agents = [];
	for (let i = 0; i < n; i++) {
		const id = `${prefix}-a${String(i).padStart(5, "0")}`;
		const paths = [`agents/a${i}/**`];
		let overlapsWith = null;
		if (overlapEvery > 0 && i > 0 && i % overlapEvery === 0) {
			paths.push(`agents/a${i - 1}/**`);
			overlapsWith = `${prefix}-a${String(i - 1).padStart(5, "0")}`;
		}
		agents.push({ id, paths, overlapsWith });
	}
	return agents;
}

/** @param {{id: string, paths: string[]}} agent @param {{task_hash: string, baseline_commit: string}} task */
export function claimBody(agent, task) {
	const now = Date.now();
	return {
		agent: agent.id,
		task: task.task_hash,
		baseline: task.baseline_commit,
		intent: { behavior: [`scale agent ${agent.id}: edit ${agent.paths[0]}`] },
		scope: { paths: agent.paths, symbols: [] },
		contracts: { reads: [], modifies: [] },
		interfaces: [],
		schema_changes: [],
		expected_tests: [],
		lease: { claimed_at: new Date(now).toISOString(), expires_at: new Date(now + 3600_000).toISOString() },
	};
}

/** @param {number[]} values @param {number} p @returns {number | null} */
export function percentile(values, p) {
	if (values.length === 0) return null;
	const s = [...values].sort((a, b) => a - b);
	const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
	return s[idx];
}

/** Did a claim response flag a path overlap with the given work_id? */
/** @param {{with?: string, explanation?: string}[] | undefined} conflicts @param {string | undefined} otherWorkId */
export function flaggedPathOverlap(conflicts, otherWorkId) {
	return (conflicts ?? []).some((c) => c.with === otherWorkId && /path overlap/.test(c.explanation ?? ""));
}

/** Count path-overlap flags in a response that point at a work_id NOT seeded as overlapping (false positives). */
/** @param {{with?: string, explanation?: string}[] | undefined} conflicts @param {string | null | undefined} expectedWorkId */
export function falseOverlapFlags(conflicts, expectedWorkId) {
	return (conflicts ?? []).filter((c) => /path overlap/.test(c.explanation ?? "") && c.with !== expectedWorkId).length;
}

/** @template T, R @param {T[]} items @param {number} concurrency @param {(item: T, i: number) => Promise<R>} fn @returns {Promise<R[]>} */
export async function pool(items, concurrency, fn) {
	/** @type {R[]} */
	const out = new Array(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
		for (;;) {
			const i = next++;
			if (i >= items.length) return;
			out[i] = await fn(items[i], i);
		}
	});
	await Promise.all(workers);
	return out;
}

/** @param {number} n @param {string} mode @param {any[]} results @param {Record<string, unknown>} [extra] */
export function summarize(n, mode, results, extra = {}) {
	const lat = results.map((r) => r.ms);
	const errors = results.filter((r) => !r.ok);
	const rateLimited = results.filter((r) => r.status === 429).length;
	return {
		n,
		mode,
		granted: results.filter((r) => r.ok).length,
		errors: errors.length,
		error_rate: results.length ? errors.length / results.length : 0,
		rate_limited: rateLimited,
		p50_ms: percentile(lat, 50),
		p95_ms: percentile(lat, 95),
		error_samples: [...new Set(errors.map((e) => `${e.status}:${e.error}${e.detail ? ":" + e.detail : ""}`))].slice(0, 5),
		...extra,
	};
}
