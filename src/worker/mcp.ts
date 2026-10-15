/*
 * MADGRIX MCP adapter.
 *
 * This is intentionally an adapter over the existing Worker API, not another
 * authority plane. Tool calls are converted to internal HTTP requests and
 * delegated to the same handlers that serve REST, preserving bearer auth,
 * X-Madgrix-Agent-Secret binding, WorkClaims, evaluator isolation, Verdict
 * Seam and promotion authority.
 *
 * Wire support:
 * - MCP 2026-07-28 stateless HTTP (server/discover + per-request headers)
 * - legacy 2025-era stateless initialize/tools/list/tools/call for existing
 *   coding-agent clients.
 *
 * No control-plane, evaluation-domain or canonical-write operation is exposed
 * as an agent tool here.
 */

export const MCP_PROTOCOL_VERSION = "2026-07-28";
const LEGACY_PROTOCOL_VERSION = "2025-11-25";
const SERVER_NAME = "madgrix";
const SERVER_VERSION = "0.1.0-competition";
const AGENT_SECRET_HEADER = "x-madgrix-agent-secret";

interface JsonRpcRequest {
	jsonrpc?: unknown;
	id?: unknown;
	method?: unknown;
	params?: unknown;
}

type CoreFetch = (request: Request) => Promise<Response>;
type JsonRecord = Record<string, unknown>;

const STRING = { type: "string", minLength: 1 } as const;
const STRING_ARRAY = { type: "array", items: { type: "string" } } as const;

const CLAIM_INPUT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["agent", "task", "baseline", "intent", "scope", "contracts", "interfaces", "schema_changes", "expected_tests", "lease"],
	properties: {
		agent: STRING,
		task: STRING,
		baseline: STRING,
		intent: {
			type: "object",
			additionalProperties: false,
			required: ["behavior"],
			properties: { behavior: STRING_ARRAY },
		},
		scope: {
			type: "object",
			additionalProperties: false,
			required: ["paths", "symbols"],
			properties: { paths: STRING_ARRAY, symbols: STRING_ARRAY },
		},
		contracts: {
			type: "object",
			additionalProperties: false,
			required: ["reads", "modifies"],
			properties: { reads: STRING_ARRAY, modifies: STRING_ARRAY },
		},
		interfaces: STRING_ARRAY,
		schema_changes: STRING_ARRAY,
		expected_tests: STRING_ARRAY,
		lease: {
			type: "object",
			additionalProperties: false,
			required: ["claimed_at", "expires_at"],
			properties: { claimed_at: STRING, expires_at: STRING },
		},
	},
} as const;

/** Stable ordering improves model prompt-cache hits and makes demos deterministic. */
export const MCP_TOOLS = [
	{
		name: "inspect_task",
		description:
			"Read the frozen MADGRIX task, claims, contenders, conflicts, composition and canonical work graph. Requires the normal agent or control-plane bearer token.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["task_id"],
			properties: { task_id: STRING },
		},
	},
	{
		name: "inspect_work_graph",
		description:
			"Read the canonical structured WorkGraph for a task. The configured public competition demo is readable without a token; every other task keeps the existing agent/control auth boundary.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["task_id"],
			properties: { task_id: STRING },
		},
	},
	{
		name: "check_clearance",
		description:
			"Project a WorkClaim's stored conflict reports into CLEAR, CAUTION, HOLD or REVIEW. This is advisory/read-only: it never grants authority and never replaces verdict or permit gates.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["task_id", "work_id"],
			properties: { task_id: STRING, work_id: STRING },
		},
	},
	{
		name: "claim_work",
		description:
			"Register an agent WorkClaim before coding. The server assigns work_id/status/version and binds the claim to the X-Madgrix-Agent-Secret supplied on the MCP HTTP connection; never put that secret in tool arguments.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["task_id", "claim"],
			properties: { task_id: STRING, claim: CLAIM_INPUT_SCHEMA },
		},
	},
	{
		name: "open_contender",
		description:
			"Create the authenticated agent's isolated Cloudflare Artifacts contender fork at the frozen baseline. Returns a short-lived fork write token once; treat it as sensitive and do not log it. Canonical write authority is never returned.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["task_id"],
			properties: { task_id: STRING, claim_work_id: STRING },
		},
	},
	{
		name: "read_ledger",
		description: "Read the task authority's append-only hash-chained ledger for audit/replay context.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["task_id"],
			properties: { task_id: STRING },
		},
	},
	{
		name: "verify_permit",
		description:
			"Check a stored exact-state permit against its bound fields and current canonical destination HEAD. This is the online permit/destination check; full evidence verification remains the offline promotion-bundle verifier.",
		inputSchema: {
			type: "object",
			additionalProperties: false,
			required: ["task_id", "permit_id"],
			properties: { task_id: STRING, permit_id: STRING },
		},
	},
] as const;

