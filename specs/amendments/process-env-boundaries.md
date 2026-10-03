# Spec amendment: process environment boundaries for the live-run scripts

**Status:** proposed · **Date:** 2026-10-02
**Affects (FROZEN-v1):** `EVALUATION_THREAT_MODEL.md` §2.1 (zone table), §4.2
(white-box evaluation) and §5 (credential matrix), via this amendment file only —
frozen spec files are NOT edited.

## (1) The invariants (quoted from the frozen spec)

`EVALUATION_THREAT_MODEL.md` §2.1, zone definitions (FROZEN-v1):

> Contender sandbox … MUST NOT: "See hidden tests, judge/verifier prompts, other
> contenders' code or tokens, policy, ledger"

> Trusted control plane … MUST NOT: "Hand model/attestation credentials to any
> other zone"

§4.2, white-box evaluation (FROZEN-v1):

> "The sandbox gets **no candidate credentials** and **no canonical write
> credentials**."

§5, credential matrix (FROZEN-v1):

> "The control plane MUST retain model/API credentials itself (Worker secrets /
> bindings) rather than injecting them into contender sandboxes."

§8, MUST NOT (FROZEN-v1):

> "Give contenders, reviewers, test harnesses, or judges any canonical write
> capability."

## (2) What the implementation violated, and what the spec leaves open

The spec assigns credentials to zones (§5) but says nothing about operating-system
processes. The live-run scripts drive every zone from one operator host, and they
passed the operator's whole environment down the process tree:

- `scripts/live-e2e.ts` spawned the contender runner and each evaluator with
  `{ ...process.env, ... }`, and the offline verifier with `process.env`. All of
  them received all three service tokens.
- `scripts/run-contenders.mjs` ran the coding-agent command with
  `{ ...process.env, ... }`. In a `live-e2e.ts` run that command therefore held
  `MADGRIX_CONTROL_SERVICE_TOKEN` (task freeze, verifier protocol, verdict and
  promotion requests), `MADGRIX_EVALUATION_SERVICE_TOKEN` (evaluator credentials and
  evidence submission), `MADGRIX_AGENT_SERVICE_TOKEN`, every other operator
  credential, and the evaluation configuration: `MADGRIX_HIDDEN_TEST_COMMAND` and the
  regression, semantic, static and security commands. This breaks §2.1, because the
  contender sees hidden-test material and holds other zones' tokens. It also breaks
  §8, because the contender holds the token that requests promotion.
- `scripts/evaluate-candidate.ts` ran the hidden-test and other evaluation commands,
  where candidate code executes in white-box mode, with `process.env` minus only the
  evaluation token. Those commands therefore held the control and agent tokens,
  breaking §4.2 and §8.
- Both untrusted commands ran under `bash -lc`. A login shell re-reads
  `/etc/profile` and `~/.profile`, so even a scrubbed environment would re-import
  whatever the operator's profile exports.

`test/env-isolation.test.ts` reproduced each of these on the unmodified scripts
before the fix (all five of its tests failed).

The spec does leave one point open. Coding-agent CLIs (Codex, Claude Code, Aider)
need their own model-provider key to run, and §5 says model/API credentials stay in
the control plane. The live harness has no Worker-side model proxy, so before this
change the agent's key reached it implicitly, along with everything else.

## (3) The change

1. **No inherited environment.** Every child process of the live-run scripts is
   started with `minimalEnv(extra)` (`scripts/lib/child-env.mjs`). That means `PATH`,
   `HOME`, `LANG`, `TMPDIR` and `TERM` from the parent when set, plus exactly the
   extras the spawning code names. No spawn receives `process.env` or a spread of it.
2. **Process-level credential matrix for the live harness:**

   | Process | Service token |
   |---|---|
   | `live-e2e.ts` (operator) | all three |
   | `run-contenders.mjs` | AGENT only |
   | coding-agent command | none |
   | `evaluate-candidate.ts` | EVALUATION only |
   | hidden / regression / semantic / static / security commands | none (`minimalEnv()` only) |
   | `git` children, `src/cli/verify.ts` | none |

   The agent command receives only `MADGRIX_AGENT_ID`, `MADGRIX_CONTENDER_ID`,
   `MADGRIX_TASK_ID`, `MADGRIX_BASELINE_SHA` and `MADGRIX_WORKSPACE` beyond
   `minimalEnv()`. Evaluation configuration never reaches the agent zone.
3. **No login shell.** The agent and evaluation commands run under `bash -c`.
4. **The one semantic addition: the agent's own model credential.** §5's retention
   rule continues to bind the control plane's credentials: service tokens, signing
   keys, and any verifier or judge model credentials. In the live harness, a
   contender's *own* model-provider credential may enter the agent command's
   environment, and only through `MADGRIX_AGENT_ENV_ALLOWLIST`. That is a
   comma-separated list of variable names the operator explicitly passes through.
   An entry that is not a variable name, or that names a `MADGRIX_*`,
   `*SERVICE_TOKEN*`, `*CLOUDFLARE*` or `CF_*` variable, is refused before any Worker
   call. Allowlisted variables reach the contender runner and the agent command,
   never the evaluation domain. The name check is a misconfiguration guard, not a
   content check.

## Non-goals (recorded so the boundary is not over-claimed)

This is an environment boundary, not an OS boundary. The agent and evaluation
commands still run as the operator's OS user with the operator's `HOME`. They can
read files there, and a same-user process can generally read another process's
`/proc/<pid>/environ`. The §2–§3 boundary against an adversarial contender remains
a separate sandbox per contender. Artifacts tokens no longer appear on any `git`
command line (2026-10-03): the live-run scripts pass them as `http.extraHeader`
through that git process's environment (`GIT_CONFIG_COUNT`/`KEY_0`/`VALUE_0`), which
other OS users cannot read. The promotion container's own scripts still use
`-c http.extraHeader` inside that container.

Implementation notes: `scripts/lib/child-env.mjs`, `scripts/live-e2e.ts`,
`scripts/run-contenders.mjs`, `scripts/evaluate-candidate.ts`; regression test
`test/env-isolation.test.ts`; operator-facing summary in `docs/SECURITY.md`,
"Process environment boundaries".
