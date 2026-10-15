import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { TOKENS, makeTask } from "./helpers/worker-harness.ts";

// worker-harness installs the cloudflare:workers test hook before this dynamic
// import evaluates the production entrypoint.
const mcpWorker = await import("../src/worker/entrypoint.ts");

const MODERN = "2026-07-28";

interface McpOptions {
	token?: string;
	secret?: string;
	modern?: boolean;
	id?: number | string;
	overrideMethodHeader?: string;
	overrideNameHeader?: string;
}

async function mcp(
	env: Record<string, unknown>,
	method: string,
	params: Record<string, unknown> | undefined,
	opts: McpOptions = {},
) {
	const modern = opts.modern ?? true;
	const headers = new Headers({ "content-type": "application/json", accept: "application/json" });
	if (modern) {
		headers.set("MCP-Protocol-Version", MODERN);
		headers.set("Mcp-Method", opts.overrideMethodHeader ?? method);
		if (method === "tools/call") {
			const name = String(params?.name ?? "");
			headers.set("Mcp-Name", opts.overrideNameHeader ?? name);
		}
	}
	if (opts.token) headers.set("authorization", `Bearer ${opts.token}`);
	if (opts.secret) headers.set("x-madgrix-agent-secret", opts.secret);

	const response = await mcpWorker.fetch(
		new Request("https://madgrix.test/mcp", {
			method: "POST",
			headers,
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: opts.id ?? 1,
				method,
				...(params === undefined ? {} : { params }),
			}),
		}),
		env as never,
	);
	return { status: response.status, body: (await response.json()) as any };
}

function toolData(reply: any) {
	return reply.result.structuredContent as { http_status: number; ok: boolean; data: any };
}

describe("MADGRIX stateless MCP adapter", () => {
	it("discovers the modern stateless protocol and server capabilities", async () => {
		const response = await mcp({}, "server/discover", undefined, { modern: true });
		assert.equal(response.status, 200);
		assert.deepEqual(response.body.result.supportedVersions, [MODERN]);
		assert.equal(response.body.result.capabilities.tools.listChanged, false);
		assert.equal(response.body.result.resultType, "complete", "2026-07-28 requires a wire result discriminator");
		assert.equal(response.body.result._meta["io.modelcontextprotocol/serverInfo"].name, "madgrix");
		assert.match(response.body.result.instructions, /Claim work before coding/);
	});

	it("supports legacy initialize for existing coding-agent clients", async () => {
		const response = await mcp(
			{},
			"initialize",
			{ protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test-agent", version: "1" } },
			{ modern: false },
		);
		assert.equal(response.status, 200);
		assert.equal(response.body.result.protocolVersion, "2025-11-25");
		assert.equal(response.body.result.serverInfo.name, "madgrix");
		assert.equal(response.body.result.capabilities.tools.listChanged, false);
		assert.equal(response.body.result.resultType, undefined, "legacy wire must not receive the modern discriminator");
	});

	it("does not expose legacy ping in the 2026-07-28 era", async () => {
		const response = await mcp({}, "ping", {}, { modern: true });
		assert.equal(response.status, 200);
		assert.equal(response.body.error.code, -32601);
		assert.match(response.body.error.message, /ping/);
	});

	it("publishes only agent-safe tools and no canonical-write or decision tool", async () => {
		const response = await mcp({}, "tools/list", {}, { modern: true });
		assert.equal(response.status, 200);
		assert.equal(response.body.result.resultType, "complete");
		const names = response.body.result.tools.map((tool: { name: string }) => tool.name);
		assert.deepEqual(names, [
			"inspect_task",
			"inspect_work_graph",
			"check_clearance",
			"claim_work",
			"open_contender",
			"read_ledger",
			"verify_permit",
		]);
		for (const forbidden of ["promote", "verdict", "evidence", "composition", "rebase", "finalize", "issue_permit"]) {
			assert.equal(names.includes(forbidden), false, `MCP must not expose privileged tool ${forbidden}`);
		}
	});

	it("rejects modern transport/header mismatch before a tool can run", async () => {
		const response = await mcp(
			{},
			"tools/list",
			{},
			{ modern: true, overrideMethodHeader: "tools/call" },
		);
		assert.equal(response.status, 400);
		assert.equal(response.body.error.code, -32020);
		assert.match(response.body.error.message, /Mcp-Method/);
	});

	it("cannot use MCP to bypass the existing task-context bearer boundary", async () => {
		const { h } = await makeTask();
		const response = await mcp(
			h.env,
			"tools/call",
			{ name: "inspect_task", arguments: { task_id: h.taskId } },
			{ modern: true },
		);
		assert.equal(response.status, 200, "MCP protocol call itself succeeds so the tool can return its governed error");
		assert.equal(response.body.result.resultType, "complete");
		assert.equal(response.body.result.isError, true);
		assert.equal(toolData(response.body).http_status, 401);
		assert.equal(toolData(response.body).data.error, "task_context_auth_required");
	});

	it("derives semantic clearance from the same stored context and labels it advisory-only", async () => {
		const { h } = await makeTask();
		const inspect = await mcp(
			h.env,
			"tools/call",
			{ name: "inspect_task", arguments: { task_id: h.taskId } },
			{ token: TOKENS.agent, modern: true },
		);
		assert.equal(toolData(inspect.body).http_status, 200);
		const workId = toolData(inspect.body).data.claims[0].work_id;
		assert.equal(typeof workId, "string");

		const clearance = await mcp(
			h.env,
			"tools/call",
			{ name: "check_clearance", arguments: { task_id: h.taskId, work_id: workId } },
			{ token: TOKENS.agent, modern: true },
		);
		assert.equal(clearance.body.result.isError, false);
		assert.equal(toolData(clearance.body).data.clearance, "CLEAR");
		assert.equal(toolData(clearance.body).data.advisory_only, true);
		assert.match(toolData(clearance.body).data.note, /does not grant authority/);
	});

	it("preserves agent-secret binding when opening an isolated contender", async () => {
		const { h, secret } = await makeTask();
		const inspect = await mcp(
			h.env,
			"tools/call",
			{ name: "inspect_task", arguments: { task_id: h.taskId } },
			{ token: TOKENS.agent },
		);
		const workId = toolData(inspect.body).data.claims[0].work_id;

		const missingSecret = await mcp(
			h.env,
			"tools/call",
			{ name: "open_contender", arguments: { task_id: h.taskId, claim_work_id: workId } },
			{ token: TOKENS.agent },
		);
		assert.equal(missingSecret.body.result.isError, true);
		assert.equal(toolData(missingSecret.body).http_status, 401);
		assert.equal(toolData(missingSecret.body).data.error, "agent_secret_required");

		const opened = await mcp(
			h.env,
			"tools/call",
			{ name: "open_contender", arguments: { task_id: h.taskId, claim_work_id: workId } },
			{ token: TOKENS.agent, secret },
		);
		assert.equal(opened.body.result.isError, false, JSON.stringify(opened.body));
		assert.equal(toolData(opened.body).http_status, 201);
		assert.equal(typeof toolData(opened.body).data.token, "string", "the existing contender route returns its one-time fork token");
		assert.equal(typeof toolData(opened.body).data.fork_repo, "string");
		assert.equal(toolData(opened.body).data.canonical_token, undefined, "MCP never invents canonical write authority");
	});

	it("delegates non-MCP routes unchanged through the wrapper", async () => {
		const response = await mcpWorker.fetch(new Request("https://madgrix.test/health"), {} as never);
		assert.equal(response.status, 200);
		assert.deepEqual(await response.json(), { ok: true, service: "madgrix", protocol: "git4agents" });
	});
});
