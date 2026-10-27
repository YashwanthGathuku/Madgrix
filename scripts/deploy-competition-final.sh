#!/usr/bin/env bash
set -Eeuo pipefail

# Final Cloudflare competition deployment for MADGRIX.
#
# This script intentionally deploys only a clean checkout that exactly matches
# origin/grok/final-live, then proves the judge-facing run-4 Mission Control is
# public, MCP is live with agent-safe tools, and other task graphs remain
# authenticated.
#
# Requirements: Linux/WSL, Node >= 24, git, curl, cf CLI authenticated to the
# Cloudflare account that already hosts the `madgrix` Worker and its secrets.

DEPLOY_BRANCH="${MADGRIX_DEPLOY_BRANCH:-grok/final-live}"
WORKER_NAME="${MADGRIX_WORKER_NAME:-madgrix}"
BASE_URL="${MADGRIX_BASE_URL:-https://madgrix.ygathuku96.workers.dev}"
PUBLIC_TASK_ID="task_79b1f9d610e94d8e95daa503"
PROMOTED_SHA="d55332b544992a2e033ca03fa54972c5283eef73"
MCP_PROTOCOL_VERSION="2026-07-28"
REQUIRED_SECRETS=(
  CONTROL_SERVICE_TOKEN
  AGENT_SERVICE_TOKEN
  EVALUATION_SERVICE_TOKEN
  AUTHORITY_SIGNING_KEY
)

fail() {
  printf 'DEPLOY BLOCKED: %s\n' "$*" >&2
  exit 1
}

note() {
  printf '\n==> %s\n' "$*" >&2
}

check_required_secret_names() {
  local output
  output="$(cf workers secrets list --script-name "$WORKER_NAME" 2>&1)" || {
    printf '%s\n' "$output" >&2
    fail "could not list secret names for Worker $WORKER_NAME"
  }
  for secret in "${REQUIRED_SECRETS[@]}"; do
    grep -Fq "$secret" <<<"$output" || fail "required Worker secret name is missing: $secret"
  done
  printf 'required secret names: present (%s)\n' "${#REQUIRED_SECRETS[@]}"
}

for bin in git node curl cf; do
  command -v "$bin" >/dev/null 2>&1 || fail "$bin is not on PATH"
done

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || fail "run this inside the MADGRIX repository"
cd "$ROOT"

CURRENT_BRANCH="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
[[ "$CURRENT_BRANCH" == "$DEPLOY_BRANCH" ]] || fail "checkout $DEPLOY_BRANCH first (current: ${CURRENT_BRANCH:-detached})"

git diff --quiet || fail "working tree has unstaged changes"
git diff --cached --quiet || fail "index has staged changes"
[[ -z "$(git ls-files --others --exclude-standard)" ]] || fail "working tree has untracked files; move or commit them before final deploy"

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
(( NODE_MAJOR >= 24 )) || fail "Node 24+ is required for the recorded competition suite (found $(node --version))"

note "Refreshing the exact competition branch"
git fetch --quiet origin "$DEPLOY_BRANCH"
LOCAL_HEAD="$(git rev-parse HEAD)"
REMOTE_HEAD="$(git rev-parse "origin/$DEPLOY_BRANCH")"
[[ "$LOCAL_HEAD" == "$REMOTE_HEAD" ]] || fail "local HEAD $LOCAL_HEAD is not origin/$DEPLOY_BRANCH $REMOTE_HEAD"
printf 'Deploy candidate: %s @ %s\n' "$DEPLOY_BRANCH" "$LOCAL_HEAD"

note "Checking Cloudflare authentication, queue visibility, and required secret names"
cf auth whoami >/dev/null
cf queues list >/dev/null
check_required_secret_names

note "Cloudflare dry-run (build + configuration validation; no upload)"
cf deploy --dry-run

note "Deploying exact competition tree"
printf 'The cf CLI may ask you to confirm the plan. Review it and approve only if the Worker is %s.\n' "$WORKER_NAME" >&2
cf deploy \
  --message "Cloudflare Git competition final ${LOCAL_HEAD}" \
  --tag "competition-final" \
  --containers-rollout immediate

note "Confirming required secret bindings still exist after deployment"
check_required_secret_names

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

note "Checking Worker health"
HEALTH_STATUS="$(curl -sS -o "$TMP_DIR/health" -w '%{http_code}' "$BASE_URL/health")"
[[ "$HEALTH_STATUS" == "200" ]] || fail "/health returned HTTP $HEALTH_STATUS"
printf 'health: HTTP %s\n' "$HEALTH_STATUS"

