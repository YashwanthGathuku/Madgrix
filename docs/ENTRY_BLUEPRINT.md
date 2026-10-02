# Entry Blueprint: Agent-Native Git Platform on Cloudflare Artifacts

> **Historical note (2026-10-01):** this was the earliest planning sketch,
> written before the deeper research pass. It is preserved as a record of
> the project's evolution. The authoritative engineering contracts are the
> six specifications in `specs/` (three frozen as FROZEN-v1); the research
> synthesis is `research/RESEARCH.md`.

**Competition:** Cloudflare "Build the next Git platform" — deadline **Oct 14, 2026**
**Foundation:** `agent-orchestration-os` branch `paper-hardening` (HEAD `56dd7db`)
**Date:** 2026-10-01 · **Build window:** 13 days

---

## 1. What the branch actually is (ground truth)

`agent-orchestration-os` is a **declarative multi-agent runtime** ("fleet"). You describe
agents, tasks, models, and tool allowlists in YAML; `fleet run` executes the plan against a
workspace folder. Canonical runtime is the Rust binary `fleet-rs/` (Python SDK is a thin
wrapper that shells out to it; `rust/` and `rust-scheduler/` are deprecated stubs).

The `paper-hardening` branch adds a **governance layer** derived from four Sept 2026
preprints (swarm cheating, harness-vs-model effects, fabrication after tool failure,
verifier value). Concretely, HEAD `56dd7db` adds:

| Component | File | What it does |
|---|---|---|
| **Verdict seam** | `fleet-rs/src/safety/verifier.rs` | NOT a verifier — a seam between the publish path and any external verifier. Always runs mechanical publish preconditions (non-empty artifact, no placeholder markers, no admitted non-completion, every `tool_status: FAILED` acknowledged in the artifact). Optional `ExternalVerifier` shells out to a configured command; pass requires exit 0 **and** `FINAL VERIFIED` on stdout. Timeouts/spawn failures fail closed. Verdicts record verifier provenance (`preconditions-only` when unconfigured — never a forged pass). |
| **Machine-readable tool status** | `tools/types.rs`, `loop_engine.rs` | Every tool observation carries `tool_status: OK` / `tool_status: FAILED (<category>)`. Failures become checkable signal, not inferred prose. |
| **Quarantine-aware feed** | `kernel/feed.rs`, `cli/run.rs` | Quarantined / contribution-revoked agents' artifacts are **excluded** from dependent tasks' prompts **and named in the disclosure** — a dependency never disappears without the reader being told why. Exclusions audited. |
| **Escalation dispatcher** | `mailbox/types.rs`, `safety/sanctions.rs` | First-class `Dispute`, `QuarantineRequest`, `PatchProposal` mailbox messages. Disputes recorded (no auto-recall). Quarantine needs **2+ independent reporters in good standing (trust ≥ 0.6)** — no unilateral containment. Patch proposals never self-apply (operator approval). |
| **Sanction ladder** | `safety/sanctions.rs` | Pure function of frozen reputation snapshot: trust < 0.6 demote (ranking halved), < 0.4 contribution revoked, < 0.25 quarantine. Deterministic, audited. |
| **Honest metrics** | `metrics.rs` | Run metrics derived **only** from durable records (reputation ledger + escalation reports). `ground_truth` is `None` outside the chaos harness — the harness refuses to grade its own homework. |
| **Red-team scenarios** | `chaos_scenarios.rs` | Harness-side presets (behavioral split, contagion window, ledger blindness, stop-loss, credential exhaustion, unpinned sandbox, off-mailbox coordination). |
| **Run bundles** | `bundle.rs` | `fleet export` → portable directory: deliverables, transcripts, audit journal, provenance, receipts, gate reports + `manifest.json` of SHA-256s. `fleet verify` checks everything **offline** — hash chains recompute, anchors recomputed from transcript observations, recalled evidence invalidates citations. |

Supporting machinery (pre-existing on the branch): hash-chained audit journal sealed with a
custody key, dual transcripts, reputation ledger (trust = gate outcomes + recalls, pseudo-counts),
rogue supervisor (prompt-injection tripwires, path traversal, off-manifest tools → quarantine),
crash-safe resume, ADLP (destructive ops blocked fail-closed), secret redaction, per-task
acceptance contracts + grounding requirements, and a **merge pattern** already proven at scale:
the 100-agent book swarm used `DraftMerge` mailbox messages with team leads → chief synthesizer.

