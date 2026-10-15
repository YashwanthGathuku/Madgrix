/**
 * Module memory (docs/MODULE_MEMORY.md): a deterministic, model-free map of
 * a repository, split into modules that each own one memory card.
 *
 * Pure logic, no I/O: the Node reader (scripts/lib/module-reader.ts) feeds
 * it file text read from git at one commit, and the ModuleAgent Durable
 * Object stores its output. Nothing here calls a model.
 *
 *   map     splitModules()      files -> modules (top-level path or config)
 *   read    buildModuleCard()   one module's files -> one memory card
 *   reduce  reduceRepoMap()     cards -> repo map + cross-module graph
 *   refresh planRefresh()       changed paths -> which modules to re-read
 *   route   routeChange()       paths / request text -> owning modules
 */

export const MODULE_CARD_VERSION = "module-card/v1";

export interface ModuleDef {
	/** Stable id, e.g. "src" or "sub-api". */
	id: string;
	/** Path globs (`*` within a segment, `**` across segments). */
	paths: string[];
}

export interface ModuleConfig {
	modules: ModuleDef[];
}

export interface FileFacts {
	path: string;
	lines: number;
	language: string;
	/** Exported names (TS/JS `export`, Python public top-level def/class). */
	exports: string[];
	/** Raw import specifiers as written; resolved in reduceRepoMap(). */
	imports: string[];
	/** Why this file is an entry point, or null. */
	entry: string | null;
	is_test: boolean;
}

export interface ModuleCard {
	version: typeof MODULE_CARD_VERSION;
	module_id: string;
	paths: string[];
	/** The commit the card was read from. A card is only valid at this SHA. */
	built_from_sha: string;
	/** sha256 over "path\0blob\n" of the module's files at built_from_sha. */
	content_digest: string;
	files: FileFacts[];
	total_lines: number;
	/** Optional model summary. Null unless a summary hook was supplied. */
	summary: string | null;
}

export interface ResolvedEdge {
	from_module: string;
	to_module: string;
	/** file -> file pairs behind this edge, sorted. */
	via: Array<{ from: string; to: string }>;
}

export interface RepoMap {
	version: "repo-map/v1";
	sha: string;
	modules: Array<{
		module_id: string;
		paths: string[];
		files: number;
		lines: number;
		exports: number;
		entry_points: string[];
		/** Test files (in any module) that import a file of this module. */
		tests: string[];
		depends_on: string[];
		depended_on_by: string[];
		built_from_sha: string;
	}>;
	edges: ResolvedEdge[];
	unresolved_imports: number;
}

/* ------------------------------------------------------------------ */
/* globs + module split                                                */

export function globToRegExp(glob: string): RegExp {
	const body = glob
		.replace(/\\/g, "/")
		.replace(/^\.\//, "")
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*\*\/?/g, "\u0000")
		.replace(/\*/g, "[^/]*")
		.replace(/\?/g, "[^/]")
		.replace(/\u0000/g, ".*");
	return new RegExp(`^${body}$`);
}

export function pathMatches(file: string, globs: string[]): boolean {
	return globs.some((g) => globToRegExp(g).test(file));
}

/**
 * Split files into modules. With a config, each file goes to the FIRST
 * module whose globs match it; unmatched files go to "(root)". Without a
 * config, each top-level directory is a module and top-level files are
 * "(root)". Deterministic: modules and files are sorted.
 */
