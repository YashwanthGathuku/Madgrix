/**
 * Trusted promotion container.
 *
 * This Durable Object owns a Cloudflare Container with git installed and runs
 * one of three scripts in it. It is intentionally tiny: the Worker supplies
 * short-lived repo-scoped tokens and the exact SHAs; the scripts do the git
 * work; src/lib/git-promotion.ts maps each script's exit status and output to
 * the answer (specs/amendments/rebase-ancestry-v1.md).
 *
 * - promote (container/promote.sh): fast-forwards the destination's main to
 *   the reviewed candidate commit itself. It refuses unless the candidate's
 *   tree-digest/v1 equals the permit's, the destination head is still the
 *   permit-bound head (EXPIRED_HEAD_MOVED), and that head is an ancestor of
 *   the candidate (BASELINE_MISMATCH). No commit is created, so the promoted
 *   SHA is the reviewed SHA. The answer carries BASE (the permit-bound head)
 *   and PARENT (the candidate's own first parent, read from git). A retry is
 *   idempotent: if the candidate is already in the destination's history and
 *   descends from the permit-bound head, the answer is ALREADY_WRITTEN and the
 *   control plane can finish consuming the permit.
 * - rebase (container/rebase.sh): replays the contender's candidate onto a
 *   moved destination head and pushes the result to the contender's fork as a
 *   new commit (REBASED), or reports that the candidate already descends from
 *   the head (UP_TO_DATE), that the head already holds its changes
 *   (ALREADY_IN_DESTINATION), or the conflicting paths (CONFLICT). The rebased
 *   commit is a new candidate and is evaluated again before any permit.
 * - copy_baseline (container/copy-baseline.sh): seeds an empty fork with the
 *   frozen baseline commit when the Artifacts fork endpoint is unavailable.
 *
 * 409 answers are terminal for the request (the PromotionWorkflow does not
 * retry them; a permit stays unconsumed); 502 is a git failure, which a retry
 * may get past.
 */

import { promotionHttpResult, rebaseHttpResult } from "../lib/git-promotion.ts";

interface CopyBaselineRequest {
	action: "copy_baseline";
	op_id: string;
	source_remote: string;
	source_token: string;
	source_commit: string;
	destination_remote: string;
	destination_token: string;
}

interface RebaseRequest {
	action: "rebase";
	op_id: string;
	fork_remote: string;
	fork_token: string;
	candidate_sha: string;
	destination_remote: string;
	destination_token: string;
	onto: string;
}

interface PromotionRequest {
	action?: "promote";
	permit_id: string;
	source_remote: string;
	source_token: string;
	candidate_sha: string;
	destination_remote: string;
	destination_token: string;
	expected_destination_head: string;
	winning_tree_sha256: string;
	issued_at: string;
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function validHex(value: unknown, min = 7, max = 128): value is string {
	return typeof value === "string" && value.length >= min && value.length <= max && /^[0-9a-f]+$/i.test(value);
}

function validHttpsRemote(value: unknown): value is string {
	if (typeof value !== "string") return false;
	try {
		const u = new URL(value);
		return u.protocol === "https:" && u.hostname.endsWith(".artifacts.cloudflare.net");
	} catch {
		return false;
	}
}

function parseLines(stdout: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of stdout.split(/\r?\n/)) {
		const i = line.indexOf("=");
		if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
	}
	return out;
}

export class PromotionContainer {
	private state: DurableObjectState;

	constructor(state: DurableObjectState, _env: DurableObjectEnv) {
		this.state = state;
	}

