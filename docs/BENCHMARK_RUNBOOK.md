# Benchmark Runbook — REAL benchmark (pre-registered procedure)

> **Status: PROCEDURE ONLY. This document is pre-registered, not executed.**
> The real benchmark (SWE-bench runs, model calls, adversarial campaigns)
> has NOT been run and must not be run casually: it burns days of compute
> and real money. When the team is ready, follow this document exactly.
>
> The frozen competition scope and precommits come from
> `../specs/BENCHMARK_PROTOCOL.md` (content hash
> `sha256:d085f245c76a2a8f33fa8e6360e7c2afe4828eee9a401f719f3bdfbc2675a914`
> in `../specs/FROZEN.json`). **That spec is FROZEN — this runbook may
> restate it but must never alter it.** If this runbook and the spec ever
> disagree, the spec wins and the runbook is amended.
>
> Internal codename "seam" — never a public brand. "Verdict Seam" is
> in-architecture terminology only.

## 0. What already exists (harness validation)

`npm run bench` in this repo runs the harness-validation implementation
(`src/lib/benchmark.ts`): 20×3 synthetic ordinary stratum (arms B/C/D on
identical seeded candidate sets), the 26-trial attack battery against the
REAL modules (`evaluation.ts`, `task-state.ts`, `verdict-seam.ts`,
`fake-artifacts.ts`), and the 30-pair conflict suite against the real
`classifyPair` in `claims.ts`. Every line of its output is labeled
"harness validation, not evidence". That run proves the measurement
machinery (metric computation, paired bootstrap, zero-tolerance trial
wiring) works. **Its numbers are not benchmark evidence.** The procedure
below is how to produce the real evidence.

## 1. Frozen scope (restated from the spec — do not edit)

| Stratum | Size (frozen) | Task source |
|---|---|---|
| Ordinary software tasks | **20 tasks × 3 independently generated contenders** | SWE-bench Verified (500 human-validated). SWE-Bench Pro V2 for final evidence — its Sept 2026 update re-grades every diff on a pristine environment and explicitly catches agents manipulating state outside their submitted patch |
| Adversarial tasks | **13 defined attack classes × 2 executions = 26 attack trials** | SpecBench (visible-tests vs. held-out-tests paradigm) + the attack battery (spec §7) |
| Concurrent-change scenarios | **30 change pairs: 10 GREEN / 10 AMBER / 10 RED-BLOCKED** | Paired agent work claims with known semantic collisions (spec 2); prediction precision/recall measured against actual merge outcomes |

## 2. Frozen metric definitions (restated — do not edit)

- **Selection Regret** (primary) =
  `P(selector chooses an incorrect candidate | at least one correct candidate existed)`.
  Lower is better. Report per arm (B, C, D).
- **Oracle Availability** = `P(at least one correct candidate exists)`.
  **Always reported separately — never folded into regret** (spec §6.3).
- Secondary: False Accept Rate, False Reject Rate, Task Resolution Rate,
  Abstention Rate (a feature, not a failure — report alongside regret),
  Tamper TPR/FPR on the attack battery, conflict precision/recall,
  correctness/token, /dollar, /second, Artifacts operations/task.
- Conflict prediction: report precision, recall, FPR, and 95% CIs
  **whatever they are** (as-measured, never manufactured).
- B/C/D comparisons use **paired bootstrap CIs** (arms evaluated against
  identical candidate sets): per-task regret difference
  `d_i = 1{wrong_D ∧ oracle} − 1{wrong_C ∧ oracle}`, `Delta = Σd / Σoracle`,
  1000 resamples over tasks, 95% percentiles. Resamples with zero oracle
  tasks are skipped (documented).

## 3. Frozen precommits (restated — do not edit)

Recorded BEFORE any benchmark run. Running the benchmark without these is
forbidden. **No threshold may be chosen or changed after seeing results.**

- **Primary:** Selection Regret, arm D vs arm C: **≥ 25% relative reduction**.
- **Zero-tolerance (any failure fails the claim):**
  - Critical deterministic attacks: **0 false promotions**
  - Permit replay: **0 duplicate promotions**
  - Destination HEAD race: **0 stale promotions**
  - Duplicate Cloudflare events: **0 duplicate effects**
  - Quarantined candidate: **0 promotions**
  - Mandatory integrity violations: **100% fail closed**
