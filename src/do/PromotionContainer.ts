/**
 * Trusted promotion container.
 *
 * This Durable Object owns a Cloudflare Container with git installed. It is
 * intentionally tiny: the Worker supplies two short-lived repo-scoped tokens,
 * the exact candidate SHA, the exact expected destination HEAD, and the
 * permit-bound tree digest. The container creates a deterministic commit whose
 * tree is exactly the reviewed candidate tree and whose single parent is the
 * permit's expected destination HEAD, then pushes that commit to main.
 *
 * A retry is idempotent: if the destination already equals the deterministic
 * promotion commit, the operation reports ALREADY_WRITTEN and the control plane
 * can finish consuming the permit.
 */

interface CopyBaselineRequest {
	action: "copy_baseline";
	op_id: string;
	source_remote: string;
	source_token: string;
	source_commit: string;
	destination_remote: string;
	destination_token: string;
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

interface PromotionResult {
	outcome: "PROMOTED" | "ALREADY_WRITTEN" | "EXPIRED_HEAD_MOVED" | "TREE_MISMATCH" | "GIT_ERROR";
	promoted_sha?: string;
	tree_sha256?: string;
	parent?: string;
	detail?: string;
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function validHex(value: string, min = 7, max = 128): boolean {
	return value.length >= min && value.length <= max && /^[0-9a-f]+$/i.test(value);
}

function validHttpsRemote(value: string): boolean {
	try {
		const u = new URL(value);
		return u.protocol === "https:" && u.hostname.endsWith(".artifacts.cloudflare.net");
	} catch {
		return false;
	}
}

const PROMOTION_SCRIPT = atob("c2V0IC1ldW8gcGlwZWZhaWwKCldPUks9Ii90bXAvbWFkZ3JpeC0ke1BFUk1JVF9JRH0iCnJtIC1yZiAiJFdPUksiCm1rZGlyIC1wICIkV09SSyIKY2QgIiRXT1JLIgoKZ2l0IGluaXQgLXEKZ2l0IGNvbmZpZyB1c2VyLm5hbWUgIk1BREdSSVggUHJvbW90aW9uIEF1dGhvcml0eSIKZ2l0IGNvbmZpZyB1c2VyLmVtYWlsICJwcm9tb3Rpb25AbWFkZ3JpeC5pbnZhbGlkIgoKZ2l0IHJlbW90ZSBhZGQgc291cmNlICIkU09VUkNFX1JFTU9URSIKZ2l0IHJlbW90ZSBhZGQgZGVzdGluYXRpb24gIiRERVNUSU5BVElPTl9SRU1PVEUiCgpnaXQgLWMgImh0dHAuZXh0cmFIZWFkZXI9QXV0aG9yaXphdGlvbjogQmVhcmVyICRERVNUSU5BVElPTl9UT0tFTiIgZmV0Y2ggLXEgLS1uby10YWdzIGRlc3RpbmF0aW9uIG1haW4KQ1VSUkVOVF9IRUFEPSIkKGdpdCByZXYtcGFyc2UgRkVUQ0hfSEVBRCkiCgpnaXQgLWMgImh0dHAuZXh0cmFIZWFkZXI9QXV0aG9yaXphdGlvbjogQmVhcmVyICRTT1VSQ0VfVE9LRU4iIGZldGNoIC1xIC0tbm8tdGFncyBzb3VyY2UgIiRDQU5ESURBVEVfU0hBIgpGRVRDSEVEX0NBTkRJREFURT0iJChnaXQgcmV2LXBhcnNlIEZFVENIX0hFQUQpIgppZiBbICIkRkVUQ0hFRF9DQU5ESURBVEUiICE9ICIkQ0FORElEQVRFX1NIQSIgXTsgdGhlbgogIGVjaG8gImNhbmRpZGF0ZSBTSEEgbWlzbWF0Y2giID4mMgogIGV4aXQgNDUKZmkKCiMgTUFER1JJWCB0cmVlLWRpZ2VzdC92MToKIyBTSEEyNTYgb3ZlciB0aGUgY29uY2F0ZW5hdGlvbiwgaW4gR2l0IGxzLXRyZWUgcmVjdXJzaXZlIGJ5dGUgb3JkZXIsIG9mCiMgICBtb2RlIE5VTCBwYXRoIE5VTCBTSEEyNTYoYmxvYi1ieXRlcykgTlVMCiMgZm9yIGV2ZXJ5IGJsb2IgaW4gdGhlIGV4YWN0IGNhbmRpZGF0ZSB0cmVlLiBTdWJtb2R1bGVzIGFyZSByZWplY3RlZCBpbiB2MS4KVFJFRV9ESUdFU1Q9IiQoCiAgZ2l0IGxzLXRyZWUgLXJ6IC0tZnVsbC10cmVlICIkQ0FORElEQVRFX1NIQSIgfAogIHdoaWxlIElGUz0gcmVhZCAtciAtZCAnJyBlbnRyeTsgZG8KICAgIG1ldGE9IiR7ZW50cnklJSQnXHQnKn0iCiAgICBwYXRoPSIke2VudHJ5IyokJ1x0J30iCiAgICBtb2RlPSIke21ldGElJSAqfSIKICAgIHJlc3Q9IiR7bWV0YSMqIH0iCiAgICB0eXBlPSIke3Jlc3QlJSAqfSIKICAgIG9iamVjdD0iJHtyZXN0IyMqIH0iCiAgICBpZiBbICIkdHlwZSIgIT0gImJsb2IiIF07IHRoZW4KICAgICAgZWNobyAidW5zdXBwb3J0ZWQgbm9uLWJsb2IgdHJlZSBlbnRyeTogJHR5cGUgJHBhdGgiID4mMgogICAgICBleGl0IDQ2CiAgICBmaQogICAgYmxvYl9zaGEyNTY9IiQoZ2l0IGNhdC1maWxlIGJsb2IgIiRvYmplY3QiIHwgc2hhMjU2c3VtIHwgYXdrICd7cHJpbnQgJDF9JykiCiAgICBwcmludGYgJyVzXDAlc1wwJXNcMCcgIiRtb2RlIiAiJHBhdGgiICIkYmxvYl9zaGEyNTYiCiAgZG9uZSB8IHNoYTI1NnN1bSB8IGF3ayAne3ByaW50ICQxfScKKSIKCmlmIFsgIiRUUkVFX0RJR0VTVCIgIT0gIiRXSU5OSU5HX1RSRUVfU0hBMjU2IiBdOyB0aGVuCiAgcHJpbnRmICdUUkVFX0RJR0VTVD0lc1xuJyAiJFRSRUVfRElHRVNUIgogIGV4aXQgNDMKZmkKCkNBTkRJREFURV9UUkVFPSIkKGdpdCByZXYtcGFyc2UgIiRDQU5ESURBVEVfU0hBXnt0cmVlfSIpIgpleHBvcnQgR0lUX0FVVEhPUl9OQU1FPSJNQURHUklYIFByb21vdGlvbiBBdXRob3JpdHkiCmV4cG9ydCBHSVRfQVVUSE9SX0VNQUlMPSJwcm9tb3Rpb25AbWFkZ3JpeC5pbnZhbGlkIgpleHBvcnQgR0lUX0NPTU1JVFRFUl9OQU1FPSIkR0lUX0FVVEhPUl9OQU1FIgpleHBvcnQgR0lUX0NPTU1JVFRFUl9FTUFJTD0iJEdJVF9BVVRIT1JfRU1BSUwiCmV4cG9ydCBHSVRfQVVUSE9SX0RBVEU9IiRJU1NVRURfQVQiCmV4cG9ydCBHSVRfQ09NTUlUVEVSX0RBVEU9IiRJU1NVRURfQVQiCgpQUk9NT1RFRF9TSEE9IiQocHJpbnRmICdNQURHUklYIHByb21vdGlvbiAlc1xuJyAiJFBFUk1JVF9JRCIgfCBnaXQgY29tbWl0LXRyZWUgIiRDQU5ESURBVEVfVFJFRSIgLXAgIiRFWFBFQ1RFRF9IRUFEIikiCgppZiBbICIkQ1VSUkVOVF9IRUFEIiA9ICIkUFJPTU9URURfU0hBIiBdOyB0aGVuCiAgcHJpbnRmICdPVVRDT01FPUFMUkVBRFlfV1JJVFRFTlxuUFJPTU9URURfU0hBPSVzXG5UUkVFX0RJR0VTVD0lc1xuUEFSRU5UPSVzXG4nICIkUFJPTU9URURfU0hBIiAiJFRSRUVfRElHRVNUIiAiJEVYUEVDVEVEX0hFQUQiCiAgZXhpdCAwCmZpCgppZiBbICIkQ1VSUkVOVF9IRUFEIiAhPSAiJEVYUEVDVEVEX0hFQUQiIF07IHRoZW4KICBwcmludGYgJ09VVENPTUU9RVhQSVJFRF9IRUFEX01PVkVEXG5DVVJSRU5UX0hFQUQ9JXNcbicgIiRDVVJSRU5UX0hFQUQiCiAgZXhpdCA0MgpmaQoKaWYgISBnaXQgLWMgImh0dHAuZXh0cmFIZWFkZXI9QXV0aG9yaXphdGlvbjogQmVhcmVyICRERVNUSU5BVElPTl9UT0tFTiIgcHVzaCAtcSBkZXN0aW5hdGlvbiAiJFBST01PVEVEX1NIQTpyZWZzL2hlYWRzL21haW4iOyB0aGVuCiAgZXhpdCA0NApmaQoKcHJpbnRmICdPVVRDT01FPVBST01PVEVEXG5QUk9NT1RFRF9TSEE9JXNcblRSRUVfRElHRVNUPSVzXG5QQVJFTlQ9JXNcbicgIiRQUk9NT1RFRF9TSEEiICIkVFJFRV9ESUdFU1QiICIkRVhQRUNURURfSEVBRCIK");
const COPY_BASELINE_SCRIPT = atob("c2V0IC1ldW8gcGlwZWZhaWwKV09SSz0iL3RtcC9tYWRncml4LWZvcmstJHtPUF9JRH0iCnJtIC1yZiAiJFdPUksiCm1rZGlyIC1wICIkV09SSyIKY2QgIiRXT1JLIgpnaXQgaW5pdCAtcQpnaXQgcmVtb3RlIGFkZCBzb3VyY2UgIiRTT1VSQ0VfUkVNT1RFIgpnaXQgcmVtb3RlIGFkZCBkZXN0aW5hdGlvbiAiJERFU1RJTkFUSU9OX1JFTU9URSIKCmdpdCAtYyAiaHR0cC5leHRyYUhlYWRlcj1BdXRob3JpemF0aW9uOiBCZWFyZXIgJFNPVVJDRV9UT0tFTiIgZmV0Y2ggLXEgLS1uby10YWdzIHNvdXJjZSAiJFNPVVJDRV9DT01NSVQiCkZFVENIRUQ9IiQoZ2l0IHJldi1wYXJzZSBGRVRDSF9IRUFEKSIKaWYgWyAiJEZFVENIRUQiICE9ICIkU09VUkNFX0NPTU1JVCIgXTsgdGhlbgogIGVjaG8gInNvdXJjZSBjb21taXQgbWlzbWF0Y2giID4mMgogIGV4aXQgNDUKZmkKCiMgSWYgYSByZXRyeSBvYnNlcnZlcyB0aGUgZXhhY3QgaW1wb3J0ZWQgYmFzZWxpbmUsIGNvbnZlcmdlIHdpdGhvdXQgYW5vdGhlciBwdXNoLgpzZXQgK2UKZ2l0IC1jICJodHRwLmV4dHJhSGVhZGVyPUF1dGhvcml6YXRpb246IEJlYXJlciAkREVTVElOQVRJT05fVE9LRU4iIGZldGNoIC1xIC0tbm8tdGFncyBkZXN0aW5hdGlvbiBtYWluCkRFU1RfRkVUQ0g9JD8Kc2V0IC1lCmlmIFsgIiRERVNUX0ZFVENIIiAtZXEgMCBdOyB0aGVuCiAgQ1VSUkVOVD0iJChnaXQgcmV2LXBhcnNlIEZFVENIX0hFQUQpIgogIGlmIFsgIiRDVVJSRU5UIiA9ICIkU09VUkNFX0NPTU1JVCIgXTsgdGhlbgogICAgcHJpbnRmICdPVVRDT01FPUFMUkVBRFlfSU1QT1JURURcbkhFQUQ9JXNcbicgIiRDVVJSRU5UIgogICAgZXhpdCAwCiAgZmkKICBwcmludGYgJ09VVENPTUU9REVTVElOQVRJT05fTk9UX0VNUFRZXG5IRUFEPSVzXG4nICIkQ1VSUkVOVCIKICBleGl0IDQyCmZpCgpnaXQgLWMgImh0dHAuZXh0cmFIZWFkZXI9QXV0aG9yaXphdGlvbjogQmVhcmVyICRERVNUSU5BVElPTl9UT0tFTiIgcHVzaCAtcSBkZXN0aW5hdGlvbiAiJFNPVVJDRV9DT01NSVQ6cmVmcy9oZWFkcy9tYWluIgpwcmludGYgJ09VVENPTUU9SU1QT1JURURcbkhFQUQ9JXNcbicgIiRTT1VSQ0VfQ09NTUlUIgo=");

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
		let raw: PromotionRequest | CopyBaselineRequest;
		try {
			raw = (await request.json()) as PromotionRequest | CopyBaselineRequest;
		} catch {
			return json({ error: "invalid_json" }, 400);
		}

