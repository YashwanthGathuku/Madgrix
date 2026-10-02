# Demo Script — Verdict Seam (~7 minutes)

A narrated, fully scripted walkthrough of the vertical slice. Everything below is
deterministic harness code — **no unscripted LLM behavior anywhere**, so the demo
cannot go off-rails. Run each command exactly as written.

**Backup rule:** screen-record one clean run beforehand. If anything goes wrong live,
play the recording — the slice's *outcomes* are stable across runs even though its
*IDs* (task hashes, nonces, tokens, permit values) are fresh each run. Never read
random hex aloud; read the *assertions* (ACCEPT, QUARANTINED, ALREADY_CONSUMED,
VERIFIED).

---

## 0:00–0:30 — Frame it (say this)

> "When AI agents write code, who decides what ships — and on what evidence? This is
> Verdict Seam: agents compete on the same task, their work is checked against tests
> they never see, blind verifiers judge anonymized code, fixed rules pick a winner,
> and only the *exact* reviewed code can ship — with a signed proof you can verify
> offline. Watch the whole loop run in one command."

```bash
npm install   # if not already done
```

## 0:30–1:30 — Credibility first: the test suite

```bash
npm test
```

**Say:** "74 tests, 20 suites, all green — including the slice itself as an integration
test." **Expected:** `ℹ tests 74 / ℹ pass 74 / ℹ fail 0`.

## 1:30–5:30 — The money: the full loop

```bash
npm run slice
```

The task: *"`isTokenExpired` returns true iff `exp <= now`"*. Three contenders, four
blind verifiers. Narrate the beats as the 12 stages scroll:

| Stage | Say this | Expected line shape |
|---|---|---|
| [1] Freeze task | "The intent becomes a task record. The task hash pins the intent, the baseline, and the policy — nothing can be swapped later." | `task task_slice_001 frozen` |
| [2] Work claims | "Three agents register their plans. A contract conflict on the `JWTClaims` class is flagged RED — it's tracked, not hidden." | conflict classification `RED` |
| [3] Forks | "Each contender gets its own fork and a short-lived write token — its own fork *only*." | three fork repos, tokens minted |
| [4] Contender work | "Three push: one correct, one subtly wrong at the boundary, one that tampers with the test files." | candidate SHAs `4f06e3ae8aaf` (c1), `a891c146703e` (c2), `7ca4335cd9ec` (c3) — **these are stable** |
| [5] Queue ingestion | "Events arrive at-least-once and unordered; duplicates are deduped, unknown repos rejected." | `ACK_DUP` on the redelivery |
| [6] Evaluation | **Money scene 1.** "The tamperer's test manifest doesn't match the baseline hash. That's a *mechanical* violation — no accusation needed — so contender-3 is quarantined: token revoked, removed from selection, evidence frozen." | `QUARANTINED`, token revoked |
| [7] Blind verifiers | "Verifiers commit to their judgments *before* seeing anonymized code. One reveals with the wrong nonce — report inadmissible, no retry. That's a frozen rule." | `VERIFIER_REPORT_INADMISSIBLE` |
| [8] Verdict seam | **The decision.** "Fixed rules: correctness first, then regressions, security, blast radius, minimality — then a blind 2-of-3 vote." | `ACCEPT`, winner contender-1 |
| [9] Permit + promotion | **Money scene 2.** "The permit binds the exact code, baseline, and destination. Present it twice — the second is a no-op." | `PROMOTED`, then replay → `ALREADY_CONSUMED` |
| [10] Attestation | "Every step is chained into signed in-toto statements — one bundle, DSSE-signed." | `.slice-output/promotion.bundle` written |
| [11] Offline verify | "And the proof, checked with no network against the pinned authority key." | 10-line transcript + `VERIFIED`, then `SLICE OK` |

**Do not read hashes aloud.** The candidate SHAs above and the baseline prefix
`cb8e6dc15090` are the only values stable across runs; everything else (task hash,
nonces, commitments, token IDs, permit values) is fresh per run.

## 5:30–6:15 — The proof, slowly

```bash
npm run verify -- --trust-key .slice-output/authority.pub .slice-output/promotion.bundle
```

**Say:** "This is the moment that matters. A third party — an auditor, a customer,
anyone — checks the promotion with nothing but the bundle and the authority's public
key, pinned out of band. A key inside the bundle proves nothing." Read the ten lines:

```
subject digest........ OK
candidate digest...... OK
chain integrity....... OK
hidden evaluation..... PASSED
policy digest......... OK
destination parent.... OK
authority key......... PINNED
signature............. VALID
permit id............. RECOMPUTED FROM BOUND FIELDS
ledger chain.......... OK

VERIFIED
```

## 6:15–6:45 — Tamper-rejection showcase

```bash
cp .slice-output/promotion.bundle /tmp/tampered.bundle
node -e "
const fs=require('fs'), p='/tmp/tampered.bundle';
const b=JSON.parse(fs.readFileSync(p,'utf8'));
const s=b.statements[0].signatures[0];
s.sig = s.sig.slice(0,10) + (s.sig[10]==='A'?'B':'A') + s.sig.slice(11);
fs.writeFileSync(p, JSON.stringify(b));"
npm run verify -- --trust-key .slice-output/authority.pub /tmp/tampered.bundle
```

**Say:** "One flipped character in one signature." **Expected:** `chain integrity.......
FAIL`, `signature............. FAIL`, `NOT VERIFIED`, exit code 1. "The proof is
fragile on purpose — that's what makes it trustworthy."

## 6:45–7:00 — The benchmark harness, and close

```bash
npm run bench -- --quick
```

**Say:** "The benchmark harness runs 13 attack classes twice each against the real
protocol modules. Watch the last line." **Expected:** `"zero_tolerance_ok": true` —
zero false promotions, zero stale promotions, zero duplicate effects, 100% fail-closed.

**Close:** "Forks are commodity. Adjudication plus enforcement plus verifiable
promotion — that's Verdict Seam."

---

## Pre-flight checklist (day before)

- [ ] Fresh clone/machine: `npm install` works with no cache.
- [ ] `npm test` → 74/74. `npm run slice` → ends `SLICE OK`.
- [ ] Screen-record one clean full run; keep the file as the live-failure backup.
- [ ] Terminal font large enough to read on video; clear scrollback before each command.
- [ ] If showing the tamper scene, rehearse the `node -e` one-liner once.
