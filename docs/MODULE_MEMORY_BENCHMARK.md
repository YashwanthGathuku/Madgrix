# Module memory: parallel first-pass benchmark

Run on 2026-10-13 on the box (8 vCPU, Node 22) with `npm run bench:memory`. The target is `microsoft/vscode`, a depth-1 clone at HEAD: 20,390 tracked files. Medians are over 3 runs with `--work-ms 0`; the `--work-ms 1` rows are single runs.

`--work-ms N` adds a simulated, CPU-bound per-file "understanding" cost. It is a stand-in for real analysis, not a measured model call.

| Split | Modules (files) | work-ms | 1 worker | 2 workers | 4 workers |
|---|---|---|---|---|---|
| frontend/backend | frontend 6,586 (`src/vs/workbench`, `src/vs/editor`); backend 12,738 (rest of `src/vs`, `extensions`, `build`, …); (root) 1,066 | 0 | 5,059 ms | 3,335 ms (×1.52) | 3,306 ms (×1.53) |
| frontend/backend | same | 1 | 25,544 ms | 16,404 ms (×1.56) | 17,023 ms (×1.50) |
| top-level dirs | 15 modules; largest `src` 12,376, `extensions` 6,727 | 1 | 26,338 ms | 16,516 ms (×1.59) | 16,549 ms (×1.59) |

On Madgrix itself (184 files), 4 workers were slower than 1 (178 ms vs 110 ms, `docs/MODULE_MEMORY.md`): starting the threads costs more than the reading.

## What this shows

- At about 20k files, 2 agents (frontend and backend workers) beat 1 by about 1.5×, both with and without per-file work.
- 4 workers add nothing. The reader gives each worker **whole modules**, so the run takes as long as the largest module: backend has 12.7k of the 20.4k files. Two balanced halves would bound the gain at about 2×. Going beyond that needs splitting large modules into sub-modules, which the reader doesn't do.
- The gain comes from threads, so it depends on cores. These numbers come from one box and a single run per `work-ms 1` row.

Reproduce:

```bash
git clone --depth 1 https://github.com/microsoft/vscode.git /tmp/vscode
npm run bench:memory -- --repo /tmp/vscode --split 'src/vs/workbench/**,src/vs/editor/**;src/vs/platform/**,src/vs/base/**,src/vs/code/**,src/vs/server/**,src/vs/*,src/vscode-dts/**,src/*,extensions/**,build/**,cli/**,test/**,scripts/**,remote/**,resources/**,.*/**,*' --workers 1,2,4 --runs 3 [--work-ms 1]
```
