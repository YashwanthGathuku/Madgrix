export const MAX_LOGICAL_AGENTS = 10_000;
export const DEFAULT_ACTIVE_AGENT_WINDOW = 32;

const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface AgentWave {
	index: number;
	agent_ids: string[];
}

export function normalizeAgentRoster(ids: readonly string[]): string[] {
	if (!Array.isArray(ids) || ids.length === 0) throw new Error("agent roster must contain at least one id");
	if (ids.length > MAX_LOGICAL_AGENTS) {
		throw new Error(`agent roster exceeds ${MAX_LOGICAL_AGENTS} logical agents`);
	}
	const seen = new Set<string>();
	const out: string[] = [];
	for (const id of ids) {
		if (typeof id !== "string" || !AGENT_ID_PATTERN.test(id)) throw new Error(`invalid agent id ${JSON.stringify(id)}`);
		if (seen.has(id)) throw new Error(`duplicate agent id ${id}`);
		seen.add(id);
		out.push(id);
	}
	return out;
}

export function planAgentWaves(ids: readonly string[], activeWindow = DEFAULT_ACTIVE_AGENT_WINDOW): AgentWave[] {
	const roster = normalizeAgentRoster(ids);
	if (!Number.isInteger(activeWindow) || activeWindow < 1 || activeWindow > 256) {
		throw new Error("active agent window must be an integer between 1 and 256");
	}
	const waves: AgentWave[] = [];
	for (let offset = 0, index = 0; offset < roster.length; offset += activeWindow, index += 1) {
		waves.push({ index, agent_ids: roster.slice(offset, offset + activeWindow) });
	}
	return waves;
}

export async function runBounded<T, R>(
	items: readonly T[],
	limit: number,
	worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	if (!Number.isInteger(limit) || limit < 1 || limit > 256) throw new Error("concurrency limit must be an integer between 1 and 256");
	const out = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		for (;;) {
			const index = next;
			if (index >= items.length) return;
			next += 1;
			out[index] = await worker(items[index], index);
		}
	});
	await Promise.all(workers);
	return out;
}
