# Decision record — 2026-10-06: name framing + loose items

**Branch:** `competition/final` (submission line) · **Date:** 2026-10-06
**Status:** OPEN — two decisions awaiting the operator's word. Nothing here is accepted by being written down.

This record exists so the choices are reviewable in one place: what happened,
what each option costs, and what happens with and without each choice.

---

## 1. What happened — the two-name story

Verified 2026-10-06 against `competition/final @ 44fd44e` and `main @ f85f623`:

- **Recorded decision (2026-10-01):** the product is **Madgrix** (`docs/NAME_SHORTLIST.md`).
- **Trademark screen (2026-10-05, live USPTO TESS/TSDR):** no federal word-mark for
  "Madgrix" or "MAGDRIX". MADRIX is live (inoage GmbH, LED-lighting controls,
  classes 009/042) and MADGICX is live (MADGICX LTD., ad-tech software, classes
  009/035/042) — both different spelling and different industry. Federal records
  only; state, common-law, and non-US marks were not searched. This was a records
  screen, not a legal opinion. **"Git4Agents" was never screened.**
- **On the submission branch right now:** `README.md` line 1 is `# Git4agents`.
  "git4agents" appears **101 times across 20 files** (README title/body, docs,
  config filenames `git4agents-demo-composition.yaml` / `git4agents-fork-crew.yaml`,
  scripts, one test). **Every functional identifier is already madgrix:**
  `package.json` name, workers `madgrix` / `madgrix-promotion`, queue
  `madgrix-events`, `MADGRIX_*` env vars, `.madgrix/` paths.
- **The demo script commits to both names on camera.** `docs/VIDEO_DEMO_SCRIPT.md`
  (introduced by operator commit `9944c05`, 2026-10-06) contains spoken lines:
  - *"MADGRIX is the product that records which exact state may become canonical.
    Git4Agents is the collaboration protocol underneath it…"*
  - *"Git records completed states. Git4Agents coordinates autonomous work while it
    is happening. MADGRIX determines which exact resulting state earns authority
    to become canonical."*
- **On `main`, the split is already resolved:** README is `# Madgrix`; the only
  remaining "Git4agents" traces are the archived remote branch name
  `origin/git4agents/combined` and historical prose inside the unpushed field-report
  commit.

### Decision 1A — Bless the split deliberately (MADGRIX = product, Git4Agents = protocol)

**With:**
- Add one explicit line to the submission README stating the split
  (e.g. "MADGRIX is the product; Git4Agents is the collaboration protocol it
  implements"), matching what the demo script already says on camera.
- Zero functional changes, zero test risk — identifiers already agree.
- The trademark position stays as screened: Madgrix covered, Git4Agents unscreened
  (note the residual as an accepted, documented risk).

**Without (i.e. leave it unblessed):**
- The submission tells the two-name story anyway (README + demo script), but
  without a sentence that says it is intentional — a judge or reviewer may read it
  as drift or indecision.

### Decision 1B — Sweep to a single name before recording

**With:**
- Cosmetic-only sweep of the ~101 occurrences / 20 files on `competition/final`
  (README title + body, docs, the two config filenames, script log prefixes, one
  test). Zero functional risk: no worker, queue, env var, or package name changes.
- The demo script's spoken lines must be rewritten to match before recording.
- True deadline: **before the video is recorded**; outer bound is the Oct 14
  submission.

**Without:**
- Status quo stands: README says Git4agents, everything functional says madgrix,
  demo script pairs both names.

---

## 2. What happened — the two loose items

Verified 2026-10-06. `main @ f85f623` working tree holds exactly two uncommitted items:

1. **M `research/RESEARCH.md`** — one-line change adding the verified arXiv URL to the
   Zhou citation: `arXiv:2607.05904 · https://arxiv.org/abs/2607.05904`
   (URL verified 2026-10-05; content independently verified by collaborator review).
2. **Untracked `specs/amendments/benchmark-metric-calibration.md`**
   (`Status: proposed`, dated 2026-10-06) — pre-run metric discrimination gate for
   the benchmark: random selector as negative control, mechanical arm B as
   reference, oracle as positive control, with a precommitted floor on
   discriminating tasks recorded before candidate generation. The literal DRF
   formula from the Nature Biotech paper degenerates for Selection Regret (the
   oracle hits the optimum by construction), so the draft uses this analog instead.
   Frozen specs untouched; the ≥25% threshold, zero-tolerance gates, and
   "no threshold after seeing results" rule unchanged.

**Neither item is on `competition/final @ 44fd44e`** (the submission line):
its `RESEARCH.md` still reads "(arXiv; independently verified by collaborator
review)" with no URL, and its `specs/amendments/` holds 15 files — none of them
the new one. The demo script says to cite the Zhou paper *in the demo, not just
the docs*.

**Clarification (removes a phantom step):** `preregistration.json` is not a
standing file to fix now. Per `docs/BENCHMARK_RUNBOOK.md` §4 it is created
per-run at `evidence/<run-id>/preregistration.json` and committed before
candidate generation. The amendment's floor values (discriminating-task count,
G threshold, regenerate cap — currently `[OPEN]`) land there at run setup,
**after** the accept/reject decision. Nothing to do there tonight.

### Decision 2 — Commit the loose items on main, then cherry-pick to `competition/final`

**With:**
- Zhou citation fix (verified, docs-only, zero risk) lands on the submission
  branch — the demo cites it on camera, so the branch should carry the URL.
- Amendment rides along as `Status: proposed` — recorded, not accepted.
  Accept/reject remains the operator's call and gates the real benchmark run
  (which burns days of compute and real money per the runbook).
- No push involved in either step: `competition/final` is in sync with
  `origin/competition/final`; `main` is 1 commit ahead of `origin/main` with a
  bundle backup on disk.

**Without:**
- Submission branch keeps the citation without a URL — weaker provenance for the
  single most important number in the architecture (0.719 → 0.012), cited on camera.
- The amendment draft lives only in main's uncommitted working tree.

---

## 3. Branch map (2026-10-06, verified)

| Branch | Tip | State |
|---|---|---|
| `main` (local) | `f85f623` | 1 ahead of `origin/main` (field report, unpushed); working tree: 2 loose items above; bundle backup `~/workspace/backups/madgrix-field-report.bundle` |
| `origin/competition/final` | `44fd44e` | submission line; in sync locally; 17 ahead of combined; 331/331 tests green; 7 frozen spec hashes byte-identical to FROZEN-v1 |
| `origin/git4agents/combined` | `4d97905` | archived branch of record; strict ancestor of `competition/final` |
| `origin/main` | `6a03a3c` | Oct 1 |

## 4. Open calls (operator's word only)

1. Two-name story: bless the split (1A) or sweep to one name before recording (1B).
2. Loose items: commit on main + cherry-pick to `competition/final`.
3. Benchmark amendment: accept or reject (gates the real run; floor values still `[OPEN]`).
4. Field report: merge vs cherry-pick onto the submission line, then push.
5. Demo video recording.
