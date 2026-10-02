# Submission Checklist — Madgrix

**Competition:** Cloudflare "Build the next Git platform" — **deadline Oct 14, 2026.**
License requirement: MIT, Apache, or BSD. This repo is **MIT** (`LICENSE`,
copyright 2026 Yashwanth Gathuku).
**Public repo:** `github.com/YashwanthGathuku/Madgrix` (pushed 2026-10-01).

Each requirement is mapped to where it lives in this repo. Items marked ⬜ need a
user decision or remaining work.

## Requirement → repo location

| # | Requirement | Status | Location |
|---|---|---|---|
| 1 | Working code built on Cloudflare primitives | ✅ Prototype (local) | `src/worker/` (Worker router), `src/do/TaskAuthority.ts` (Durable Object), `src/lib/` (protocol), `./specs/CLOUDFLARE_RUNTIME_MODEL.md` (runtime model) |
| 2 | Agent-native Git concept | ✅ | `README.md` ("Why it matters"); `./specs/PROMOTION_PROTOCOL.md` (FROZEN-v1) |
| 3 | End-to-end demo | ✅ Script; ⬜ recording | `docs/DEMO_SCRIPT.md` (7-minute narrated script, exact commands + expected output) |
| 4 | Architecture documentation | ✅ | `docs/ARCHITECTURE.md` + `docs/architecture.svg` (mermaid + rendered SVG) |
| 5 | Security / threat model | ✅ | `docs/SECURITY.md`; normative spec `./specs/EVALUATION_THREAT_MODEL.md` (FROZEN-v1) |
| 6 | Open-source license (MIT/Apache/BSD) | ✅ MIT | `LICENSE` |
| 7 | Reproducible on a fresh machine | ✅ | `README.md` Quickstart: `npm install` → `npm test` → `npm run slice` → `npm run verify` → `npm run bench` (all local, no credentials/network) |
| 8 | Honest claims (no vaporware) | ✅ | "Honest limitations" in `README.md`; benchmark harness labeled synthetic in `README.md` and `src/lib/benchmark.ts` |
| 9 | Attack-resistance evidence | ✅ Harness-level | `npm run bench -- --quick` → `"zero_tolerance_ok": true` (13 attacks × 2 trials against the real protocol modules); full benchmark on real datasets is future work |

## Verification evidence (all re-verified 2026-10-01)

- `npm test` → **105 tests, 26 suites, 0 failures** (includes the slice as an
  integration test).
- `npm run slice` → exit 0, ends with **`SLICE OK`**; outcomes deterministic across
  runs (verdict ACCEPT, winner contender-1, contender-3 quarantined, permit replay
  `ALREADY_CONSUMED`, bundle `VERIFIED`).
- `npm run headmove` → exit 0, ends with **`HEAD-MOVE OK`** (destination head move →
  permit `EXPIRED_HEAD_MOVED` → re-evaluation → re-promotion, exactly one write).
- `npm run verify -- .slice-output/promotion.bundle` → 8-line transcript +
  `VERIFIED`, exit 0.
- Tamper check: one flipped signature byte → `NOT VERIFIED`, exit 1.
- `npm run bench` → exit 0, `"zero_tolerance_ok": true` (13 attacks × 2 trials
  against the real protocol modules).

## Remaining work (⬜)

1. **Demo video recording.** The script is written (`docs/DEMO_SCRIPT.md`) with a
   pre-rendered backup plan; the actual recording is still to do.
2. **Live Cloudflare end-to-end.** The prototype runs against the in-memory
   `FakeArtifacts` stand-in; a live E2E needs a direct-egress machine or deploy
   permission — see `docs/PRODUCTION_DEPLOYMENT.md` for the exact post-deploy
   smoke test.
3. **Real benchmark run.** The harness is validated on synthetic inputs
   (explicitly labeled, not evidence); the pre-registered procedure for the real
   run on SWE-bench/SpecBench is `docs/BENCHMARK_RUNBOOK.md`.
4. **Full trademark search** on "Madgrix" + legal review before launch
   (screening only so far — `docs/NAME_SHORTLIST.md`).
5. **Deadline.** October 14, 2026.

## Known non-blockers (documented, not hidden)

- Deterministic verifier stand-ins (no LLMs) in the slice; judgments are scripted,
  ordering guarantees are real.
- Ed25519 slice signer vs production Sigstore (identical DSSE envelope shape).
- Remote Artifacts binding untested from this sandbox.
- Benchmark harness is synthetic/harness-validation — explicitly not competition
  evidence.
