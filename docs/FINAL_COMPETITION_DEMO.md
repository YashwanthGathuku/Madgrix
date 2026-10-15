# MADGRIX — final Cloudflare competition demo runbook

Target: **7–8 minutes**. Record only after the canonicality hardening branch is merged, deployed with the existing secrets file, and read-only smoke checks pass.

## The one sentence

> **Git decides ancestry. MADGRIX decides canonicality.** Agents can create many software states, but only an independently evaluated exact state that earns a single-use CanonCap may become canonical.

Secondary line:

> **Agents can race. Only evidence can ship.**

## Sources to have open before recording

Live Run 4 Mission Control:

```text
https://madgrix.ygathuku96.workers.dev/tasks/task_79b1f9d610e94d8e95daa503/graph
```

Live Run 4 causal proof after hardening deploy:

```text
https://madgrix.ygathuku96.workers.dev/tasks/task_79b1f9d610e94d8e95daa503/why/d55332b544992a2e033ca03fa54972c5283eef73
```

Terminal at repository root, ready for:

```bash
npm run attack:lab
```

Run 4 facts:

- task `task_79b1f9d610e94d8e95daa503`
- baseline `b3ee4c862dcc6996678dc25c1de5c49b060fa9d4`
- reviewed / authorized / promoted SHA `d55332b544992a2e033ca03fa54972c5283eef73`
- TheUstad `FINAL VERIFIED`
- orchestrator `MADGRIX_LIVE_E2E_OK`
- offline promotion bundle `VERIFIED`
- canonical repository: real Cloudflare Artifacts `starter-repo`

Keep the 88-second original live Run 4 capture ready as backup proof:

```text
~/workspace/madgrix-live-run/video/git4agents-live-run4.mp4
```

## 7–8 minute script

### 0:00–0:35 — Hook: the missing Git primitive

Screen: live Mission Control at the top.

Say:

> “Git is excellent at answering what came before a commit. But when autonomous agents can create and review changes without a human watching every operation, there is a second question: **which exact software state has the right to become canonical?**”

> “MADGRIX separates those ideas. Git decides ancestry. MADGRIX decides canonicality.”

Point to Run 4 task, baseline and final SHA.

### 0:35–1:25 — Concurrent work without canonical authority

Screen: CrewContender + claims/clearance.

Say:

> “This is a real recorded Cloudflare task. A parent coordinated two concurrent scripted sub-agent roles on contender state. The agents can create Git commits, but they never receive canonical write authority. WorkClaims record intent, baseline and scope before their work is admitted.”

> “The important distinction is candidate creation versus canonicalization. An agent can produce a state. That does not give the state the right to become real.”

Do not call the scripted sub-agents LLM agents.

### 1:25–2:10 — Cloudflare is the execution substrate

Screen: README architecture diagram or keep Mission Control visible.

Say:

> “Cloudflare Artifacts stores canonical and contender Git state and issues scoped repository credentials. Real Artifacts push events enter a Queue. A TaskAuthority Durable Object owns the authorization state machine. Promotion is a Workflow and trusted Container, and only that path can write canonical Git.”

> “Workers exposes both REST and MCP. MCP is not a policy bypass: its tools delegate back through the same core router and authority checks.”

### 2:10–3:05 — CanonCap: canonicality is a capability

Screen: scroll Mission Control to **MADGRIX Canonicality**.

Say:

> “Here is the primitive we expose: CanonCap. It is the public descriptor of MADGRIX's existing exact-state permit.”

Point to:

- candidate SHA;
- tree digest;
- evidence bundle binding;
- destination repository;
- expected destination HEAD;
- `CONSUMED` / single-use state.

Say:

> “This is not ‘agent X may merge’. It is: **this exact reviewed state, under this evidence and this destination state, may canonicalize once.** Change the candidate, tree, evidence, policy or destination HEAD and the old authority no longer matches. If main moves, a rebase creates a new SHA and that state must be evaluated again.”

### 3:05–4:00 — Attack Lab: make the security visible

Screen: terminal.

Run:

```bash
npm run attack:lab
```

Let the result stay visible.

Say:

> “Trust protocols are hard to demo because success looks boring. So this runs MADGRIX's existing adversarial protocol harness and asks the opposite question: can stale or abusive authority ship?”

Point to blocked classes such as replay, destination-head race, duplicate events, quarantine and mandatory integrity failure.

Finish on:

```text
26/26 adversarial trials passed
unauthorized canonical promotions: 0
ATTACK_LAB_VERIFIED
```

Say clearly:

> “This is local adversarial protocol validation, not live Cloudflare fault injection.”

### 4:00–4:45 — Conflict Capsule

Screen: deliberate local conflict fixture, with its fixture banner visible.

Say:

> “Conflicts have a similar problem. Conflict marker text is a human-editor representation. In MADGRIX, a `CONFLICTED` composition is not a candidate.”

