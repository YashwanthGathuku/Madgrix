/**
 * ModuleAgent — one Durable Object per module of one repository
 * (docs/MODULE_MEMORY.md). The object name is moduleAgentName(repo, module):
 * repo + module id + path globs, so one module's memory has one owner.
 *
 * Sleep and wake: the object keeps NOTHING in memory between requests. Its
 * card and meta live in Durable Object storage, so the runtime may evict
 * the idle object (plain idle eviction; this class does not use WebSocket
 * hibernation) and the next request reconstructs it from storage. "Wake"
 * is therefore a request, not a resident process.
 *
 * Memory is pinned: a card is valid only at card.built_from_sha. /memory
 * and /route refuse with 409 stale_memory when the caller's SHA differs.
 */
import type { ModuleCard, ModuleDef, RoutingRecord } from "../lib/module-memory.ts";
import { MODULE_CARD_VERSION } from "../lib/module-memory.ts";

const CARD_KEY = "module-card";
const META_KEY = "module-meta";
const MAX_ROUTES = 50;

export interface ModuleAgentMeta {
	repo: string;
	module_id: string;
	paths: string[];
	loaded_at: string;
	wake_count: number;
	last_woken_at: string | null;
	/** Most recent routed changes, newest last (bounded). */
	routes: Array<{ at: string; sha: string; request: string | null; matched: string[] }>;
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function sameModule(meta: ModuleAgentMeta, repo: string, module: ModuleDef): boolean {
	return (
		meta.repo === repo &&
		meta.module_id === module.id &&
		JSON.stringify([...meta.paths].sort()) === JSON.stringify([...module.paths].sort())
	);
}

function validModule(m: unknown): m is ModuleDef {
	const x = m as ModuleDef;
	return !!x && typeof x.id === "string" && Array.isArray(x.paths) && x.paths.every((p) => typeof p === "string");
}

export class ModuleAgent {
	private doState: DurableObjectState;
	private now: () => string;

	constructor(state: DurableObjectState, _env: DurableObjectEnv, now: () => string = () => new Date().toISOString()) {
		this.doState = state;
		this.now = now;
	}

	async fetch(request: Request): Promise<Response> {
		const path = new URL(request.url).pathname;
		if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
		let body: Record<string, unknown>;
		try {
			body = (await request.json()) as Record<string, unknown>;
		} catch {
			return json({ error: "invalid_json" }, 400);
		}
		const repo = body["repo"];
		const module = body["module"];
		if (typeof repo !== "string" || repo.length === 0 || !validModule(module)) {
			return json({ error: "invalid_module_identity" }, 400);
		}
		return this.doState.storage.transaction(async () => {
			const meta = await this.doState.storage.get<ModuleAgentMeta>(META_KEY);
			if (meta && !sameModule(meta, repo, module)) return json({ error: "module_identity_mismatch" }, 409);

			if (path === "/load") {
				const card = body["card"] as ModuleCard | undefined;
				if (!card || card.version !== MODULE_CARD_VERSION || card.module_id !== module.id || typeof card.built_from_sha !== "string") {
					return json({ error: "invalid_card" }, 400);
				}
				const nextMeta: ModuleAgentMeta = meta ?? {
					repo,
					module_id: module.id,
					paths: [...module.paths],
					loaded_at: this.now(),
					wake_count: 0,
					last_woken_at: null,
					routes: [],
				};
				await this.doState.storage.put(CARD_KEY, card);
				await this.doState.storage.put(META_KEY, { ...nextMeta, loaded_at: this.now() });
				return json({ loaded: true, module_id: module.id, built_from_sha: card.built_from_sha });
			}

			const card = await this.doState.storage.get<ModuleCard>(CARD_KEY);
			if (!meta || !card) return json({ error: "no_memory" }, 404);
			const sha = body["sha"];
			if (typeof sha !== "string" || sha.length === 0) return json({ error: "sha_required" }, 400);
			const fresh = card.built_from_sha === sha;

			if (path === "/wake") {
				const woke = { ...meta, wake_count: meta.wake_count + 1, last_woken_at: this.now() };
				await this.doState.storage.put(META_KEY, woke);
				return json({ awake: true, module_id: meta.module_id, wake_count: woke.wake_count, fresh, built_from_sha: card.built_from_sha });
			}
			if (!fresh) return json({ error: "stale_memory", built_from_sha: card.built_from_sha, requested_sha: sha }, 409);
			if (path === "/memory") return json({ card, meta });
			if (path === "/route") {
				const routing = body["routing"] as RoutingRecord | undefined;
				const mine = routing?.routes?.find((r) => r.module_id === meta.module_id);
				if (!routing || routing.sha !== sha || !mine) return json({ error: "not_routed_to_this_module" }, 409);
				const routes = [...meta.routes, { at: this.now(), sha, request: routing.request, matched: mine.matched }].slice(-MAX_ROUTES);
				await this.doState.storage.put(META_KEY, { ...meta, routes });
				const files = card.files.filter((f) => mine.matched.includes(f.path) || f.exports.some((e) => mine.matched.includes(e)));
				return json({ accepted: true, module_id: meta.module_id, matched: mine.matched, files, card });
			}
			return json({ error: "not_found", path }, 404);
		});
	}
}