export function splitModules(files: string[], config?: ModuleConfig): Array<ModuleDef & { files: string[] }> {
	const sorted = [...new Set(files)].sort();
	const out = new Map<string, { id: string; paths: string[]; files: string[] }>();
	const add = (id: string, paths: string[], file: string) => {
		const m = out.get(id) ?? { id, paths, files: [] };
		m.files.push(file);
		out.set(id, m);
	};
	if (config && config.modules.length > 0) {
		const ids = new Set<string>();
		for (const m of config.modules) {
			if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(m.id)) throw new Error(`module id ${JSON.stringify(m.id)} is invalid`);
			if (ids.has(m.id)) throw new Error(`duplicate module id ${m.id}`);
			if (m.paths.length === 0 || m.paths.some((p) => p === "**")) throw new Error(`module ${m.id} needs a non-"**" path scope`);
			ids.add(m.id);
		}
		for (const file of sorted) {
			const owner = config.modules.find((m) => pathMatches(file, m.paths));
			if (owner) add(owner.id, owner.paths, file);
			else add("(root)", ["*"], file);
		}
		for (const m of config.modules) if (!out.has(m.id)) out.set(m.id, { id: m.id, paths: m.paths, files: [] });
	} else {
		for (const file of sorted) {
			const slash = file.indexOf("/");
			if (slash < 0) add("(root)", ["*"], file);
			else {
				const top = file.slice(0, slash);
				add(top, [`${top}/**`], file);
			}
		}
	}
	return [...out.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Module config from a `.madgrix/subagent-intents.json` record (fork crew):
 * each agent with path claims becomes one module owned by that agent.
 */
export function modulesFromSubagentIntents(record: unknown): ModuleConfig {
	const agents = (record as { agents?: unknown })?.agents;
	if (!Array.isArray(agents)) throw new Error("subagent-intents record has no agents[]");
	const modules: ModuleDef[] = [];
	for (const a of agents) {
		const id = (a as { agent_id?: unknown; id?: unknown }).agent_id ?? (a as { id?: unknown }).id;
		const paths = (a as { paths?: unknown }).paths;
		if (typeof id === "string" && Array.isArray(paths) && paths.every((p) => typeof p === "string")) {
			modules.push({ id, paths: paths as string[] });
		}
	}
	return { modules };
}

/* ------------------------------------------------------------------ */
/* read: per-file facts                                                */

function languageOf(file: string): string {
	const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
	if (["ts", "tsx", "mts", "cts"].includes(ext)) return "typescript";
	if (["js", "mjs", "cjs", "jsx"].includes(ext)) return "javascript";
	if (ext === "py") return "python";
	if (ext === "sh") return "shell";
	if (["md", "txt"].includes(ext)) return "text";
	if (["json", "yaml", "yml", "toml"].includes(ext)) return "config";
	return "other";
}

export function isTestPath(file: string): boolean {
	return /(^|\/)(test|tests|__tests__)\//.test(file) || /\.(test|spec)\.[a-z]+$/.test(file) || /(^|\/)test_[^/]*\.py$/.test(file);
}

const uniqSorted = (xs: Iterable<string>) => [...new Set(xs)].sort();

export function extractFacts(file: string, text: string): FileFacts {
	const language = languageOf(file);
	const lines = text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
	const exports: string[] = [];
	const imports: string[] = [];
	let entry: string | null = null;
	if (text.startsWith("#!")) entry = "shebang";
	if (language === "typescript" || language === "javascript") {
		for (const m of text.matchAll(/^\s*export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum|abstract\s+class)\s+([A-Za-z_$][\w$]*)/gm)) exports.push(m[1]);
		for (const m of text.matchAll(/^\s*export\s*\{([^}]*)\}/gm)) {
			for (const part of m[1].split(",")) {
				const name = part.trim().split(/\s+as\s+/).pop()?.trim();
				if (name) exports.push(name.replace(/^type\s+/, ""));
			}
		}
		if (/^\s*export\s+default\b/m.test(text)) {
			exports.push("default");
			if (entry === null && /export\s+default\s*\{[\s\S]*?\b(fetch|queue|scheduled)\b/.test(text)) entry = "worker-export-default";
		}
		for (const m of text.matchAll(/\b(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\sfrom\s+)?["']([^"']+)["']/g)) imports.push(m[1]);
		for (const m of text.matchAll(/\b(?:import|require)\(\s*["']([^"']+)["']\s*\)/g)) imports.push(m[1]);
	} else if (language === "python") {
		for (const m of text.matchAll(/^(?:async\s+)?(?:def|class)\s+([A-Za-z]\w*)/gm)) exports.push(m[1]);
		for (const m of text.matchAll(/^\s*from\s+(\.*[\w.]*)\s+import\s+([\w*, ]+|\([^)]*\))/gm)) {
			const base = m[1];
			if (/^\.+$/.test(base)) {
				for (const n of m[2].replace(/[()]/g, "").split(",")) {
					const name = n.trim().split(/\s+as\s+/)[0];
					if (name && name !== "*") imports.push(`${base}${name}`);
				}
			} else imports.push(base);
		}
		for (const m of text.matchAll(/^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm)) {
			for (const n of m[1].split(",")) imports.push(n.trim());
		}
		if (/^if\s+__name__\s*==\s*["']__main__["']/m.test(text)) entry = entry ?? "python-main";
	}
	return {
		path: file,
		lines,
		language,
		exports: uniqSorted(exports),
		imports: uniqSorted(imports),
		entry,
		is_test: isTestPath(file),
	};
}

export type Sha256Hex = (input: string) => Promise<string>;

/**
 * One module's memory card. `files` maps each path to its text and git blob
 * id at `sha`. `summarize`, when given, is the optional model hook; it is
 * off by default and never affects any other field.
 */
export async function buildModuleCard(
	module: ModuleDef,
	sha: string,
	files: Array<{ path: string; blob: string; text: string }>,
	sha256Hex: Sha256Hex,
	summarize?: (card: ModuleCard) => Promise<string>,
): Promise<ModuleCard> {
	const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : 1));
	const facts = sorted.map((f) => extractFacts(f.path, f.text));
	const card: ModuleCard = {
		version: MODULE_CARD_VERSION,
		module_id: module.id,
		paths: [...module.paths],
		built_from_sha: sha,
		content_digest: await sha256Hex(sorted.map((f) => `${f.path}\0${f.blob}\n`).join("")),
		files: facts,
		total_lines: facts.reduce((n, f) => n + f.lines, 0),
		summary: null,
	};
	if (summarize) card.summary = await summarize(card);
	return card;
}