Show the Conflict Capsule fixture/output.

> “The capsule is content-addressed metadata over the conflict: baseline, contribution SHAs, paths and excerpt digests. It explicitly says candidate SHA is null, old authority is invalid and resolution must create a new SHA that re-enters evaluation.”

Do not present the fixture as Run 4 or a live Cloudflare conflict.

### 4:45–5:35 — Independent evaluation + blind verification

Screen: live Run 4 Evaluation / verifier / Verdict Seam.

Say:

> “A candidate does not grade itself. Evaluation is separately authenticated and checks baseline, scope, hidden tests, regressions, security, provenance and tamper state. Mandatory gates are non-compensatory.”

> “Blind verifiers commit references before candidate exposure, reveal later and submit signed reports. Only the Verdict Seam can select a winner—or reject, abstain, escalate or quarantine.”

Clarify TheUstad if shown:

> “TheUstad is the frozen-baseline integrity gate in this fork-crew path; it is not the semantic judge of the combined candidate.”

### 5:35–6:25 — Causal Proof Graph: why canonical?

Screen: live `/why/d55332b5...` JSON or the Mission Control causal panel.

Say:

> “Ordinary Git gives me the ancestry graph. This projection answers a different query: **why was this exact SHA allowed to become canonical?**”

Walk the chain:

```text
task → claims → composition → evaluation → verdict → CanonCap → promotion proof → canonical SHA
```

Point to `causal_root`.

> “Every displayed proof node is content-addressed, and the whole explanation has a deterministic root. It does not grant authority; it proves the causal path through the authority records. Private verifier prose, secrets, permit nonces and raw conflict source are deliberately excluded.”

### 6:25–7:05 — Exact reviewed SHA = shipped SHA

Screen: Authorization / Promotion and final SHA.

Say:

> “The promotion Container does not create a convenient new merge commit after review. It fast-forwards canonical Git to the candidate that was actually authorized.”

Point to:

```text
reviewed   d55332b544992a2e033ca03fa54972c5283eef73
promoted   d55332b544992a2e033ca03fa54972c5283eef73
```

> “What was reviewed is exactly what shipped.”

### 7:05–7:40 — Four real runs + offline proof

Screen: `docs/LIVE_RUN_RESULTS.md`, short original Run 4 clip, then offline verifier transcript.

Say:

> “MADGRIX has four recorded end-to-end Cloudflare promotions, each starting from the previous run's canonical state. Run 4 completed `MADGRIX_LIVE_E2E_OK`, TheUstad returned `FINAL VERIFIED`, and the signed promotion bundle verified offline against the pinned authority key.”

Close:

> “Git records change. MADGRIX governs canonicality. Agents can race. Only evidence can ship.”

Stop.

## Recording safety checklist

Before pressing Record:

- deploy only after merge and green CI;
- **every deploy must preserve the existing secrets file** (`--secrets-file /home/box/.madgrix/secrets.env` in the current environment);
- do not run `live:e2e` again just for the video;
- open Mission Control in an incognito/private window and confirm Run 4 is public read-only;
- confirm a random task's new canonicality route is still 401/auth-protected;
- confirm `/mcp` discovery still works after deployment;
- confirm the Run 4 `/why/<sha>` route returns the expected SHA and a 64-hex `causal_root`;
- never show service tokens, Git credentials, Cloudflare API tokens or local secret files;
- keep the local conflict fixture banner visible;
- call Attack Lab a **local adversarial protocol harness**, not live fault injection;
- keep the video between five and ten minutes.

## Submission fields

### Project name

`MADGRIX — Canonicality for Autonomous Software`

### Project vision

`Git decides ancestry. MADGRIX decides canonicality. Autonomous agents may create many competing software states, but a state may become canonical only when it earns single-use, evidence-bound exact-state authority. MADGRIX coordinates contender work, independently evaluates it, blind-verifies the decision, binds canonicalization authority to the exact candidate and destination state, promotes that exact reviewed SHA, and emits an offline-verifiable proof of why it shipped.`

### How Cloudflare was used

`MADGRIX uses Cloudflare Artifacts for canonical and contender Git state plus scoped credentials; Artifacts push events feed Cloudflare Queues; Workers exposes the REST/MCP control plane and consumes those events; TaskAuthority and promotion coordination use Durable Objects; a Cloudflare Workflow provides one durable promotion instance per exact-state permit; and a trusted Cloudflare Container performs the only canonical Git write. Four recorded competition runs completed the real Cloudflare path end-to-end.`

### Repository / try it

```text
Repository:
https://github.com/YashwanthGathuku/Git4agents

Live Mission Control after final hardening deploy:
https://madgrix.ygathuku96.workers.dev/tasks/task_79b1f9d610e94d8e95daa503/graph
```

Apache-2.0 licensed. Full local reproduction commands are in the root README.
