# ForgeMark-shaped push race: plain git vs. g4a authority (local only)

Measured 2026-10-27 on the dev box: 8 vCPU Xeon, 15 GB RAM, git 2.47.3, Node 22.23.3, Go 1.27.3.
Everything ran inside a network namespace with loopback only (`unshare -n`), so nothing could
reach github.com, Cursor Origin, Cloudflare or any other host.

## Workload

This is ForgeMark's push-race preset (`scripts/pushrace.sh`):

- 16 concurrent agents, 60 s measured window, no warm-up;
- every agent owns its branch or claim;
- every op is one commit of 1–3 files × 1 KB.

## Results

| target | tool | op measured | ops | ops/s | p50 ms | p95 ms | p99 ms | errors |
|---|---|---|---:|---:|---:|---:|---:|---:|
| bare repo over smart-HTTP (`git http-backend` behind Go `net/http/cgi`, 127.0.0.1) | ForgeMark `-strategy branch` (go-git, in-process) | packfile build + ref update | 16076 | **267.9** | 55.8 | 95.4 | 120.3 | 0 |
| same server, bare repo | `bench/race.mjs plain` (git CLI) | `git add` + `commit` + `push` own branch | 5765 | **95.9** | 160 | 232 | 284 | 0 |
| bare repo, local file transport | `bench/race.mjs plain` (git CLI) | same | 5626 | **93.7** | 163 | 257 | 301 | 0 |
| g4a same-user authority (detect-only) | `bench/race.mjs g4a` | `g4a claim` + commit + `g4a promote` + `g4a release` | 17 | **0.21** | 40379 | 58518 | 58518 | 0 (39 `main_out_of_sync` claim retries) |
| g4a system authority (separate OS user, sudo wrappers, permits) | `bench/race.mjs g4a --system` | same | 18 | **0.23** | 37852 | 52541 | 52541 | 0 (38 claim retries) |
| g4a same-user authority, 1 agent | `bench/race.mjs g4a` (N=1) | same | 12 | 0.20 | 4355 | 8907 | 8907 | 0 |

A g4a op that finishes after the 60 s deadline is still counted, so wall time was about 80 s for
N=16. ops/s uses the real wall time. `g4a verify` returned `ok: true` after every g4a run.

Here is how one uncontended g4a op splits up, as the median of 3 runs with N=1:

| step | time |
|---|---|
| claim | 0.45–1.5 s |
| commit | about 0.1 s |
| promote | 0.8–1.9 s |
| release | about 0.75 s |

## After batch landing (grok/g4a-gaps)

Same machine, same workload (16 agents x 60 s, offline network namespace). `land` now enqueues;
one leader per repo witnesses the combined SHA once and lands every disjoint claim with one
compare-and-swap; authority-backed promote jobs run concurrently (`G4A_LAND_PARALLEL`, default 16).

| target | before ops/s | after ops/s | before p50 ms | after p50 ms | after p95 ms | errors |
|---|---|---|---|---|---|---|
| g4a same-user | 0.21 | **1.28** | 40379 | **10614** | 23106 | 0 |
| g4a system | 0.23 | **1.29** | 37852 | **9477** | 23644 | 0 |

About 6x the throughput and 4x lower median latency, with the same guarantees (one-time signed
permits, exact reviewed SHA per claim, a ledger entry per claim plus the batch record). Plain
git push is still ~95 ops/s: a g4a op is claim + witness + review + release, not one push.

## Entire's published numbers vs. g4a (honest comparison)

Entire's ForgeMark race preset (16 agents, 1-3 files x 1 KB, 60 s, one branch per agent,
vendor-run on their hardware): Entire 418 pushes/s; GitHub 4.7 (rate-limited); Cursor Origin 65;
Pierre 15; GitLab 10. Those are raw branch pushes to a hosted forge.

g4a measures something else: every op here is claim -> signed permit -> witness run -> CAS landing
of the exact reviewed SHA onto `main` -> signed, hash-chained ledger entries -> release, with
claim-scope checks. g4a does **not** beat 418/s and is not close; a governed landing is not a
branch push. Plain local `git push` on this box is the comparable ceiling for raw pushes (see
Results above).

| run (this box, `node bench/race.mjs g4a N S`) | before | after group-committed anchors + lock backoff |
|---|---|---|
| N=16, ops/s | 0.74-0.94 | 1.08 (20 s run; p50 12.4 s) |
| N=1, ops/s | 0.42 | 0.34 (12 s run, 5 ops: within noise) |

Profile (temporary trace, N=1): each authority call is a fresh node process (~80-100 ms boot +
~40 ms reanchor); each ledger append used to write and push its own anchor (~82 ms push); the
authority lock is held ~700 ms per op, which caps serial throughput near 1.4 ops/s. The change:
anchors are written once per locked authority command (and in the daemon within 5 ms / before
each reply) for the latest head, instead of once per entry. Nothing is skipped: every entry is
still chained and signed, rollback checks run before every append, anchors only move forward,
and a crash before a flush is caught up by `reanchorAll()` at next start (test/anchors.test.mjs).
Next steps that would matter more: a long-lived authority process (removes per-call boot and
reanchor), and fewer git spawns per anchor.

## Why ForgeMark can't drive g4a directly

ForgeMark speaks smart-HTTP and pushes plain `refs/forgemark/*` branches with no push options.

The g4a authority's pre-receive (`hooks/pre-receive.mjs`) accepts exactly one update, and only:

- to `refs/heads/agents/<agent>`;
- carrying `-o permit=<authority-signed, one-time permit>`;
- for an active claim.

`main` moves only through `g4a promote`. So every ForgeMark push would be refused, by design.
`bench/race.mjs` reproduces the same shape (N agents, own branch or claim, 1–3 × 1 KB files, 60 s)
and times the whole g4a lifecycle.