function asRecord(value: unknown): JsonRecord | null {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function nonEmptyString(value: unknown): string | null {
	return typeof value === "string" && value.trim() !== "" ? value : null;
}

function rpcResult(id: unknown, result: unknown, modern: boolean): Response {
	const record = asRecord(result);
	const stamped = modern && record
		? {
				...record,
				// 2026-07-28 consumes this wire-only discriminator before the
				// public SDK result reaches callers. Completed one-shot MADGRIX
				// tools never need an MRTR input_required response.
				resultType: "complete",
				_meta: {
					...(asRecord(record._meta) ?? {}),
					"io.modelcontextprotocol/serverInfo": { name: SERVER_NAME, version: SERVER_VERSION },
				},
			}
		: result;
	return jsonRpc({ jsonrpc: "2.0", id: id ?? null, result: stamped }, 200);
}

function rpcError(id: unknown, code: number, message: string, data?: unknown, status = 200): Response {
	return jsonRpc(
		{
			jsonrpc: "2.0",
			id: id ?? null,
			error: data === undefined ? { code, message } : { code, message, data },
		},
		status,
	);
}

function jsonRpc(value: unknown, status: number): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
		},
	});
}

function modernHeaderError(request: Request, body: JsonRpcRequest): Response | null {
	const declared = request.headers.get("MCP-Protocol-Version");
	// server/discover is the modern-era probe. Be tolerant of a missing
	// version header on the probe so auto-negotiating clients can discover us.
	if (declared === null && body.method === "server/discover") return null;
	if (declared === null) return null; // legacy-era request
	if (declared !== MCP_PROTOCOL_VERSION) {
		return rpcError(body.id, -32020, "Unsupported MCP protocol version", { supported: [MCP_PROTOCOL_VERSION] }, 400);
	}
	const methodHeader = request.headers.get("Mcp-Method");
	if (methodHeader !== body.method) {
		return rpcError(body.id, -32020, "Mcp-Method header does not match JSON-RPC method", undefined, 400);
	}
	if (body.method === "tools/call") {
		const params = asRecord(body.params);
		const name = params ? nonEmptyString(params.name) : null;
		if (!name || request.headers.get("Mcp-Name") !== name) {
			return rpcError(body.id, -32020, "Mcp-Name header does not match tools/call params.name", undefined, 400);
		}
	}
	return null;
}

function copyAuthorityHeaders(source: Request): Headers {
	const headers = new Headers({ accept: "application/json" });
	const authorization = source.headers.get("authorization");
	const agentSecret = source.headers.get(AGENT_SECRET_HEADER);
	if (authorization) headers.set("authorization", authorization);
	if (agentSecret) headers.set(AGENT_SECRET_HEADER, agentSecret);
	for (const trace of ["traceparent", "tracestate", "baggage"]) {
		const value = source.headers.get(trace);
		if (value) headers.set(trace, value);
	}
	return headers;
}

async function coreCall(
	mcpRequest: Request,
	coreFetch: CoreFetch,
	path: string,
	method = "GET",
	body?: unknown,
): Promise<{ status: number; ok: boolean; data: unknown }> {
	const headers = copyAuthorityHeaders(mcpRequest);
	let payload: string | undefined;
	if (body !== undefined) {
		headers.set("content-type", "application/json");
		payload = JSON.stringify(body);
	}
	const response = await coreFetch(
		new Request(new URL(path, mcpRequest.url), {
			method,
			headers,
			body: payload,
		}),
	);
	const contentType = response.headers.get("content-type") ?? "";
	if (!contentType.includes("application/json")) {
		return {
			status: response.status,
			ok: false,
			data: { error: "mcp_upstream_not_json", upstream_status: response.status },
		};
	}
	return { status: response.status, ok: response.ok, data: await response.json() };
}