		const container = this.state.container;
		if (!container) return json({ error: "promotion_container_not_configured" }, 500);
		if (!container.running) container.start({ enableInternet: true });

		if (raw.action === "copy_baseline") {
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
			const proc = await container.exec(["bash", "-lc", COPY_BASELINE_SCRIPT], {
				env: {
					OP_ID: body.op_id,
					SOURCE_REMOTE: body.source_remote,
					SOURCE_TOKEN: body.source_token,
					SOURCE_COMMIT: body.source_commit,
					DESTINATION_REMOTE: body.destination_remote,
					DESTINATION_TOKEN: body.destination_token,
				},
			});
			const output = await proc.output();
			const decoder = new TextDecoder();
			const stdout = decoder.decode(output.stdout);
			const stderr = decoder.decode(output.stderr);
			const fields = parseLines(stdout);
			if (output.exitCode === 42) {
				return json({ error: "destination_not_empty", head: fields.HEAD }, 409);
			}
			if (output.exitCode !== 0) {
				return json({ error: "baseline_import_failed", detail: stderr.trim(), exit_code: output.exitCode }, 502);
			}
			return json({ outcome: fields.OUTCOME, head: fields.HEAD });
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

		const proc = await container.exec(["bash", "-lc", PROMOTION_SCRIPT], {
			env: {
				PERMIT_ID: body.permit_id,
				SOURCE_REMOTE: body.source_remote,
				SOURCE_TOKEN: body.source_token,
				CANDIDATE_SHA: body.candidate_sha,
				DESTINATION_REMOTE: body.destination_remote,
				DESTINATION_TOKEN: body.destination_token,
				EXPECTED_HEAD: body.expected_destination_head,
				WINNING_TREE_SHA256: body.winning_tree_sha256,
				ISSUED_AT: body.issued_at,
			},
		});
		const output = await proc.output();
		const decoder = new TextDecoder();
		const stdout = decoder.decode(output.stdout);
		const stderr = decoder.decode(output.stderr);
		const fields = parseLines(stdout);

		if (output.exitCode === 42) {
			return json({
				outcome: "EXPIRED_HEAD_MOVED",
				detail: fields.CURRENT_HEAD ?? stderr.trim(),
			} satisfies PromotionResult, 409);
		}
		if (output.exitCode === 43) {
			return json({
				outcome: "TREE_MISMATCH",
				tree_sha256: fields.TREE_DIGEST,
				detail: "candidate tree digest does not match the permit",
			} satisfies PromotionResult, 409);
		}
		if (output.exitCode !== 0) {
			return json({
				outcome: "GIT_ERROR",
				detail: stderr.trim() || `git promotion failed with exit ${output.exitCode}`,
			} satisfies PromotionResult, 502);
		}

		const outcome = fields.OUTCOME;
		if (outcome !== "PROMOTED" && outcome !== "ALREADY_WRITTEN") {
			return json({ outcome: "GIT_ERROR", detail: "promotion container returned no valid outcome" } satisfies PromotionResult, 502);
		}
		return json({
			outcome,
			promoted_sha: fields.PROMOTED_SHA,
			tree_sha256: fields.TREE_DIGEST,
			parent: fields.PARENT,
		} satisfies PromotionResult);
	}
}