## Reading the numbers

**Plain git vs. g4a.** Plain git measures moving a ref. A g4a op measures governed landing on main.
Each op:

- takes an exclusive path claim on the authority and mirrors it locally;
- builds a worktree;
- gets a signed permit;
- pushes to the authority;
- passes the pre-receive scope check;
- runs the witness ladder;
- advances main on the authority, then syncs local main;
- appends to the hash-chained ledger and its anchors;
- releases the claim.

Both sides serialise landings, the daemon (`Authority.serial`) and the authority. So 16 agents do
not add throughput over 1 agent: about 0.2 ops/s either way, while latency grows with queue depth.
That is the cost of linear, verified main. It is not a branch-push number. ForgeMark's `branch`
strategy never lands on main.

**ForgeMark vs. `race.mjs plain`.** ForgeMark builds packfiles in-process with go-git. `race.mjs`
spawns the git CLI three times per op. That accounts for about 268/s vs. about 95/s on the same
server.

**Not comparable to published hosted numbers.** These figures do not compare directly with
Entire's 418/s, GitHub's 4.7/s or Cursor's 65/s:

- those are hosted forges measured over the internet, with TLS, auth, replication and abuse limits;
- these runs are loopback on one box, with no TLS, no auth, no replication and no network RTT;
- the g4a rows measure a different, stronger operation: governed promotion to main, not a branch
  ref update.

## Bug found by this benchmark (fixed)

The first g4a N=16 run had 12–13 promotions refused with `out-of-claim paths: agents/a2/f0.txt`.

The cause was a TOCTOU race in the daemon's mirrored claim. The authority fixed the claim baseline
(the commit its permit diff starts from). Another agent could then land and sync local main before
the local claim ran. The local claim then built its worktree on the newer main, so the push diff
carried the other agent's files.

The fix: the daemon passes the authority's baseline as `expectBaseline` to the local claim. The
local claim now refuses with `main_out_of_sync`, which is retryable and releases the authority
claim, instead of building on a different main. After the fix, N=16 ran with 0 errors and
`verify: ok`. Regression test: `test/race.test.mjs`.

## Reproduce

```bash
# plain (start any smart-HTTP git server, or use a bare repo path for the file transport)
node bench/race.mjs plain http://127.0.0.1:8099/race.git 16 60
node bench/race.mjs plain /path/to/bare.git 16 60
# g4a (self-contained temp repo + authority; --system needs passwordless sudo and self-uninstalls)
node bench/race.mjs g4a 16 60
node bench/race.mjs g4a 16 60 --system
# ForgeMark (github.com/entireio/forgemark @654e95a), against a server you own:
forgemark -remote http://127.0.0.1:8099 -repos fm.git -strategy branch -concurrency 16 \
  -duration 60s -warmup 0s -files-min 1 -files-max 3 -file-size 1024 -token-file <dummy> -object-format sha1
```

## Update, Nov 3 2026 (16 agents, 0 errors, local, offline-capable)
| mode | ops/s | p50 | notes |
|---|---|---|---|
| g4a governed landing, user mode, before | 1.73 | n/a | 24 sync retries |
| g4a governed landing, user mode, after auto-sync + server + cache/adaptive batch | 2.86 | 5.4 s | 0–3 retries, verify ok |
| g4a governed landing, system mode (SO_PEERCRED server) | 2.66–2.71 | 5.7 s | verify ok |
| g4a-push raw branch push, user | 16.48 | 691 ms | permit + scope-checked push, no landing; push step median 146 ms |
| g4a-push raw branch push, system | 16.79 | 651 ms | push step median 143 ms |

Entire's 418/s counts local checkpoint commits with no authority, scope check or witness, so the numbers are not comparable, and g4a does not reach it with governance on. What limits g4a now is the serialized authority lock and CLI boot: claim takes about 1.9 s at 16 agents. Reproduce with `node bench/race.mjs g4a|g4a-push 16 20 [--system]`.

## Per-agent-ref locks (Nov 3 2026, 8 cores, 20 s window, 0 errors in every run)

`permit` now runs under `locks/agent-<id>.d` only (read-only sqlite, no Authority, no ledger write);
claim/land/release take `agent-<id>.d` then the global `lock.d`. Lock order: `land.d -> agent-<id>.d -> lock.d`.
`g4a-push` now starts its timed window after every agent's one-time claim (before, 64 serialized
claims consumed most of the window, so ops/s mostly measured the claim queue).

| Run (claim excluded from window) | before (669b397) | after |
|---|---|---|
| g4a-push 16 user | 21.85 ops/s, p50 434 ms | 20.57 ops/s, p50 496 ms |
| g4a-push 16 system | 21.69 ops/s, p50 457 ms | 20.51 ops/s, p50 510 ms |
| g4a-push 64 user | 31.31 ops/s, p50 1968 ms | 33.57 ops/s, p50 1857 ms |
| g4a-push 64 system | 32.97 ops/s, p50 1901 ms | 32.74 ops/s, p50 1885 ms |

| Governed landing (old harness, claim per op) | before | after |
|---|---|---|
| g4a 16 user / system | 3.00 / 2.97 ops/s | 2.75 / 2.78 ops/s |
| g4a 64 user / system | 2.07 / 2.41 ops/s | 1.89 / 2.24 ops/s |

Reading: within run-to-run noise. On this box raw push is CPU-bound (each op spawns git plus
node hooks); the global lock was not the limiter once `permit` stopped writing. Governed landing is
bounded by serialized main CAS + ledger append (kept serial on purpose) and by `claim`, which still
needs `lock.d` because overlap checks and ledger appends must be serial. What changed is isolation:
a held or slow lock on one agent no longer delays another agent's permit (test/perref.test.mjs).