function toolEnvelope(reply: { status: number; ok: boolean; data: unknown }) {
	const structured = {
		http_status: reply.status,
		ok: reply.ok,
		data: reply.data,
	};
	return {
		content: [{ type: "text", text: JSON.stringify(structured) }],
		structuredContent: structured,
		isError: !reply.ok,
	};
}

function localToolError(message: string, status = 400) {
	return toolEnvelope({ status, ok: false, data: { error: "invalid_tool_arguments", detail: message } });
}

function riskRank(value: string): number | null {
	if (value === "GREEN") return 0;
	if (value === "AMBER") return 1;
	if (value === "RED") return 2;
	if (value === "BLOCKED") return 3;
	return null;
}

function clearanceFromContext(data: unknown, workId: string): { status: number; ok: boolean; data: unknown } {
	const context = asRecord(data);
	const claims = Array.isArray(context?.claims) ? context.claims : [];
	const reports = Array.isArray(context?.conflict_reports) ? context.conflict_reports : [];
	const claim = claims.map(asRecord).find((row) => row?.work_id === workId);
	if (!claim) return { status: 404, ok: false, data: { error: "claim_not_found", work_id: workId } };

	const interactions = reports
		.map(asRecord)
		.filter((row): row is JsonRecord => Boolean(row && (row.claim_a === workId || row.claim_b === workId)));
	let worst = -1;
	let unknown = false;
	for (const report of interactions) {
		const rank = riskRank(String(report.risk ?? ""));
		if (rank === null) unknown = true;
		else worst = Math.max(worst, rank);
	}
	const clearance = unknown ? "REVIEW" : worst <= 0 ? "CLEAR" : worst === 1 ? "CAUTION" : "HOLD";
	return {
		status: 200,
		ok: true,
		data: {
			work_id: workId,
			agent: claim.agent ?? null,
			claim_status: claim.status ?? null,
			clearance,
			advisory_only: true,
			interaction_count: interactions.length,
			interactions,
			note: "Semantic clearance summarizes stored conflict reports. It does not grant authority or bypass verdict/permit gates.",
		},
	};
}

async function callTool(
	mcpRequest: Request,
	coreFetch: CoreFetch,
	name: string,
	args: JsonRecord,
): Promise<ReturnType<typeof toolEnvelope>> {
	const taskId = nonEmptyString(args.task_id);
	if (!taskId) return localToolError("task_id is required");
	const task = encodeURIComponent(taskId);

	switch (name) {
		case "inspect_task":
			return toolEnvelope(await coreCall(mcpRequest, coreFetch, `/tasks/${task}/context`));
		case "inspect_work_graph":
			return toolEnvelope(await coreCall(mcpRequest, coreFetch, `/tasks/${task}/graph?format=json`));
		case "check_clearance": {
			const workId = nonEmptyString(args.work_id);
			if (!workId) return localToolError("work_id is required");
			const context = await coreCall(mcpRequest, coreFetch, `/tasks/${task}/context`);
			if (!context.ok) return toolEnvelope(context);
			return toolEnvelope(clearanceFromContext(context.data, workId));
		}
		case "claim_work": {
			const claim = asRecord(args.claim);
			if (!claim) return localToolError("claim must be an object");
			return toolEnvelope(await coreCall(mcpRequest, coreFetch, `/tasks/${task}/claim`, "POST", { claim }));
		}
		case "open_contender": {
			const claimWorkId = args.claim_work_id === undefined ? undefined : nonEmptyString(args.claim_work_id);
			if (args.claim_work_id !== undefined && !claimWorkId) return localToolError("claim_work_id must be a non-empty string");
			const body = claimWorkId ? { claim_work_id: claimWorkId } : {};
			return toolEnvelope(await coreCall(mcpRequest, coreFetch, `/tasks/${task}/contenders`, "POST", body));
		}
		case "read_ledger":
			return toolEnvelope(await coreCall(mcpRequest, coreFetch, `/tasks/${task}/ledger`));
		case "verify_permit": {
			const permitId = nonEmptyString(args.permit_id);
			if (!permitId) return localToolError("permit_id is required");
			return toolEnvelope(await coreCall(mcpRequest, coreFetch, `/tasks/${task}/attestation/${encodeURIComponent(permitId)}/verify`));
		}
		default:
			return toolEnvelope({ status: 404, ok: false, data: { error: "unknown_tool", name } });
	}
}