/* ------------------------------------------------------------------ */
/* reduce                                                              */

function dirname(p: string): string {
	const i = p.lastIndexOf("/");
	return i < 0 ? "" : p.slice(0, i);
}

function normalize(p: string): string {
	const out: string[] = [];
	for (const seg of p.split("/")) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") out.pop();
		else out.push(seg);
	}
	return out.join("/");
}

/** Resolve one import specifier written in `from` against the repo's files. */
export function resolveImport(from: string, spec: string, fileSet: Set<string>): string | null {
	const lang = languageOf(from);
	if (lang === "python") {
		const dots = /^\.+/.exec(spec)?.[0].length ?? 0;
		const rest = spec.slice(dots).replace(/\./g, "/");
		const candidates: string[] = [];
		if (dots > 0) {
			let base = dirname(from);
			for (let i = 1; i < dots; i++) base = dirname(base);
			const p = normalize(`${base}/${rest}`);
			candidates.push(`${p}.py`, `${p}/__init__.py`);
		} else {
			// Absolute: try from the repo root and from each ancestor of `from`.
			let base = dirname(from);
			for (;;) {
				const p = normalize(`${base}/${rest}`);
				candidates.push(`${p}.py`, `${p}/__init__.py`);
				if (base === "") break;
				base = dirname(base);
			}
		}
		return candidates.find((c) => fileSet.has(c)) ?? null;
	}
	if (!spec.startsWith(".")) return null; // package import, not a repo file
	const p = normalize(`${dirname(from)}/${spec}`);
	const exts = ["", ".ts", ".tsx", ".mts", ".js", ".mjs", ".cjs", "/index.ts", "/index.js"];
	for (const e of exts) if (fileSet.has(p + e)) return p + e;
	if (/\.js$/.test(p) && fileSet.has(p.replace(/\.js$/, ".ts"))) return p.replace(/\.js$/, ".ts");
	return null;
}

