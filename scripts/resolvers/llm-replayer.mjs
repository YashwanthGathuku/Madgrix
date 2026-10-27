#!/usr/bin/env node
/**
 * LLM replayer for the replay rung (scripts/resolvers/replay-resolver.mjs).
 *
 * Reads one madgrix-replay-request/v1 on stdin and prints the replacement
 * text for that hunk: the TARGET side's version rewritten so it also carries
 * out the SOURCE side's intent. The model's answer is untrusted: the lease
 * bounds where it lands and the witness gate decides whether it is admitted.
 *
 * Providers (LLM_PROVIDER):
 *   anthropic   ANTHROPIC_API_KEY, LLM_MODEL          (Messages API)
 *   workers-ai  WORKERS_AI_ACCOUNT_ID, WORKERS_AI_API_TOKEN, LLM_MODEL
 *               (use a token scoped to Workers AI only; never an account-wide
 *               Cloudflare token: docs/SECURITY.md, process-env boundaries)
 * LLM_BASE_URL overrides the provider's base URL (tests point it at a local
 * server). There is no default model: LLM_MODEL must name one.
 */

import { readFileSync } from "node:fs";

const REQUEST_FORMAT = "madgrix-replay-request/v1";

/**
 * @param {{ path: string, hunk_index: number | null, base: string, target: { agent_id: string, intent: string, text: string }, source: { agent_id: string, intent: string, text: string }, context: { before: string, after: string } }} req
 */
export function replayPrompt(req) {
	const where = req.hunk_index === null ? `the whole file ${req.path}` : `conflicted region #${req.hunk_index} of ${req.path}`;
	return [
		`Two agents changed the same lines in ${where}. You will produce the merged text for that region only.`,
		"",
		`TARGET (agent ${req.target.agent_id}) — keep everything this version does. Its stated intent: ${req.target.intent}`,
		"<target>",
		req.target.text,
		"</target>",
		"",
		`SOURCE (agent ${req.source.agent_id}) — re-apply this agent's intent onto the TARGET. Its stated intent: ${req.source.intent}`,
		"The region before either change:",
		"<base>",
		req.base,
		"</base>",
		"The SOURCE agent's version of the region:",
		"<source>",
		req.source.text,
		"</source>",
		"",
		"Unchanged lines just before and after the region (context only; do not repeat them):",
		"<before>",
		req.context.before,
		"</before>",
		"<after>",
		req.context.after,
		"</after>",
		"",
		"Rewrite the TARGET region so that it also carries out the SOURCE intent, without dropping anything the TARGET does.",
		"Reply with only the new region text between <resolution> and </resolution>. No explanation.",
	].join("\n");
}

/**
 * The text between <resolution> tags, newline-normalised to match the
 * request's base: if the base region ended with a newline, so does the answer.
 *
 * @param {string} answer
 * @param {{ base: string, target: { text: string } }} req
 */
export function parseResolution(answer, req) {
	const m = answer.match(/<resolution>\n?([\s\S]*?)<\/resolution>/);
	if (!m) throw new Error("model answer has no <resolution> block");
	let text = m[1];
	const wantsNewline = (req.target.text || req.base).endsWith("\n");
	if (wantsNewline && !text.endsWith("\n")) text += "\n";
	return text;
}

/**
 * @param {string} prompt
 * @param {Record<string, string | undefined>} env
 * @param {typeof fetch} [doFetch]
 */
export async function callModel(prompt, env, doFetch = fetch) {
	const provider = env.LLM_PROVIDER;
	const model = env.LLM_MODEL;
	if (!model) throw new Error("LLM_MODEL is required");
	const system = "You resolve merge conflicts by re-applying one change's intent onto another version. Output only what is asked.";
	if (provider === "anthropic") {
		if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is required");
		const base = env.LLM_BASE_URL || "https://api.anthropic.com";
		const res = await doFetch(`${base}/v1/messages`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-api-key": env.ANTHROPIC_API_KEY,
				"anthropic-version": "2023-06-01",
			},
			body: JSON.stringify({ model, max_tokens: 4096, temperature: 0, system, messages: [{ role: "user", content: prompt }] }),
		});
		if (!res.ok) throw new Error(`model call failed: HTTP ${res.status}`);
		const body = /** @type {{ content?: Array<{ type: string, text?: string }> }} */ (await res.json());
		return (body.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
	}
	if (provider === "workers-ai") {
		if (!env.WORKERS_AI_ACCOUNT_ID || !env.WORKERS_AI_API_TOKEN) {
			throw new Error("WORKERS_AI_ACCOUNT_ID and WORKERS_AI_API_TOKEN are required");
		}
		const base = env.LLM_BASE_URL || "https://api.cloudflare.com";
		const res = await doFetch(`${base}/client/v4/accounts/${env.WORKERS_AI_ACCOUNT_ID}/ai/run/${model}`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${env.WORKERS_AI_API_TOKEN}` },
			body: JSON.stringify({
				temperature: 0,
				messages: [
					{ role: "system", content: system },
					{ role: "user", content: prompt },
				],
			}),
		});
		if (!res.ok) throw new Error(`model call failed: HTTP ${res.status}`);
		const body = /** @type {{ result?: { response?: string } }} */ (await res.json());
		return body.result?.response ?? "";
	}
	throw new Error("LLM_PROVIDER must be anthropic or workers-ai");
}

async function main() {
	const req = JSON.parse(readFileSync(0, "utf8"));
	if (req.format !== REQUEST_FORMAT) throw new Error(`expected ${REQUEST_FORMAT}`);
	const answer = await callModel(replayPrompt(req), process.env);
	process.stdout.write(parseResolution(answer, req));
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((error) => {
		console.error(`llm replayer: ${/** @type {Error} */ (error).message}`);
		process.exit(1);
	});
}
