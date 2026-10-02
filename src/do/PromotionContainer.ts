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

interface PromotionRequest {
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

const PROMOTION_SCRIPT = String.raw`set -euo pipefail

WORK="/tmp/madgrix-${PERMIT_ID}"
rm -rf "$WORK"
mkdir -p "$WORK"
cd "$WORK"

git init -q
git config user.name "MADGRIX Promotion Authority"
git config user.email "promotion@madgrix.invalid"

git remote add source "$SOURCE_REMOTE"
git remote add destination "$DESTINATION_REMOTE"

git -c "http.extraHeader=Authorization: Bearer $DESTINATION_TOKEN" fetch -q --no-tags destination main
CURRENT_HEAD="$(git rev-parse FETCH_HEAD)"

git -c "http.extraHeader=Authorization: Bearer $SOURCE_TOKEN" fetch -q --no-tags source "$CANDIDATE_SHA"
FETCHED_CANDIDATE="$(git rev-parse FETCH_HEAD)"
if [ "$FETCHED_CANDIDATE" != "$CANDIDATE_SHA" ]; then
  echo "candidate SHA mismatch" >&2
  exit 45
fi

# MADGRIX tree-digest/v1:
# SHA256 over the concatenation, in Git ls-tree recursive byte order, of
#   mode NUL path NUL SHA256(blob-bytes) NUL
# for every blob in the exact candidate tree. Submodules are rejected in v1.
TREE_DIGEST="$(
  git ls-tree -rz --full-tree "$CANDIDATE_SHA" |
  while IFS= read -r -d '' entry; do
    meta="${entry%%$'\t'*}"
    path="${entry#*$'\t'}"
    mode="${meta%% *}"
    rest="${meta#* }"
    type="${rest%% *}"
    object="${rest##* }"
    if [ "$type" != "blob" ]; then
      echo "unsupported non-blob tree entry: $type $path" >&2
      exit 46
    fi
    blob_sha256="$(git cat-file blob "$object" | sha256sum | awk '{print $1}')"
    printf '%s\0%s\0%s\0' "$mode" "$path" "$blob_sha256"
  done | sha256sum | awk '{print $1}'
)"

if [ "$TREE_DIGEST" != "$WINNING_TREE_SHA256" ]; then
  printf 'TREE_DIGEST=%s\n' "$TREE_DIGEST"
  exit 43
fi

CANDIDATE_TREE="$(git rev-parse "$CANDIDATE_SHA^{tree}")"
export GIT_AUTHOR_NAME="MADGRIX Promotion Authority"
export GIT_AUTHOR_EMAIL="promotion@madgrix.invalid"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME"
export GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
export GIT_AUTHOR_DATE="$ISSUED_AT"
export GIT_COMMITTER_DATE="$ISSUED_AT"

PROMOTED_SHA="$(printf 'MADGRIX promotion %s\n' "$PERMIT_ID" | git commit-tree "$CANDIDATE_TREE" -p "$EXPECTED_HEAD")"

# Exactly-once effect reconciliation: a prior push may have succeeded while
# the Worker/DO finalization response was lost.
if [ "$CURRENT_HEAD" = "$PROMOTED_SHA" ]; then
  printf 'OUTCOME=ALREADY_WRITTEN\nPROMOTED_SHA=%s\nTREE_DIGEST=%s\nPARENT=%s\n' "$PROMOTED_SHA" "$TREE_DIGEST" "$EXPECTED_HEAD"
  exit 0
fi

if [ "$CURRENT_HEAD" != "$EXPECTED_HEAD" ]; then
  printf 'OUTCOME=EXPIRED_HEAD_MOVED\nCURRENT_HEAD=%s\n' "$CURRENT_HEAD"
  exit 42
fi

# Fast-forward push is our final compare-and-swap. If another writer advances
# main after the fetch, Git rejects the push and no stale state ships.
if ! git -c "http.extraHeader=Authorization: Bearer $DESTINATION_TOKEN" push -q destination "$PROMOTED_SHA:refs/heads/main"; then
  exit 44
fi

printf 'OUTCOME=PROMOTED\nPROMOTED_SHA=%s\nTREE_DIGEST=%s\nPARENT=%s\n' "$PROMOTED_SHA" "$TREE_DIGEST" "$EXPECTED_HEAD"
`;

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
		let body: PromotionRequest;
		try {
			body = (await request.json()) as PromotionRequest;
		} catch {
			return json({ error: "invalid_json" }, 400);
		}
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

		const container = this.state.container;
		if (!container) return json({ error: "promotion_container_not_configured" }, 500);
		if (!container.running) container.start({ enableInternet: true });

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
