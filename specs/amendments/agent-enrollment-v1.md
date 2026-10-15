# Spec amendment: agent-enrollment-v1 — the control plane issues each agent its secret

**Status:** proposed · **Date:** 2026-10-03
**Affects:** It closes the "first claim wins" residual risk of
`contender-agent-binding.md` and changes how an agent's secret is issued.
`EVALUATION_THREAT_MODEL.md` (FROZEN) §5's credential matrix is implemented, not
changed. These are changed via this amendment file only; spec files are NOT
edited.

## (1) The invariants (quoted from the specs)

`EVALUATION_THREAT_MODEL.md` §5 (FROZEN), credential matrix:

> "Contender | WRITE only its own fork"

`contender-agent-binding.md`, residual risk:

> "**First claim wins.** Agent ids are still self-asserted strings. A holder of
> the shared AGENT token can register a claim for an agent id that has not
> claimed yet and so bind that id to its own secret. The real agent's first
> claim then fails with 403 ... Per-agent transport credentials would remove
> this, and are out of scope here."

## (2) What the implementation allowed

An agent's first `/claim` minted its secret. Every agent shares
`AGENT_SERVICE_TOKEN`, so any holder of that token could claim an agent id before
the real agent did. The squatter then held that id's secret: it could create the
contender for the id and receive its fork's write token. The real agent was
locked out (403). `test/contender-binding.test.ts` showed a first claim with no
secret, or with another agent's secret, accepted (200).

## (3) The change

1. **Enrollment at task creation.** `POST /tasks` requires `agent_ids`: a
   non-empty list of distinct ids matching `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`
   (400 `agent_ids_required` / `invalid_agent_ids`). The Worker mints one secret
   per agent (32 random bytes, hex). It sends only their SHA-256 to the authority
   (`/init` → `enrollAgents`, ledger entry `agents_enrolled`), and returns the
   plaintexts once, in the response's `agent_secrets`.
2. **Every claim presents the agent's own secret.** On an enrolled task
   (`AuthorityState.agent_enrollment`), `registerClaim` accepts only enrolled
   agent ids (403 `agent_not_enrolled`). Every claim, the first included, must
   carry the agent's secret in `X-Madgrix-Agent-Secret` (403
   `agent_secret_required` / `agent_secret_invalid`). Nothing is minted, and the
   claim stores the enrolled hash, so `/contenders` derives the agent from the
   same secret as before.
3. **Delivery.** `scripts/live-e2e.ts` (the control plane) enrolls
   `MADGRIX_AGENT_IDS` and passes the secrets to `run-contenders.mjs` as
   `MADGRIX_AGENT_SECRETS` (JSON, agent id → secret). The runner refuses to start
   without a well-formed secret for every agent id (exit 2, before any Worker
   call, without echoing a value). It presents each agent's secret on that
   agent's `/claim` and `/contenders`, and never passes any secret to an agent
   command. `test/env-isolation.test.ts` checks that no `env` dump of an agent or
   evaluation command contains one.

## Not claimed

- A task the authority initialized without enrollment keeps the old behavior:
  the first claim mints. That covers authorities persisted before this change
  and direct use of the pure state machine. Every task the Worker creates now is
  enrolled.
- The secrets are bearer credentials. Whoever holds `MADGRIX_AGENT_SECRETS`,
  normally the runner, can act as any of those agents. The separation is
  between agents, not from the runner.
- An enrolled agent's lost secret cannot be re-issued. Recovery is a new task.

Implementation notes: `src/lib/types.ts` (`AuthorityState.agent_enrollment`),
`src/lib/task-state.ts` (`enrollAgents`, `registerClaim`, `AGENT_ID_PATTERN`),
`src/do/TaskAuthority.ts` (`/init`), `src/worker/index.ts` (`handleCreateTask`),
`scripts/live-e2e.ts`, `scripts/run-contenders.mjs`. Tests:
`test/contender-binding.test.ts`, `test/task-state.test.ts`,
`test/evaluator-isolation.test.ts`, `test/env-isolation.test.ts`.