### License finding (blocking for submission)

`LICENSE` currently reads: *"Copyright (c) 2026 Sphinxghost. All rights reserved. Private and
confidential software. No permission is granted to use, copy, modify, distribute, sublicense,
or disclose this software without prior written permission."*

**The competition requires MIT, Apache, or BSD.** The repo cannot be submitted as-is.
Additionally, `CANONICAL.md`/`README.md` flag a **leaked cloud key still in git history** as a
release blocker. Recommendation: do **not** relicense-and-scrub the whole repo under deadline
pressure. Instead, create a **fresh public repo** for the entry (clean history, MIT from the
first commit) containing the Worker control plane plus the fleet components the entry needs
(vendored as a crate/submodule or copied with attribution). Relicensing the full OS is a
separate, user-owned decision — but the entry's own code must be permissive from day one.

### Publishing note

`paper-hardening` exists **only locally** (one commit ahead of `origin/ccr-4a6c81be-u68mv0`).
Nothing about the entry depends on pushing it, but any code carried into the entry repo should
be cut from this branch tip so the governance behavior matches this blueprint.

---

## 2. Component → entry mapping

The entry's concept: **contenders, not pull requests.** A task arrives; N agents each get an
isolated fork; they work concurrently; pushes trigger automatic review; a judge picks the
winner; the merge is gated and evidence-backed. Here is which branch machinery becomes which
platform part:

### The three strongest mappings