note "Checking stateless MCP discovery on the deployed Worker"
MCP_DISCOVER_STATUS="$(curl -sS -o "$TMP_DIR/mcp-discover" -w '%{http_code}' \
  -X POST "$BASE_URL/mcp" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  -H "MCP-Protocol-Version: $MCP_PROTOCOL_VERSION" \
  -H 'Mcp-Method: server/discover' \
  --data '{"jsonrpc":"2.0","id":1,"method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}')"
[[ "$MCP_DISCOVER_STATUS" == "200" ]] || fail "MCP server/discover returned HTTP $MCP_DISCOVER_STATUS"
grep -Fq '"2026-07-28"' "$TMP_DIR/mcp-discover" || fail "MCP discovery does not advertise 2026-07-28"
grep -Fq '"resultType":"complete"' "$TMP_DIR/mcp-discover" || fail "MCP discovery is missing the modern complete result discriminator"
grep -Fq '"io.modelcontextprotocol/serverInfo"' "$TMP_DIR/mcp-discover" || fail "MCP discovery is missing server identity metadata"
printf 'mcp discovery: HTTP %s\n' "$MCP_DISCOVER_STATUS"

note "Checking deployed MCP tool surface is agent-safe"
MCP_TOOLS_STATUS="$(curl -sS -o "$TMP_DIR/mcp-tools" -w '%{http_code}' \
  -X POST "$BASE_URL/mcp" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  -H "MCP-Protocol-Version: $MCP_PROTOCOL_VERSION" \
  -H 'Mcp-Method: tools/list' \
  --data '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}')"
[[ "$MCP_TOOLS_STATUS" == "200" ]] || fail "MCP tools/list returned HTTP $MCP_TOOLS_STATUS"
for tool in inspect_task inspect_work_graph check_clearance claim_work open_contender read_ledger verify_permit; do
  grep -Fq "\"name\":\"$tool\"" "$TMP_DIR/mcp-tools" || fail "deployed MCP tool is missing: $tool"
done
for forbidden in promote verdict evidence composition rebase finalize issue_permit; do
  if grep -Fq "\"name\":\"$forbidden\"" "$TMP_DIR/mcp-tools"; then
    fail "privileged operation unexpectedly exposed as MCP tool: $forbidden"
  fi
done
printf 'mcp tools: HTTP %s · 7 agent-safe tools · no privileged canonical-write tool\n' "$MCP_TOOLS_STATUS"

note "Checking root exposes the configured read-only demo"
ROOT_STATUS="$(curl -sS -o "$TMP_DIR/root" -w '%{http_code}' "$BASE_URL/")"
[[ "$ROOT_STATUS" == "200" ]] || fail "/ returned HTTP $ROOT_STATUS"
grep -Fq "$PUBLIC_TASK_ID" "$TMP_DIR/root" || fail "root page does not link the configured public demo task"

note "Checking live run-4 MADGRIX Mission Control"
GRAPH_URL="$BASE_URL/tasks/$PUBLIC_TASK_ID/graph"
GRAPH_STATUS="$(curl -sS -o "$TMP_DIR/graph" -w '%{http_code}' "$GRAPH_URL")"
[[ "$GRAPH_STATUS" == "200" ]] || fail "public Mission Control returned HTTP $GRAPH_STATUS"

grep -Fq 'MADGRIX Mission Control' "$TMP_DIR/graph" || fail "Mission Control heading is missing"
grep -Fq "$PUBLIC_TASK_ID" "$TMP_DIR/graph" || fail "run-4 task id is missing from Mission Control"
grep -Fq "$PROMOTED_SHA" "$TMP_DIR/graph" || fail "recorded run-4 promoted SHA is missing from Mission Control"
grep -Fq 'Why canonical?' "$TMP_DIR/graph" || fail "WHY CANONICAL section is missing"
grep -Fq 'WHAT WAS AUTHORIZED = WHAT WAS SHIPPED' "$TMP_DIR/graph" || fail "exact-state authorization/shipping equality is not shown"
printf 'mission control: HTTP %s\n%s\n' "$GRAPH_STATUS" "$GRAPH_URL"

note "Checking that only the configured demo task is public"
PRIVATE_PROBE="task_not_public_$(date +%s)_$$"
PRIVATE_STATUS="$(curl -sS -o "$TMP_DIR/private" -w '%{http_code}' "$BASE_URL/tasks/$PRIVATE_PROBE/graph")"
[[ "$PRIVATE_STATUS" == "401" ]] || fail "non-demo graph returned HTTP $PRIVATE_STATUS instead of 401"
printf 'non-demo graph auth boundary: HTTP %s\n' "$PRIVATE_STATUS"

note "FINAL DEPLOYMENT VERIFIED"
printf 'branch: %s\ncommit: %s\nworker: %s\nmcp: %s/mcp\npublic demo: %s\n' \
  "$DEPLOY_BRANCH" "$LOCAL_HEAD" "$BASE_URL" "$BASE_URL" "$GRAPH_URL"
