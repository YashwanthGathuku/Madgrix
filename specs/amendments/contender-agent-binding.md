# Spec amendment: bind each contender to the agent that registered its claim

**Status:** proposed · **Date:** 2026-10-02
**Affects:** `INTENT_AND_CONFLICT_GRAPH.md` §2 (WorkClaim schema, frozen core):
one authority-assigned field. `EVALUATION_THREAT_MODEL.md` §5 (credential matrix)
and §7 (quarantine revocation, FROZEN-v1), and `CLOUDFLARE_RUNTIME_MODEL.md` §5
(idempotent fork, FROZEN-v1). These are changed via this amendment file only;
frozen spec files are NOT edited.

## (1) The invariants (quoted from the specs)

`INTENT_AND_CONFLICT_GRAPH.md` §2:

> "A contender MUST register a `WorkClaim` with the task's Durable Object
> **before** forking or writing code."

`EVALUATION_THREAT_MODEL.md` §5, credential matrix (FROZEN-v1):

> "Contender | WRITE **only its own fork** | Short-lived (v1: ≤1h), minted at fork
> time | MUST NOT hold any token for the baseline repo or canonical repo"

and §2.1: the contender sandbox MUST NOT see "other contenders' code or tokens".

`EVALUATION_THREAT_MODEL.md` §7 (FROZEN-v1):

> "On entering `QUARANTINED`: the control plane MUST revoke the contender's repo
> write token (`revokeToken`) …"

`CLOUDFLARE_RUNTIME_MODEL.md` §5 (FROZEN-v1):

> "Workflow step code MUST be written so that a retry after a partial failure
> (e.g. fork created but token minting failed) resumes to the same end state
> rather than duplicating the effect."

## (2) What the implementation violated

- Every agent authenticates to the Worker with the one shared
  `AGENT_SERVICE_TOKEN`, and `POST /tasks/:id/contenders` took `agent_id` from
  the request body. Because `contender_id = H("contender", task_id, agent_id)`,
  any agent could name another agent, get that agent's `contender_id`, and
  receive a fresh 1h WRITE token on the other agent's fork. That breaks "WRITE
  only its own fork" and "MUST NOT see other contenders' tokens".
- `TaskAuthority` `POST /contender` wrote `state.contenders[id]` unconditionally.
  The second request overwrote the first agent's record, including `token_id`.
  The first token stayed live but was no longer on the record, and quarantine
  revokes only the recorded token id. So one live write token could survive a
  §7 quarantine.
- `claim_work_id` was optional on `/contenders`, so a contender could be forked
  without any registered claim (spec 2 §2).

`test/contender-binding.test.ts` reproduces this against the real Worker router
and `TaskAuthority` with FakeArtifacts. Before the fix, agent B received a write
token for agent A's fork, and all five tests failed.

## (3) The change

1. **Per-agent secret.** `WorkClaim` gains one field, `agent_secret_sha256`,
   which the authority assigns and never accepts from a caller (400). An agent's
   first `/claim` mints a secret (32 random bytes, hex) and returns it once as
   `agent_secret`. Only SHA-256(secret) is stored, on the claim. A later claim
   naming the same agent must send the secret in `X-Madgrix-Agent-Secret`
   (otherwise 403) and receives no new secret. The Worker's `/context` and
   `/evaluator-credentials` responses omit the field.
2. **Agent derived from the secret.** `/contenders` requires
   `X-Madgrix-Agent-Secret` (401 without it). The agent is the one whose claim
   carries SHA-256(secret) (403 if none). A body `agent_id` or `claim_work_id`
   that disagrees is 403. Every secret comes from a claim, so a contender can
   no longer exist without a registered claim.
3. **Create-only contender records.** `TaskAuthority` `/contender` returns an
   existing record unchanged with 200 (`recorded: false`) and never overwrites
   it. The Worker returns an existing contender with 200 and no token before
   forking or minting. If it loses a race to a concurrent registration, it
   revokes the token it minted. The contender write token is therefore minted
   once per contender ("at fork time", spec 5 §8). New records append a
   `contender_registered` ledger entry.
4. **All token ids tracked and revoked.** `ContenderRecord` gains `token_ids`:
   every token id minted for the contender. Quarantine emits one `revoke_token`
   effect per id; records that predate the field fall back to `token_id`. A token
   the Worker mints but fails to record is revoked at once.
5. `scripts/run-contenders.mjs` carries the secret from `/claim` to
   `/contenders` in the header. It is held in memory only and never reaches the
   agent command's environment; `test/env-isolation.test.ts` asserts that no
   issued secret appears in any agent or evaluation `env` dump.

## Consequences and residual risks (recorded so they are not over-claimed)

- **Lost token response.** A retry converges to the same record and mints no
  duplicate token, which is spec 5 §5's "same end state". But if the response
  carrying the token is lost after the record is written, there is no re-issue
  path for that contender. Recovery is a new agent id, and so a new claim, fork
  and contender.
- **First claim wins.** Agent ids are still self-asserted strings. A holder of
  the shared AGENT token can register a claim for an agent id that has not
  claimed yet and so bind that id to its own secret. The real agent's first
  claim then fails with 403: it fails closed rather than sharing a fork.
  Per-agent transport credentials would remove this, and are out of scope here.
  (Closed for tasks the Worker creates: the control plane now issues each agent
  its secret at task creation, `agent-enrollment-v1.md`.)
- **Fork-creation token.** The token that fork/create returns is plaintext-only
  (no id). The Worker revokes it immediately at fork time; it is not in
  `token_ids`.

Implementation notes: `src/lib/task-state.ts` (`registerClaim`,
`resolveAgentBySecret`, `registerContender`, `contenderTokenIds`,
`quarantineContender`), `src/do/TaskAuthority.ts`, `src/worker/index.ts`,
`scripts/run-contenders.mjs`; regression test `test/contender-binding.test.ts`.