**1. Verdict seam → merge gating (the platform's immune system).**
Today `verify_before_publish` gates "artifact lands in the workspace." In the entry it gates
"contender's branch merges to main." A contender that pushes a placeholder, admits
non-completion, or buries a tool failure is rejected **before merge, with a machine-readable
reason** — the exact failure mode of agent-generated PRs that human reviewers drown in. The
`ExternalVerifier` slot is where a real judge (TheUstad, a test suite, a reviewer agent) plugs
in; without one the merge record honestly says `preconditions-only`. This is the answer to
Cloudflare's "how do you review everything they produce?" — review is ambient, deterministic,
and fail-closed, not a human inbox.

**2. Sanction ladder + quarantine-aware feed → contender judging with institutional teeth.**
The DeepMind finding the branch implements: agents could *recognize* fraud but had no power to
act. The entry's judge doesn't just pick the best diff — the sanction ladder **disqualifies
contenders from quarantined agents** (trust < 0.25), and the feed ensures reviewer agents'
prompts **exclude tainted code while disclosing the exclusion**. In the demo, the saboteur
contender isn't merely outscored; it is institutionally contained, and the review prompt says
so. No "GitHub with agents" entry will have this — it's the branch's moat.

**3. Run bundles + audit journal + reputation ledger → the intent ledger (the "why" chain).**
Cloudflare asks: "how do you keep track of not just what changed, but *why*?" The entry's
answer is mechanical, not a new invention: every merge commit carries (a) the task brief hash,
(b) the winning agent's id and trust score, (c) the verdict (checks + verifier identity),
(d) reviewer reports, and (e) a pointer to the exported run bundle, which anyone can
`fleet verify` offline — hash chains, anchors, recalls. The ledger is assembled from parts
that already exist; the new work is pinning them to git commits.

### Full mapping table

| Git-platform need | Branch component | Reuse | New work |
|---|---|---|---|
| Fork-per-agent-task | Artifacts binding `project.fork()` (Workers) | — (Cloudflare primitive) | Worker `POST /tasks` endpoint: fork N times, mint repo-scoped tokens, hand each contender its brief |
| Concurrent agent execution | `fleet run` + bounded-concurrency scheduler + per-task resume | Reuse as-is | Contender swarm YAML shape; agent briefs carry remote + token |
| Agents push code | **nothing** — no git tool exists | `shell_exec` (gated) as stopgap | **New `git` tool** (clone/push/fetch via token header auth) or hardened shell path; fastest: allowlist `git` in `shell_exec` with token via env |
| Push → automatic review | Artifacts event subscriptions → Worker queue | — (Cloudflare primitive) | Worker review workflow: trigger tests + reviewer-agent task on `repo.pushed` |
| Reviewer agents | Agent loop + quarantine-aware feed | Reuse; feed already excludes/names tainted authors | Reviewer brief template (diff in, verdict out) |
| Compare contenders | `DraftMerge` / synthesizer pattern (proven: 100-agent book) | Pattern reuse | **Judge logic**: tests + reviewer verdicts + trust scores → winner; loser contenders preserved, not deleted |
| Merge gating | Verdict seam (`verify_before_publish`) | Reuse; repoint from "publish to workspace" to "merge to main" | Merge executor (isomorphic-git in Worker) that refuses on `!verdict.complete` |
| Conflict reconciliation | — | — | Keep mechanical for the demo: `git merge`, tests must pass; **do not promise semantic merge** |
| Intent ledger | Audit journal + transcripts + `VERIFIER_STATUS-*` + run bundles + reputation ledger | All exist | Assembler: merge-commit message + `LEDGER.md` binding brief→trace→verdict→decision; bundle export per merge |
| Deploy + previews | Workers Builds | — (Cloudflare primitive) | Wire: main → production, each contender branch → preview |
| Saboteur / red-team demo | Chaos scenarios + scripted brain | Reuse: scripted brain gives a **deterministic** bad contender | One sabotage scenario scripted for the video |
| Honest scoreboard | `metrics.rs` | Reuse for the demo's end card ("2 published, 1 rejected (verifier), 1 quarantine enacted") | — |

---

## 3. Architecture: what runs where (honest split)

The fleet is a native Rust binary (tokio, spawns subprocesses, MCP stdio, shell tools). It
**cannot run on Workers**, and porting it in 13 days is not realistic. The honest architecture
is a split brain — and the framing for judges is deliberate:

> **The Git platform runs on Cloudflare. The agents run on bring-your-own compute — exactly
> like CI runners.** GitHub doesn't execute your test suite on github.com; Actions runners do.
> Here, Workers own repos, events, review triggers, judging state, and deploys; the fleet
> binary is the runner that executes agents. (Cloudflare's own Sept 30 "Containers, rebuilt
> to scale agent sandboxes" post is the future story: fleet-in-container. The demo does not
> need it.)

```
                        ┌─ Cloudflare ─────────────────────────────┐
                        │                                          │
  task ──► Worker ──► ARTIFACTS binding: fork base repo × N        │
  (UI/CLI)   │        mint repo-scoped tokens                      │
             │        event subscriptions (repo.pushed) → Queue    │
             │        review workflow trigger                      │
             │        contender status API + dashboard              │
             │        merge via isomorphic-git (winner → main)      │
             │        Workers Builds: main → prod, branches → previews
             │                                          │
             └──────────────┬───────────────────────────┘
                            │ briefs (remote + token + task)
                            ▼
              ┌─ Fleet runner (local host / VM) ─────────────────┐
              │  fleet run contender-swarm.yaml                  │
              │  ┌─────────┐ ┌─────────┐ ┌─────────┐              │
              │  │ agent A │ │ agent B │ │ agent C │  concurrent  │
              │  │ fork-a  │ │ fork-b  │ │ fork-c  │  pushes      │
              │  └────┬────┘ └────┬────┘ └────┬────┘              │
              │       │ verdict seam (merge gate)                │
              │       │ sanction ladder (disqualify quarantined) │
              │       │ reviewer agents (quarantine-aware feed)  │
              │       ▼                                          │
              │  judge → winner → push merge request to Worker   │
              │  run bundle export → evidence pack per merge     │
              └──────────────────────────────────────────────────┘
```

**Worker responsibilities (TypeScript):** task intake; fork-per-contender; token minting;
push-event → review fan-out; contender state machine (`working → pushed → reviewing →
judged → merged/rejected`); merge execution (isomorphic-git); intent-ledger assembly into the
merge commit; dashboard + API; deploy wiring.

**Fleet responsibilities (Rust, unchanged core):** agent execution loops; tool gateway (+ new
git tool); verdict seam as merge gate; sanctions/quarantine; reviewer agents; judge task;
reputation; bundles; audit.

**The contract between them** is JSON over HTTPS: Worker → fleet: task briefs
(`task_id`, `repo_remote`, `token`, `instruction`, `acceptance`); fleet → Worker: push
notifications, contender verdicts, merge requests, bundle references. Keep this contract
small and versioned — it is the seam the demo lives or dies on.

**What stays local in the demo (and that's fine):** the fleet runner, the model endpoints
(local llama.cpp or API), the external verifier command. The video shows the Worker dashboard
as the platform face; the runner is infrastructure, like Actions runners.

---

## 4. Gap analysis, ordered by demo-criticality

1. **CRITICAL — Git capability for agents.** No git tool exists in the tool gateway.
   Fastest path: allowlist `git` under `shell_exec` with the Artifacts token passed via
   `http.extraHeader` (never in the remote URL, never in git config — the docs' own hygiene
   rule). A dedicated `git` tool is cleaner but slower; do the shell path first, tool second
   only if time permits.
2. **CRITICAL — Worker control plane.** Task intake, fork-per-contender, token minting, event
   subscription → queue → review trigger, contender status API, merge via isomorphic-git.
   This is the visible "platform" and ~40% of the build.
3. **CRITICAL — Publishing hygiene.** Fresh public repo, MIT/Apache-2.0 from commit one, no
   leaked secrets in history. Blocks submission; do it on day 1, not day 12.
4. **HIGH — Judge logic.** Tests + reviewer-agent verdicts + trust scores → winner selection.
   Losers preserved as contenders (compare view), not deleted. Reuse the synthesizer pattern;
   the scoring function is new.
5. **HIGH — Verdict seam → merge gate wiring.** Repoint `verify_before_publish` from
   workspace-publish to merge-eligibility; merge executor refuses on rejection; rejection
   reasons surface in the dashboard.
6. **HIGH — Intent ledger assembler.** Merge-commit message + `LEDGER.md`: brief hash, agent,
   trust, verdict + checks, reviewer reports, bundle pointer. All inputs exist; the assembler
   is new (~200 lines).
7. **MEDIUM — Reviewer agents on push events.** Worker webhook → fleet reviewer task with the
   diff; verdict back to Worker. Quarantine-aware feed already handles tainted contenders.
8. **MEDIUM — Contender dashboard.** Simple Worker-served page: task → contenders → status,
   diffs, verdicts, ledger. The video needs *something* visual; keep it brutally simple.
9. **LOW — Workers Builds previews per contender.** Nice-to-have; wire only if the core is
   green by day 10.
10. **CUT — Semantic merge.** Do not build it. Mechanical `git merge` + test gate is the
    demo. Say so out loud in the video; judges respect scope honesty.
11. **CUT — Fleet on Workers/Containers.** Future-story slide, not a build item.

---

## 5. 13-day build plan (Oct 1 → Oct 14, one strong builder + AI)

| Days | Milestone | Exit criteria |
|---|---|---|
| **1–2** (Oct 1–2) | Foundation + hygiene | Entry repo created (public, MIT/Apache-2.0, clean history); Worker↔fleet JSON contract written down; `paper-hardening` code vendored; demo task chosen (one real bugfix/feature, small enough for 3 agents in minutes) |
| **3–5** (Oct 3–5) | Worker control plane | `POST /tasks` forks N contenders via ARTIFACTS binding; tokens minted; push events → queue → logged; contender status API live; merge via isomorphic-git proven against a scratch repo |
| **4–6** (Oct 3–6, parallel) | Fleet git path | Agents clone/push via allowlisted `git` + header auth against real Artifacts; contender swarm YAML runs 3 agents concurrently, 3 forks, 3 pushes visible in dashboard |
| **7–9** (Oct 7–9) | Judge + merge gate + ledger | Judge picks winner from tests + reviewer verdicts + trust; verdict seam blocks a deliberately-bad contender; merge commit carries intent ledger; bundle export per merge verifies offline |
| **10–11** (Oct 10–11) | Full rehearsal + dashboard | End-to-end demo run recorded (it *will* break things — fix them; real runs find the bugs); dashboard shows contenders, verdicts, ledger; sabotage scenario deterministic via scripted brain |
| **12–13** (Oct 12–13) | Video + submission | 5–10 min video cut; run instructions written and followed cold by someone (or something) else; repo polished; submitted |
| **14** (Oct 14) | Buffer | Only buffer. If the plan is on track, deepen the judge; never start new features |

**Staffing note:** the critical path is Worker (days 3–5) → fleet git (days 4–6) → judge/gate
(days 7–9). These serialize. Everything else parallelizes or cuts.

---

## 6. Demo story (the 5–10 min video)

**Title arc: "Three agents, one bug, one merge — and the merge can prove why."**

1. **The task** (30s): a real bug in a small repo, submitted through the platform. Not a
   toy — something with a test that fails.
2. **The fork** (45s): the Worker forks the repo three times — one per contender agent —
   mints three repo-scoped tokens, and dispatches. Show the dashboard: three contenders,
   `working`.
3. **Concurrent work** (90s): agents work at the same time; pushes land; Artifacts events
   fire; each push triggers automatic review. This is the "multiple agents concurrently"
   bar, cleared on screen.
4. **The immune system** (90s): contender C (scripted saboteur — deterministic) pushes a
   "fix" containing a placeholder and an unacknowledged tool failure. The verdict seam
   rejects it live; show the machine-readable reason. A reviewer agent disputes contender B's
   approach; the sanction ladder's standing is visible. The review prompt **names the
   excluded tainted code** — the quarantine disclosure the branch implements.
5. **The judgment** (60s): side-by-side contenders; tests + reviewer verdicts + trust scores;
   winner selected. Losers preserved for comparison — "compare multiple changes at the same
   time, and decide which one should ship," per the brief.
6. **The merge** (60s): winner merges; the merge commit message *is* the intent ledger —
   brief hash, agent, trust, verdict checks, reviewer reports, bundle pointer. Run
   `fleet verify` on the bundle **offline** to prove the evidence is real.
7. **The contrast** (30s): "GitHub shows you what changed. This shows you what changed,
   who decided, what they checked, and proves it afterwards. And every agent was a
   first-class citizen — its own fork, its own token, its own trial."

**What makes it un-GitHub:** not the forks (GitHub has those) — the ambient review, the
institutional containment with disclosed exclusions, the judge over contenders, and the
merge commit that carries a verifiable *why*. That last 30 seconds is the entry's thesis.

---

## 7. Risks and blockers, stated plainly

- **License (blocking, user decision).** The OS is proprietary "All rights reserved." The
  entry must be MIT/Apache/BSD. The user must choose; the recommendation is a fresh entry
  repo, permissive from commit one, rather than relicensing the OS under deadline.
- **Leaked secret in history.** A cloud key is in the OS repo's git history. Nothing from
  that history may enter the entry repo. Fresh repo + vendored code only.
- **Split-brain honesty.** The fleet cannot run on Workers. If judges expect "everything on
  Cloudflare," the entry must frame runners explicitly (CI-runner analogy + Containers
  future story). Don't let the video imply the agents execute on the edge.
- **13 days is tight for two systems.** The plan has one buffer day. The cuts list
  (semantic merge, previews, fleet-on-Workers) must hold — scope creep kills this.
- **Artifacts is beta.** APIs may shift mid-build; the Worker should isolate all Artifacts
  calls behind one module so a breaking change is a one-file fix.
- **Demo determinism.** Live models are non-deterministic. The saboteur runs on the scripted
  brain (deterministic by design); the two real contenders get a rehearsed task with a
  known-good solution shape. Rehearse twice; ship the second recording.
- **Model cost/latency.** Three concurrent agents + reviewers on a live model — budget API
  spend and keep turns tight (`max_turns`, token budgets already exist in the schema).
- **The branch is a research-swarm OS, not a git platform.** Its "merge" is chapter text,
  its workspace is a folder, its agents have never pushed code. The git tool, the judge,
  and the Worker are all genuinely new. The moat transfers; the plumbing doesn't.

---

## 8. Suggested entry name (user picks)

- **SwarmGit** — literal; says what it is.
- **Converge** — the contender model in one word: many branches, one merge.
- **Verdict** — taken (the user's startup). Avoid.
- **Moot** — a moot is where contenders argue and a decision is rendered. Short,
  memorable, unclaimed feel. Personal favorite for a competition stage.

---

*Blueprint prepared 2026-10-01 from branch `paper-hardening` @ `56dd7db`. All component
claims verified against the source tree; nothing above describes code that wasn't read.*
