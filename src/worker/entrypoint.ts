/*
 * Cloudflare Worker entrypoint wrapper.
 *
 * The core authority/router remains src/worker/index.ts. This wrapper mounts
 * MCP plus the competition's read-only canonicality projections. Every
 * mutating protocol call still delegates to the proven core router.
 */
import * as core from "./index.ts";
import { handleMcp } from "./mcp.ts";
import { canonCapFromPermit } from "../lib/canoncap.ts";
import { buildCausalProofGraph } from "../lib/causal-proof.ts";
import { buildConflictCapsule } from "../lib/conflict-capsule.ts";
import type { AuthorityState } from "../lib/types.ts";
import { projectCanonicality, renderCanonicalityPanel } from "./canonicality-panel.ts";

export * from "./index.ts";

type WorkerEnv = Parameters<typeof core.fetch>[1];

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

async function readState(env: WorkerEnv, taskId: string): Promise<{ ok: true; state: AuthorityState } | { ok: false; response: Response }> {
	const ns = env.TASK_AUTHORITY;
	const stub = ns.get(ns.idFromName(taskId));
	const res = await stub.fetch(new Request("https://task-authority/state", { method: "GET" }));
	if (!res.headers.get("content-type")?.toLowerCase().includes("application/json")) {
		await res.body?.cancel().catch(() => undefined);
		return { ok: false, response: json({ error: "task_authority_not_json" }, 502) };
	}
	const body = await res.json().catch(() => null);
	if (!res.ok) return { ok: false, response: json(body ?? { error: "task_authority_failed" }, res.status) };
	return { ok: true, state: body as AuthorityState };
}

function isPublicDemo(env: WorkerEnv, taskId: string): boolean {
	return typeof env.MADGRIX_PUBLIC_DEMO_TASK_ID === "string" && env.MADGRIX_PUBLIC_DEMO_TASK_ID.length > 0 && env.MADGRIX_PUBLIC_DEMO_TASK_ID === taskId;
}

function pathParts(url: string): string[] {
	return new URL(url).pathname.split("/").filter(Boolean).map(decodeURIComponent);
}

async function canonicalityRoute(request: Request, env: WorkerEnv): Promise<Response | null> {
	if (request.method !== "GET") return null;
	const p = pathParts(request.url);
	if (p[0] !== "tasks" || !p[1]) return null;
	const taskId = p[1];
	if (p[2] !== "canoncap" && p[2] !== "why" && p[2] !== "conflict-capsule" && p[2] !== "canonicality") return null;

	// The proof projections intentionally expose only the already-configured
	// public competition task. This avoids duplicating the core auth code and
	// prevents accidental disclosure of private task metadata.
	if (!isPublicDemo(env, taskId)) return json({ error: "public_demo_task_required" }, 401);

	const read = await readState(env, taskId);
	if (!read.ok) return read.response;

	if (p[2] === "canoncap" && p.length === 4) {
		const permit = read.state.permits[p[3]];
		if (!permit) return json({ error: "unknown_permit", permit_id: p[3] }, 404);
		return json(await canonCapFromPermit(permit));
	}
	if (p[2] === "why" && p.length === 4) {
		try {
			return json(await buildCausalProofGraph(read.state, p[3]));
		} catch (err) {
			return json({ error: "causal_proof_unavailable", detail: err instanceof Error ? err.message : String(err) }, 404);
		}
	}
	if (p[2] === "conflict-capsule" && p.length === 3) {
		if (read.state.composition?.status !== "CONFLICTED") return json({ error: "no_conflicted_composition" }, 404);
		return json(await buildConflictCapsule(read.state.task.task_hash, read.state.composition));
	}
	if (p[2] === "canonicality" && p.length === 3) return json(await projectCanonicality(read.state));
	return null;
}

async function enhanceGraph(request: Request, env: WorkerEnv, response: Response): Promise<Response> {
	const p = pathParts(request.url);
	if (
		request.method !== "GET" || p[0] !== "tasks" || !p[1] || p[2] !== "graph" || p.length !== 3 ||
		!response.ok || !(response.headers.get("content-type") ?? "").includes("text/html")
	) return response;
	const read = await readState(env, p[1]);
	if (!read.ok) return response;
	const panel = renderCanonicalityPanel(await projectCanonicality(read.state));
	const html = await response.text();
	const enhanced = html.includes("</body>") ? html.replace("</body>", `${panel}</body>`) : `${html}${panel}`;
	const headers = new Headers(response.headers);
	headers.set("content-type", "text/html; charset=utf-8");
	return new Response(enhanced, { status: response.status, headers });
}

export async function fetch(request: Request, env: WorkerEnv): Promise<Response> {
	const projection = await canonicalityRoute(request, env);
	if (projection) return projection;

	const url = new URL(request.url);
	const response = url.pathname === "/mcp" || url.pathname === "/mcp/"
		? await handleMcp(request, (inner) => core.fetch(inner, env))
		: await core.fetch(request, env);
	return enhanceGraph(request, env, response);
}

// The deploy API needs the queue consumer on the module's handler object;
// `export *` does not carry index.ts's default export, so name it here.
export const queue = core.queue;
export default { fetch, queue };