function isKnownTool(name: string): boolean {
	return MCP_TOOLS.some((tool) => tool.name === name);
}

/** Serve the `/mcp` endpoint. */
export async function handleMcp(request: Request, coreFetch: CoreFetch): Promise<Response> {
	if (request.method !== "POST") {
		return new Response(JSON.stringify({ error: "method_not_allowed", allow: ["POST"] }), {
			status: 405,
			headers: { "content-type": "application/json; charset=utf-8", allow: "POST" },
		});
	}
	if (!(request.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) {
		return rpcError(null, -32700, "Content-Type must be application/json", undefined, 415);
	}

	let body: JsonRpcRequest;
	try {
		const parsed = await request.json();
		if (!asRecord(parsed)) return rpcError(null, -32600, "Invalid JSON-RPC request", undefined, 400);
		body = parsed as JsonRpcRequest;
	} catch {
		return rpcError(null, -32700, "Parse error", undefined, 400);
	}
	if (body.jsonrpc !== "2.0" || typeof body.method !== "string") {
		return rpcError(body.id, -32600, "Invalid JSON-RPC request", undefined, 400);
	}

	const headerError = modernHeaderError(request, body);
	if (headerError) return headerError;
	const modern = request.headers.get("MCP-Protocol-Version") === MCP_PROTOCOL_VERSION || body.method === "server/discover";

	if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
	if (body.method === "server/discover") {
		return rpcResult(
			body.id,
			{
				supportedVersions: [MCP_PROTOCOL_VERSION],
				capabilities: { tools: { listChanged: false } },
				instructions:
					"Use inspect_task/check_clearance before editing. Claim work before coding. Work only in the contender fork returned by open_contender. MADGRIX never exposes canonical write authority as an agent tool.",
				ttlMs: 60_000,
				cacheScope: "public",
			},
			true,
		);
	}
	if (body.method === "initialize") {
		const requested = nonEmptyString(asRecord(body.params)?.protocolVersion);
		const protocolVersion = requested && requested.startsWith("2025-") ? requested : LEGACY_PROTOCOL_VERSION;
		return rpcResult(
			body.id,
			{
				protocolVersion,
				capabilities: { tools: { listChanged: false } },
				serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
				instructions:
					"Use inspect_task/check_clearance before editing. Claim work before coding. Work only in the contender fork returned by open_contender. Canonical promotion is not an agent MCP tool.",
			},
			false,
		);
	}
	if (body.method === "ping") {
		if (modern) return rpcError(body.id, -32601, "Method not found: ping");
		return rpcResult(body.id, {}, false);
	}
	if (body.method === "tools/list") {
		return rpcResult(
			body.id,
			{ tools: MCP_TOOLS, ttlMs: 60_000, cacheScope: "public" },
			modern,
		);
	}
	if (body.method === "tools/call") {
		const params = asRecord(body.params);
		const name = params ? nonEmptyString(params.name) : null;
		if (!name) return rpcError(body.id, -32602, "tools/call requires params.name");
		if (!isKnownTool(name)) return rpcError(body.id, -32602, `Unknown tool: ${name}`);
		const args = params?.arguments === undefined ? {} : asRecord(params.arguments);
		if (!args) return rpcError(body.id, -32602, "tools/call params.arguments must be an object");
		try {
			return rpcResult(body.id, await callTool(request, coreFetch, name, args), modern);
		} catch (err) {
			console.error(`madgrix MCP tool ${name} failed: ${(err as Error)?.message ?? err}`);
			return rpcResult(
				body.id,
				toolEnvelope({ status: 500, ok: false, data: { error: "internal_error" } }),
				modern,
			);
		}
	}

	return rpcError(body.id, -32601, `Method not found: ${body.method}`);
}