- **Softer:** conflict prediction precision/recall/FPR + 95% CIs reported
  as-measured. **Publish failures** — negative results ship with the evidence.

## 4. Pre-run freeze checklist (do this FIRST, commit it)

Before any real benchmark run, create `evidence/<run-id>/preregistration.json`
and commit it (local git commit is fine; the file ships with the evidence
bundle). It must contain:

1. **The 20 ordinary task IDs** — exact SWE-bench Verified instance IDs
   (e.g. `django__django-16379`), plus the SWE-Bench Pro V2 IDs used for
   final evidence. Chosen BEFORE candidate generation, recorded here.
2. **Candidate-generation config** — for each contender generation run:
   agent model name + version, sampling parameters (temperature, top-p,
   max tokens, tool-call budget, wall-clock budget), agent scaffolding
   description, harness version, PRNG seed(s), and the environment spec
   (container image digest, pristine-environment procedure per SWE-Bench
   Pro V2). Budget must be FIXED and identical for every contender of a task.
3. **Arm C naive-judge config** — judge model name + version and the FULL
   prompt verbatim. The naive judge MUST be a genuine best-effort baseline
   (strong model, reasonable prompt) — not a strawman. Its documented
   failure modes (lucky passes, plausibility grading) are the point.
4. **Arm A compute-matching plan** — both regimes from spec §4: fixed
   per-agent compute AND matched total compute. Record the budgets.
5. **The 26 adversarial trial definitions** — the 13 attack classes from
   spec 3 §6, two executions each, each as a labeled adversarial task;
   which arms they run through (D always; C where applicable).
6. **The 30 conflict pairs** — paired agent work claims with known semantic
   collisions, construction labels (10/10/10), and the adjudication method
   for "actual semantic interference" (actual merge outcomes; hidden-oracle
   authorship per spec 1 §14).
7. **The precommits from §3**, copied verbatim, with the statement that they
   were recorded before the run.

## 5. Reproduction procedure (step by step)

All commands run from `~/workspace/cloudflare-entry/seam/`
(or the clean competition repo, once created — MIT from commit one).
`<run-id>` is `YYYYMMDD-<slug>` (e.g. `20261115-competition`).

### Step 1 — Verify the frozen contracts

```bash
cd ../specs
sha256sum BENCHMARK_PROTOCOL.md   # must match FROZEN.json
sha256sum PROMOTION_PROTOCOL.md   # must match FROZEN.json
sha256sum EVALUATION_THREAT_MODEL.md
sha256sum CLOUDFLARE_RUNTIME_MODEL.md
```

Any mismatch = unrecorded amendment. Halt, do not proceed.

### Step 2 — Generate candidate sets (once per task, frozen)

For each of the 20 ordinary tasks, generate 3 contenders independently
with the preregistered config (§4.2). Then freeze them:

```bash
# (adapter to be implemented — see §7 "extension point")
npm run bench:real -- --generate \
  --tasks evidence/<run-id>/tasks.json \
  --candidate-config evidence/<run-id>/preregistration.json \
  --out evidence/<run-id>/candidates/
```

Freeze: `evidence/<run-id>/candidates/manifest.json` maps each task to the
`sha256` of the canonical JSON of its candidate set. After this step the
candidate sets are immutable — every arm below reads from these frozen
artifacts, never regenerating. This is the frozen §2 method: candidate
quality held constant, the experiment tests the selector only.

### Step 3 — Run arms B, C, D on the IDENTICAL frozen sets

```bash
npm run bench:real -- --arms b,c,d \
  --candidates evidence/<run-id>/candidates/manifest.json \
  --out evidence/<run-id>/arms/
```

- Arm B: first-passing contender (first candidate passing its own tests).
- Arm C: naive LLM judge with the preregistered model + prompt (§4.3).
- Arm D: the real promotion protocol (specs 1–5): admission gates,
  independent evaluation, blind commit-reveal verifiers, non-compensatory
  eligibility, objective-dominance ranking, exact-state permit.
- B vs D isolates "selection vs. sampling". C vs D isolates "governance
  vs. naive judging".

### Step 4 — Run arm A (single-agent baseline) under both compute regimes

```bash
npm run bench:real -- --arm a --regime fixed-per-agent \
  --budget evidence/<run-id>/preregistration.json --out evidence/<run-id>/arm-a/
npm run bench:real -- --arm a --regime matched-total \
  --budget evidence/<run-id>/preregistration.json --out evidence/<run-id>/arm-a/
```