export function reduceRepoMap(sha: string, cards: ModuleCard[]): RepoMap {
	const owner = new Map<string, string>();
	for (const c of cards) for (const f of c.files) owner.set(f.path, c.module_id);
	const fileSet = new Set(owner.keys());
	const edgeVia = new Map<string, Array<{ from: string; to: string }>>();
	const tests = new Map<string, Set<string>>();
	let unresolved = 0;
	for (const c of cards) {
		for (const f of c.files) {
			for (const spec of f.imports) {
				const target = resolveImport(f.path, spec, fileSet);
				if (target === null) {
					if (spec.startsWith(".")) unresolved++;
					continue;
				}
				const to = owner.get(target)!;
				if (f.is_test) {
					const set = tests.get(to) ?? new Set<string>();
					set.add(f.path);
					tests.set(to, set);
				}
				if (to === c.module_id) continue;
				const key = `${c.module_id}\0${to}`;
				const list = edgeVia.get(key) ?? [];
				list.push({ from: f.path, to: target });
				edgeVia.set(key, list);
			}
		}
	}
	const edges: ResolvedEdge[] = [...edgeVia.entries()]
		.map(([key, via]) => {
			const [from_module, to_module] = key.split("\0");
			const seen = new Set<string>();
			const dedup = via
				.filter((v) => {
					const k = `${v.from}\0${v.to}`;
					if (seen.has(k)) return false;
					seen.add(k);
					return true;
				})
				.sort((a, b) => (a.from + a.to < b.from + b.to ? -1 : 1));
			return { from_module, to_module, via: dedup };
		})
		.sort((a, b) => (a.from_module + "\0" + a.to_module < b.from_module + "\0" + b.to_module ? -1 : 1));
	const modules = [...cards]
		.sort((a, b) => (a.module_id < b.module_id ? -1 : 1))
		.map((c) => ({
			module_id: c.module_id,
			paths: c.paths,
			files: c.files.length,
			lines: c.total_lines,
			exports: c.files.reduce((n, f) => n + f.exports.length, 0),
			entry_points: c.files.filter((f) => f.entry !== null).map((f) => f.path),
			tests: uniqSorted(tests.get(c.module_id) ?? []),
			depends_on: uniqSorted(edges.filter((e) => e.from_module === c.module_id).map((e) => e.to_module)),
			depended_on_by: uniqSorted(edges.filter((e) => e.to_module === c.module_id).map((e) => e.from_module)),
			built_from_sha: c.built_from_sha,
		}));
	return { version: "repo-map/v1", sha, modules, edges, unresolved_imports: unresolved };
}

/* ------------------------------------------------------------------ */
/* incremental refresh                                                 */

export interface RefreshPlan {
	from_sha: string;
	to_sha: string;
	/** Modules whose files changed (or that are new): re-read. */
	reread: string[];
	/** Modules with no changed file: their card is reused, re-pinned to to_sha. */
	reused: string[];
	/** Modules that no longer have files. */
	removed: string[];
	files_to_read: number;
	files_total: number;
}

/**
 * Which modules a new commit invalidates. `changed` is `git diff
 * --name-only from..to` (added, modified, deleted, and both sides of a
 * rename). A module is re-read when any of its files at either SHA changed.
 */
