token counter: js-tiktoken o200k_base

| repo | command | exit same | raw bytes | g4a bytes | raw tok | g4a tok | saved | raw ms | g4a ms |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| bench-ky | `git status` | yes | 479 | 99 | 130 | 30 | 76.9% | 12.3 | 59.1 |
| bench-ky | `git log` | yes | 130172 | 4849 | 48265 | 1385 | 97.1% | 8.1 | 48.2 |
| bench-ky | `git log -n 20` | yes | 3894 | 1800 | 1488 | 525 | 64.7% | 3.7 | 38.5 |
| bench-ky | `git diff --stat` | yes | 146 | 93 | 41 | 33 | 19.5% | 13.2 | 46.2 |
| bench-ky | `git show --stat HEAD` | yes | 213 | 210 | 92 | 91 | 1.1% | 3.0 | 46.8 |
| bench-ky | `git branch -a` | yes | 66 | 62 | 21 | 19 | 9.5% | 3.3 | 33.9 |
| bench-ky | `git status` | yes | 479 | 99 | 130 | 30 | 76.9% | 12.3 | 58.5 |
| bench-ky | `git diff` | yes | 1655 | 1655 | 537 | 537 | 0.0% | 12.9 | 47.3 |
| bench-ky | `git status --porcelain` | yes | 77 | 77 | 24 | 24 | 0.0% | 12.9 | 58.6 |
| bench-ky | `git log --oneline -n 20` | yes | 1220 | 1220 | 323 | 323 | 0.0% | 4.4 | 32.1 |
| bench-ky | `git rev-parse HEAD` | yes | 41 | 41 | 25 | 25 | 0.0% | 2.5 | 34.3 |
| bench-ky | `git push bench HEAD:refs/heads/g4a-bench` | yes | 84 | 89 | 34 | 36 | -5.9% | 122.0 | 44.7 |
| bench-ky | `git fetch bench` | yes | 0 | 0 | 0 | 0 | - | 10.5 | 41.9 |
| bench-ky | `git status` | yes | 300 | 60 | 80 | 18 | 77.5% | 5.6 | 44.1 |
| madgrix-g4a | `git status` | yes | 534 | 154 | 146 | 46 | 68.5% | 35.5 | 101.1 |
| madgrix-g4a | `git log` | yes | 124598 | 6089 | 37470 | 1706 | 95.4% | 6.5 | 52.9 |
| madgrix-g4a | `git log -n 20` | yes | 18041 | 2230 | 4917 | 620 | 87.4% | 4.3 | 42.3 |
| madgrix-g4a | `git diff --stat` | yes | 194 | 126 | 45 | 37 | 17.8% | 32.4 | 65.1 |
| madgrix-g4a | `git show --stat HEAD` | yes | 765 | 728 | 213 | 206 | 3.3% | 4.4 | 43.2 |
| madgrix-g4a | `git branch -a` | yes | 121 | 115 | 46 | 43 | 6.5% | 3.3 | 40.4 |
| madgrix-g4a | `git status` | yes | 534 | 154 | 146 | 46 | 68.5% | 30.4 | 80.7 |
| madgrix-g4a | `git diff` | yes | 1440 | 1440 | 506 | 506 | 0.0% | 4.5 | 45.1 |
| madgrix-g4a | `git status --porcelain` | yes | 110 | 110 | 28 | 28 | 0.0% | 5.4 | 42.0 |
| madgrix-g4a | `git log --oneline -n 20` | yes | 1776 | 1776 | 447 | 447 | 0.0% | 5.9 | 50.0 |
| madgrix-g4a | `git rev-parse HEAD` | yes | 41 | 41 | 23 | 23 | 0.0% | 2.9 | 29.4 |
| madgrix-g4a | `git push bench HEAD:refs/heads/g4a-bench` | yes | 87 | 92 | 37 | 39 | -5.4% | 369.0 | 63.6 |
| madgrix-g4a | `git fetch bench` | yes | 0 | 0 | 0 | 0 | - | 8.6 | 42.6 |
| madgrix-g4a | `git status` | yes | 322 | 82 | 92 | 30 | 67.4% | 4.3 | 43.3 |

whole workload: 95306 -> 6853 tokens (92.8%), 287389 -> 23491 bytes (91.8%)
excluding unbounded `git log` (capped to 50 commits): 9571 -> 3762 tokens (60.7%)
note: push rows use a different ref name for the g4a run (g4a-bench-shim), so their byte delta is the ref name, not g4a.
exit-code mismatches: 0
total wall time: real 744 ms, g4a 1376 ms