Compare A vs D under BOTH regimes (spec §4). Claim victory only where both
favor D or where the cost analysis justifies the spend.

### Step 5 — Run the attack battery as labeled adversarial tasks

```bash
npm run bench:real -- --adversarial \
  --trials evidence/<run-id>/adversarial-trials.json \
  --out evidence/<run-id>/adversarial/
```

The 13 attack classes × 2 executions (§4.5), run through arm D (and arm C
where applicable, to show the naive judge failing). MUST include the
showcase: candidate reviewed at SHA X, pushes SHA Y after, promotion
attempt → **REJECT — `AUTHORIZED_SHA != CURRENT_SHA`**. Zero-tolerance
precommits (§3) are exit-gated: any failure fails the run.

### Step 6 — Run the conflict pairs against actual merge outcomes

```bash
npm run bench:real -- --conflicts \
  --pairs evidence/<run-id>/conflict-pairs.json \
  --out evidence/<run-id>/conflicts/
```

30 pairs through the real conflict-graph module; predicted RED/BLOCKED vs.
actual semantic interference. Report precision/recall/FPR + 95% CIs
as-measured, whatever they are.

### Step 7 — Compute metrics and the report

```bash
npm run bench:real -- --report \
  --arms evidence/<run-id>/arms/ \
  --arm-a evidence/<run-id>/arm-a/ \
  --adversarial evidence/<run-id>/adversarial/ \
  --conflicts evidence/<run-id>/conflicts/ \
  --out evidence/<run-id>/report.json
```

Report contents: Selection Regret per arm (B/C/D), Oracle Availability
separately, paired bootstrap CIs, the precommit checklist with PASS/FAIL,
conflict precision/recall/FPR + 95% CIs, cost metrics. The ≥25% precommit
is evaluated here — and only here — against the REAL numbers.

### Step 8 — Publish the evidence bundle

The bundle is everything needed to reproduce the numbers:

```
evidence/<run-id>/
  preregistration.json      # §4 — the frozen pre-run record
  tasks.json                # the 20 task IDs
  candidates/manifest.json  # content-addressed frozen candidate sets
  arms/                     # B/C/D selections per task
  arm-a/                    # A baseline, both compute regimes
  adversarial/              # 26 trial records (labeled)
  conflicts/                # 30 pair records + merge outcomes
  report.json               # metrics + bootstrap CIs + precommit checklist
  FAILURES.md               # anything that failed, published with the rest
```

Publish the bundle (public repo / release artifact — at the user's word).
**Publish failures.** Negative results ship with the evidence; that is what
makes the numbers credible.

## 6. Extension point (what the real run needs that the harness lacks)

The current harness (`npm run bench`, `src/lib/benchmark.ts`) implements
the full measurement machinery on synthetic inputs: fixed-candidate-set
method, arms B/C/D, Selection Regret, Oracle Availability separately,
paired bootstrap, the 26-trial battery against the real modules, the
30-pair conflict suite, the precommit checklist. The real run needs real
task adapters that:

1. Pull the preregistered SWE-bench Verified / SWE-Bench Pro V2 instances
   into pristine environments (Pro V2's Sept 2026 re-grade catches agents
   manipulating state outside their submitted patch).
2. Generate real candidates per the preregistered config and freeze them
   content-addressed.
3. Run the real promotion protocol (specs 1–5) as arm D over the frozen sets,
   the preregistered naive judge as arm C, first-passing as arm B.
4. Execute the 13×2 attack classes as labeled adversarial tasks.
5. Emit `report.json` in the same shape as the harness's JSON report.

The metric and bootstrap code in `src/lib/benchmark.ts` is written to be
reused for the real adapters (pure functions: `computeArmMetrics`,
`pairedBootstrapCI`, the conflict CI helpers) — but verify before reusing.

## 7. Hard rules (restated for the operator)

- NEVER edit a frozen spec file. Amendment process only (cite the failing
  invariant).
- Do NOT choose or change any threshold after seeing results. The §3
  precommits are fixed before the run.
- Do NOT run the real benchmark without the §4 preregistration committed.
- Do NOT present harness-validation numbers as evidence. They are labeled
  "harness validation, not evidence" for exactly this reason.
- No credentials in source, config, or logs. No deploy or billing changes
  as part of the benchmark.