export function planRefresh(
	previous: ModuleCard[],
	next: Array<ModuleDef & { files: string[] }>,
	changed: string[],
	fromSha: string,
	toSha: string,
): RefreshPlan {
	const changedSet = new Set(changed);
	const prevById = new Map(previous.map((c) => [c.module_id, c]));
	const reread: string[] = [];
	const reused: string[] = [];
	let filesToRead = 0;
	for (const m of next) {
		const prev = prevById.get(m.id);
		const prevFiles = prev ? prev.files.map((f) => f.path) : [];
		const touched =
			!prev ||
			prev.built_from_sha !== fromSha ||
			m.files.some((f) => changedSet.has(f)) ||
			prevFiles.some((f) => changedSet.has(f));
		if (touched) {
			reread.push(m.id);
			filesToRead += m.files.length;
		} else reused.push(m.id);
	}
	const nextIds = new Set(next.map((m) => m.id));
	const removed = previous.map((c) => c.module_id).filter((id) => !nextIds.has(id)).sort();
	return {
		from_sha: fromSha,
		to_sha: toSha,
		reread: reread.sort(),
		reused: reused.sort(),
		removed,
		files_to_read: filesToRead,
		files_total: next.reduce((n, m) => n + m.files.length, 0),
	};
}

/** A reused card, re-pinned: same content, now valid at `sha`. */
export function repinCard(card: ModuleCard, sha: string): ModuleCard {
	return { ...card, built_from_sha: sha };
}

/* ------------------------------------------------------------------ */
/* change routing                                                      */

export interface ModuleRoute {
	module_id: string;
	reasons: Array<"path" | "symbol" | "file-name">;
	matched: string[];
}

export interface RoutingRecord {
	sha: string;
	request: string | null;
	paths: string[];
	routes: ModuleRoute[];
	/** Paths no module owns. */
	unowned: string[];
}

/**
 * Owning modules for a change. Paths route by file ownership (exact file in
 * a card, else the module's globs). Request text routes, model-free, by
 * exact exported-symbol or file-basename tokens. Only matched modules wake.
 */
export function routeChange(
	cards: ModuleCard[],
	input: { paths?: string[]; request?: string },
	sha: string,
): RoutingRecord {
	const routes = new Map<string, ModuleRoute>();
	const add = (id: string, reason: ModuleRoute["reasons"][number], what: string) => {
		const r = routes.get(id) ?? { module_id: id, reasons: [], matched: [] };
		if (!r.reasons.includes(reason)) r.reasons.push(reason);
		if (!r.matched.includes(what)) r.matched.push(what);
		routes.set(id, r);
	};
	const unowned: string[] = [];
	const paths = uniqSorted((input.paths ?? []).map((p) => normalize(p)));
	for (const p of paths) {
		const byFile = cards.find((c) => c.files.some((f) => f.path === p));
		const byGlob = byFile ?? cards.find((c) => c.module_id !== "(root)" && pathMatches(p, c.paths)) ?? cards.find((c) => pathMatches(p, c.paths));
		if (byGlob) add(byGlob.module_id, "path", p);
		else unowned.push(p);
	}
	if (input.request) {
		const tokens = new Set(input.request.match(/[A-Za-z_$][\w$.-]{2,}/g) ?? []);
		for (const c of cards) {
			for (const f of c.files) {
				for (const e of f.exports) if (e !== "default" && tokens.has(e)) add(c.module_id, "symbol", e);
				const base = f.path.slice(f.path.lastIndexOf("/") + 1);
				if (tokens.has(base) || tokens.has(f.path)) add(c.module_id, "file-name", base);
			}
		}
	}
	const sorted = [...routes.values()]
		.map((r) => ({ ...r, reasons: r.reasons.sort(), matched: r.matched.sort() }))
		.sort((a, b) => (a.module_id < b.module_id ? -1 : 1));
	return { sha, request: input.request ?? null, paths, routes: sorted, unowned };
}

/** Durable Object name for a module agent: repo + path globs (+ module id). */
export function moduleAgentName(repo: string, module: ModuleDef): string {
	return `module-agent/v1\0${repo}\0${module.id}\0${[...module.paths].sort().join(",")}`;
}
