# MADGRIX Competition Demo — Live Path (~7 minutes)

The primary competition demo should use the deployed Cloudflare path. The
deterministic local slice remains the backup, not the headline.

## Pre-flight

Before recording:

```bash
npm install
npm run typecheck
npm run build
npm test
npm run slice
npm run headmove
npm run bench
```

Then deploy and complete the setup in `docs/PRODUCTION_DEPLOYMENT.md`. Run
`npm run live:e2e` once off-camera and preserve the successful transcript and
promotion bundle.

## 0:00–0:40 — Problem

> “When several autonomous coding agents work on the same repository, Git can
> tell us what changed. It does not decide which agent should be trusted to
> ship, whether the evaluation was independent, or whether the code that
> shipped is exactly the code that was reviewed. MADGRIX is that missing
> promotion layer.”

Show the architecture diagram and the pipeline:

```
INTENT → WORK CLAIMS → ISOLATED CONTENDERS → INDEPENDENT EVIDENCE
       → VERDICT SEAM → EXACT-STATE PERMIT → PROMOTION → PROOF
```

## 0:40–1:30 — Intent before code

Show the live task creation and WorkClaims from the `live:e2e` transcript.

Explain that each agent publishes its intended behavioral/scope claim before
working. MADGRIX compares claims for path, symbol, dependency, contract,
interface, and schema interactions. The conflict graph is evidence for
coordination and blast radius; it is not an LLM guessing from prose after the
code already exists.

## 1:30–2:30 — Three real agents, three Artifact repositories

Run or replay the successful:

```bash
npm run live:e2e
```

Highlight:

- three coding-agent processes launch concurrently;
- each receives its own Artifact repository and short-lived write credential;
- the native Artifacts fork is attempted first;
- the documented beta fork failure uses the baseline-import fallback;
- each agent pushes a real immutable Git candidate.

Do not call the import fallback a native Cloudflare fork.

## 2:30–3:15 — Real event-driven coordination

Show the point where the orchestrator waits for the real
`cf.artifacts.repo.pushed` events.

> “This is not polling a fake repository map. Candidate pushes enter a
> Cloudflare Queue. Delivery can duplicate or reorder, so the per-task Durable
> Object derives a content-addressed event key and makes the effect
> idempotent.”

The live orchestrator fails rather than silently continuing if those events do
not reach TaskAuthority.

## 3:15–4:20 — Independent evaluation and blind verification

Show the evaluator stage.

The evaluator receives a short-lived **read-only** credential for one
candidate, checks out the exact candidate SHA, recomputes `tree-digest/v1`,
checks baseline/scope/tamper gates, and runs the configured independent test
commands.

Then show verifier commitment/reveal/report:

> “Verifier reference reports are committed before candidates are exposed.
> Reports are signed. Failed integrity gates cannot be compensated by style,
> confidence, or an LLM preference.”

MADGRIX's authority is the protocol and mechanical evidence—not a model saying
“this looks best.”

## 4:20–5:20 — Verdict Seam and exact-state promotion

Highlight the ACCEPT decision and permit.

The permit binds:

- frozen task hash;
- baseline commit;
- winning SHA-256 tree identity;
- evaluation bundle;
- selector policy;
- exact expected canonical HEAD.

Then show promotion:

> “The trusted promotion container fetches the exact reviewed commit,
> recomputes the independent tree digest, checks the destination parent, and
> fast-forwards canonical main to the candidate commit itself. It does not
> rebuild the commit.”

This is the core proof: reviewed candidate SHA == promoted candidate SHA.

A moved destination HEAD, wrong tree, foreign baseline, consumed permit, or
non-fast-forward race fails closed.

## 5:20–6:10 — Verify the proof offline

Use the bundle emitted by the live run:

```bash
npm run verify -- .madgrix-live/promotion.bundle
```

Expected final result:

```
VERIFIED
```

Explain that the bundle contains signed in-toto-style statements in DSSE
envelopes and the exact promotion authority.

If desired, perform the signature-tamper backup demonstration using a copied
bundle. Never modify the original evidence file.

## 6:10–6:40 — Adversarial evidence

Show:

```bash
npm run headmove
npm run bench
```

State the evidence precisely: the deterministic harness has 26/26 adversarial
trials with `zero_tolerance_ok=true`; this is protocol attack testing, **not**
a claim that MADGRIX improves real-world coding accuracy.

The strongest live follow-up, if recorded, is the commit-swap/HEAD-move case:
authorize SHA X, alter the candidate/destination, and show promotion rejected.

## 6:40–7:00 — Close

> “Cloudflare Artifacts gives every agent a Git-compatible workspace. MADGRIX
> adds the missing decision protocol above it: declare intent, compare
> contenders, evaluate independently, authorize one exact state, and prove
> afterwards that only that state shipped.”

## Recording rules

Use the successful live run as the primary recording. Keep one clean local
`npm run slice` recording as fallback. Never claim a pending benchmark,
Sigstore deployment, or native fork success. Do not read long random hashes
aloud; visually highlight equality between reviewed SHA and promoted SHA.

The best three screens to linger on are:

1. three concurrent contender repositories/candidate SHAs;
2. Verdict Seam ACCEPT + exact-state permit;
3. promoted SHA equality followed by offline `VERIFIED`.
