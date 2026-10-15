# 10,000-agent fleet scaling

MADGRIX now has an explicit large-fleet control-plane bound: **up to 10,000 logical agent identities per fleet plan**, with a bounded active execution window instead of attempting to spawn every Git clone/process simultaneously.

This is intentionally a resource-control mechanism, not a claim that 10,000 full LLM coding agents have been live-tested simultaneously on Cloudflare.

## Why this exists

The ordinary contender runner executes its selected roster concurrently. That behavior is appropriate for small competition crews, but using the same strategy with 10,000 agents would attempt 10,000 local Git clones and child processes at once.

The large-fleet path separates two quantities:

```text
logical fleet size       <= 10,000 identities
active contender window  <= 256, default 32
```

A 10,000-agent logical roster at the default window becomes 313 bounded waves.

## Local scale proof

Run:

```bash
npm run fleet:10k
```

The harness exercises the real MADGRIX `enrollAgents` state transition with 10,000 identities, plans every identity into bounded waves, executes a 10,000-item bounded scheduler, and asserts that no identity is lost or duplicated.

The expected success marker is:

```text
MADGRIX_10K_LOGICAL_FLEET_OK
```

The recorded development run produced:

```text
logical_agents: 10000
enrolled_identities: 10000
waves: 313
active_window: 32
observed_max_in_flight: 32
enrollment_json_bytes: 810001
MADGRIX_10K_LOGICAL_FLEET_OK
```

That measurement proves local control-plane representation and scheduler bounds. It does **not** prove 10,000 simultaneous Cloudflare Artifacts repositories, Queue events, Durable Object transitions, model invocations, or Git processes.

## Real bounded-wave runner

For a large enrolled task, use:

```bash
MADGRIX_AGENT_SECRETS_FILE=/secure/agent-secrets.json \
MADGRIX_AGENT_IDS_FILE=/secure/agent-ids.json \
MADGRIX_ACTIVE_AGENT_WINDOW=32 \
npm run fleet:waves
```

`MADGRIX_AGENT_IDS_FILE` may be a JSON string array or newline-delimited ids. If omitted, the existing `MADGRIX_AGENT_IDS` / Agentfleet roster path is used.

The secrets file is required in fleet-wave mode so a very large secret map is not placed in one environment variable. Each wave passes only that wave's secrets to the existing contender runner. The existing runner continues to keep the service token out of the coding-agent command's environment.

## Current scaling boundary

The competition architecture still has one authoritative `TaskAuthority` Durable Object per task. Therefore the supported statement is:

> MADGRIX can represent a 10,000-agent logical roster locally and schedule real contender execution in bounded waves without a 10,000-process fork bomb.

The following statement is **not** claimed:

> MADGRIX has live-verified 10,000 simultaneously active Cloudflare coding agents.

A production 10,000-simultaneous-agent design should shard high-volume claims/contenders across authority partitions while keeping one canonical verdict/promotion boundary. That is deliberately not introduced into the proven competition promotion path under deadline pressure.
