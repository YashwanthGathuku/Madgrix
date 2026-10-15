# MADGRIX MCP agent interface

MADGRIX exposes a stateless Model Context Protocol endpoint at:

```text
POST /mcp
```

The endpoint is an **adapter over MADGRIX's existing Worker API**, not a second authority plane. MCP tool calls are converted to internal HTTP requests and delegated through the same handlers used by REST. Existing bearer authentication, `X-Madgrix-Agent-Secret` binding, WorkClaims, evaluator isolation, Verdict Seam, exact-state permits and canonical promotion authority remain the source of truth.

## Why MCP exists

Coding agents should not need a MADGRIX-specific SDK before they can participate. MCP gives compatible clients a discoverable set of agent-safe operations while preserving the platform's central invariant:

> An agent may produce contender state, but it never receives canonical write authority.

The same endpoint serves the current `2026-07-28` stateless MCP era and legacy initialize-era clients.

## Agent-safe tools

| Tool | Purpose | Authority effect |
| --- | --- | --- |
| `inspect_task` | Read the frozen task, claims, contenders, conflicts and composition context | None; normal task-context auth still applies |
| `inspect_work_graph` | Read the structured canonical WorkGraph | None; only the configured public demo task is anonymous |
| `check_clearance` | Summarize stored WorkClaim conflict reports as `CLEAR`, `CAUTION`, `HOLD` or `REVIEW` | Advisory only; never grants authority |
| `claim_work` | Register intent, baseline, scope, contracts, interfaces, schema changes, expected tests and lease before coding | Creates the existing WorkClaim through the normal agent route |
| `open_contender` | Create the authenticated agent's isolated Cloudflare Artifacts contender fork | Returns only the existing short-lived contender/fork credential; never a canonical token |
| `read_ledger` | Read the task authority's append-only hash-chained ledger | None |
| `verify_permit` | Check a stored exact-state permit against its bound fields and current destination HEAD | Read/check only; does not issue or consume a permit |

## Deliberately absent

MADGRIX does **not** expose the following as MCP agent tools:

```text
promote
verdict
evidence submission
composition authority
rebase authority
finalize
issue_permit
canonical write
```

Those operations remain in their existing trust domains. An MCP client therefore cannot turn convenience into privilege escalation.

## Modern discovery

A `2026-07-28` client can discover the endpoint with `server/discover`:

```bash
curl -sS https://madgrix.ygathuku96.workers.dev/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'Mcp-Method: server/discover' \
  --data '{
    "jsonrpc":"2.0",
    "id":1,
    "method":"server/discover",
    "params":{
      "_meta":{
        "io.modelcontextprotocol/protocolVersion":"2026-07-28",
        "io.modelcontextprotocol/clientCapabilities":{}
      }
    }
  }'
```

The server advertises the supported modern protocol, tool capability and MADGRIX instructions. Modern completed responses include the wire-level `resultType: "complete"` discriminator and server identity in `_meta`.

## List tools

```bash
curl -sS https://madgrix.ygathuku96.workers.dev/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'Mcp-Method: tools/list' \
  --data '{
    "jsonrpc":"2.0",
    "id":2,
    "method":"tools/list",
    "params":{
      "_meta":{
        "io.modelcontextprotocol/protocolVersion":"2026-07-28",
        "io.modelcontextprotocol/clientCapabilities":{}
      }
    }
  }'
```

## Authentication model

MCP does not invent another credential system.

For governed task operations, send the same normal service bearer token that the REST route requires:

```text
Authorization: Bearer <agent-service-token>
```

Operations bound to an enrolled agent identity, such as `claim_work` and `open_contender`, also preserve the existing agent-secret check:

```text
X-Madgrix-Agent-Secret: <agent-secret>
```

Do not place the agent secret inside tool arguments, task text, logs or video captures.

`open_contender` may return a short-lived Cloudflare Artifacts fork credential because that is already the behavior of the underlying contender route. Treat it as sensitive and do not log it. It is scoped to the contender workspace and is not canonical write authority.

## Semantic clearance is advisory

`check_clearance` is intentionally a projection, not a lock manager or permission grant.

It reads the same stored task context and summarizes known claim interactions:

```text
no interaction / GREEN -> CLEAR
AMBER                  -> CAUTION
RED / BLOCKED           -> HOLD
unknown risk value      -> REVIEW
```

The real admission, evaluation, verdict, permit and promotion gates remain unchanged. A `CLEAR` result cannot bypass them, and a coding agent cannot self-promote because MCP exposes no such tool.

## Competition deployment proof

`scripts/deploy-competition-final.sh` verifies the deployed MCP endpoint after the Cloudflare deployment. It fails closed unless:

- `server/discover` returns HTTP 200;
- the server advertises `2026-07-28`;
- the modern result discriminator and server identity are present;
- all seven agent-safe tools are listed; and
- no named privileged canonical-write/decision tool appears.

That check runs alongside the existing Worker health, public Mission Control, exact authorized-SHA equals shipped-SHA, secret-binding and non-demo authentication-boundary checks.