	async fetch(request: Request): Promise<Response> {
		if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
		let raw: PromotionRequest | CopyBaselineRequest | RebaseRequest;
		try {
			raw = (await request.json()) as PromotionRequest | CopyBaselineRequest | RebaseRequest;
		} catch {
			return json({ error: "invalid_json" }, 400);
		}

		const container = this.state.container;
		if (!container) return json({ error: "promotion_container_not_configured" }, 500);
		if (!container.running) container.start({ enableInternet: true });

		const execScript = async (script: string, env: Record<string, string>) => {
			const proc = await container.exec([`/opt/madgrix/${script}`], { env });
			const output = await proc.output();
			const decoder = new TextDecoder();
			return {
				exitCode: output.exitCode,
				stdout: decoder.decode(output.stdout),
				stderr: decoder.decode(output.stderr),
			};
		};

		if (raw?.action === "copy_baseline") {
			const body = raw as CopyBaselineRequest;
			if (
				!validHex(body.op_id, 16) ||
				!validHex(body.source_commit) ||
				!validHttpsRemote(body.source_remote) ||
				!validHttpsRemote(body.destination_remote) ||
				typeof body.source_token !== "string" ||
				typeof body.destination_token !== "string"
			) {
				return json({ error: "invalid_copy_baseline_request" }, 400);
			}
			const output = await execScript("copy-baseline.sh", {
				OP_ID: body.op_id,
				SOURCE_REMOTE: body.source_remote,
				SOURCE_TOKEN: body.source_token,
				SOURCE_COMMIT: body.source_commit,
				DESTINATION_REMOTE: body.destination_remote,
				DESTINATION_TOKEN: body.destination_token,
			});
			const fields = parseLines(output.stdout);
			if (output.exitCode === 42) {
				return json({ error: "destination_not_empty", head: fields.HEAD }, 409);
			}
			if (output.exitCode !== 0) {
				return json({ error: "baseline_import_failed", detail: output.stderr.trim(), exit_code: output.exitCode }, 502);
			}
			return json({ outcome: fields.OUTCOME, head: fields.HEAD });
		}

		if (raw?.action === "rebase") {
			const body = raw as RebaseRequest;
			if (
				!validHex(body.op_id, 16) ||
				!/^[0-9a-f]+$/.test(body.op_id) ||
				!validHex(body.candidate_sha) ||
				!validHex(body.onto) ||
				!validHttpsRemote(body.fork_remote) ||
				!validHttpsRemote(body.destination_remote) ||
				typeof body.fork_token !== "string" ||
				typeof body.destination_token !== "string"
			) {
				return json({ error: "invalid_rebase_request" }, 400);
			}
			const output = await execScript("rebase.sh", {
				OP_ID: body.op_id,
				FORK_REMOTE: body.fork_remote,
				FORK_TOKEN: body.fork_token,
				CANDIDATE_SHA: body.candidate_sha,
				DESTINATION_REMOTE: body.destination_remote,
				DESTINATION_TOKEN: body.destination_token,
				ONTO: body.onto,
			});
			const result = rebaseHttpResult(output.exitCode, output.stdout, output.stderr);
			return json(result.body, result.status);
		}

		const body = raw as PromotionRequest;
		if (
			!body ||
			!validHex(body.permit_id, 32) ||
			!validHex(body.candidate_sha) ||
			!validHex(body.expected_destination_head) ||
			!validHex(body.winning_tree_sha256, 64, 64) ||
			!validHttpsRemote(body.source_remote) ||
			!validHttpsRemote(body.destination_remote) ||
			typeof body.source_token !== "string" ||
			typeof body.destination_token !== "string" ||
			typeof body.issued_at !== "string"
		) {
			return json({ error: "invalid_promotion_request" }, 400);
		}

		const output = await execScript("promote.sh", {
			PERMIT_ID: body.permit_id,
			SOURCE_REMOTE: body.source_remote,
			SOURCE_TOKEN: body.source_token,
			CANDIDATE_SHA: body.candidate_sha,
			DESTINATION_REMOTE: body.destination_remote,
			DESTINATION_TOKEN: body.destination_token,
			EXPECTED_HEAD: body.expected_destination_head,
			WINNING_TREE_SHA256: body.winning_tree_sha256,
			ISSUED_AT: body.issued_at,
		});
		const result = promotionHttpResult(output.exitCode, output.stdout, output.stderr);
		return json(result.body, result.status);
	}
}
