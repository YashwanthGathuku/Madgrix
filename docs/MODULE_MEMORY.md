# Module memory

When a parent agent forks a repository, module memory reads the whole tree once, divided by module, and keeps one memory card per module. One owner keeps each module's memory, so later work doesn't re-read the whole tree. When a change touches a module, the main agent wakes only that module's agent, which answers from its card.

Everything here is **deterministic and model-free**. No language model is called. The optional summary hook (`buildModuleCard(..., summarize)`) is off by default, and no caller in this repository turns it on.

## Status

| Part | Status |
|---|---|
| Map: split by top-level path, config globs (`configs/module-memory.json`), or a fork-crew `.madgrix/subagent-intents.json` (`modulesFromSubagentIntents`) | **Built**, tested |
| Read: one card per module, serial or N `worker_threads` (`scripts/lib/module-reader.ts`) | **Built**, tested: parallel cards equal serial cards |
| Reduce: repo map, cross-module edges, tests that import a module | **Built**, tested |
| Incremental refresh from `git diff --name-only` | **Built**, tested: the refreshed map equals a full re-read |
| Change routing by path ownership or exact symbol or file-name tokens | **Built**, tested |
| `ModuleAgent` Durable Object (`src/do/ModuleAgent.ts`) and Worker `POST /module-agents/{load,wake,memory,route}` | **Built**, tested in Node on in-memory storage. **Deployed** with the `madgrix` Worker (class provisioned); no live module-memory run recorded |
| Routing record attached to a WorkGraph (`withModuleRouting`) | **Built**, display only. It isn't persisted in `TaskAuthority` or shown on the HTML page yet |
| Module agent *doing the code change* with its memory | **Planned**. Today the woken agent returns its card and the matched file facts. Nothing runs an edit |
| WebSocket hibernation, LLM summaries, cross-repo memory | **Planned / not built** |

## Pipeline (`src/lib/module-memory.ts`)

1. **Map:** `splitModules(files, config?)`. With a config, a file belongs to the *first* module whose globs match it, and unmatched files go to `(root)`. Without one, each top-level directory is a module. A `"**"` scope is refused, the same rule as path claims.
2. **Read:** `buildModuleCard`. A card holds, per file: lines, language, exported names, raw import specifiers, entry-point reason (shebang, Python `__main__`, Worker `export default { fetch }`), and whether it is a test. It also carries `built_from_sha` and a `content_digest` over the module's `(path, blob)` pairs. Extraction uses regular expressions for TS/JS and Python. Other files count only as files and lines.
3. **Reduce:** `reduceRepoMap`. Imports are resolved **here**, against the current file list, not inside a card. A reused card therefore can't keep a stale resolution when another module adds or removes a file.
4. **Refresh:** `planRefresh` re-reads a module when any of its files changed at either SHA, or when its card wasn't built from the diff base. Every other card is reused and re-pinned (`repinCard`) to the new SHA.
5. **Route:** `routeChange` maps changed paths to their owning module. It also maps request text to modules by *exact* exported-symbol or file-basename tokens. Paths that no module owns are reported as `unowned`, and no agent wakes for them.

## Cloudflare fit

- **One Durable Object per module:** the name is `moduleAgentName(repo, module)`, which encodes repo, module id and sorted path globs. The object refuses any request that carries a different identity (409 `module_identity_mismatch`).
- **Sleep and wake:** the object holds nothing in memory between requests. The card and meta (wake count, last 50 routed changes) live in DO storage. An idle object can therefore be evicted and comes back from storage on the next request. This is plain idle eviction. **It doesn't use the WebSocket Hibernation API.** "Wake" is a request that bumps `wake_count`, not a resident process.
- **Pinned memory:** `/memory` and `/route` answer 409 `stale_memory` when the caller's SHA isn't `built_from_sha`. `/route` also refuses a routing record that doesn't name this module.
- **Config:** `cloudflare.config.ts` declares `ModuleAgent` (sqlite storage) and the `MODULE_AGENT` binding. **Deployed** (the class exists on the `madgrix` Worker; `competition/queue-ancestry-reconciliation` d17e656 keeps it in the config). Without the binding, the Worker answers 503 `module_agents_not_configured`. The routes require `CONTROL_SERVICE_TOKEN`.

## Fit with the fork crew

The fork crew's sub-agents (`sub-api`: `src/api/**`, `sub-ui`: `src/ui/**`) already claim path globs. `modulesFromSubagentIntents()` turns those claims into module definitions, so each sub-agent owns exactly the memory of the paths it claims. Routing reuses the same glob semantics as claims.

## Demo: `npm run demo:memory`

The demo works in throwaway clones under the OS temp dir and makes no network calls. Numbers from one run on the box (Node 22), at commit `ed6b756`:

| Target | Files / modules | First pass serial | First pass 4 workers | Edit | Second pass reads |
|---|---|---|---|---|---|
| Madgrix (`configs/module-memory.json`) | 184 / 11 | 110 ms | 178 ms | `src/lib/permit.ts` | **25/184 files = 13.6%** (1 module re-read, 10 reused) |
| `third_party/theustad` (top-level split) | 14 / 2 | 21 ms | 94 ms | `theustadlib/claims.py` | 11/14 files = 78.6% (1 module re-read, 1 reused) |

In both runs only the owning agent woke: Madgrix 1 of 11, theustad 1 of 2. In both, the refreshed map equaled a full re-read at the new SHA.

## Honest limits

- **Parallel is slower at these sizes.** Starting `worker_threads` costs more than reading 184 files. The parallel reader exists for larger trees, but no speedup has been measured here. The demo prints both timings.
- **The reuse ratio depends on module granularity.** theustad has one big package, so one edit re-reads 79% of it.
- **Extraction is regex-based.** It misses re-exports like `export * from`, computed exports, dynamic import paths, and Python `__all__`. Package imports such as `node:fs` aren't edges. The Madgrix map reports 2 relative imports it couldn't resolve.
- **Routing from request text is exact token matching.** It has no semantic understanding.
- **A module agent doesn't edit code yet.** Only the memory and routing are built.
- **Deployed, not exercised live:** the ModuleAgent class is provisioned, but no live run has loaded or woken a module agent on Cloudflare.
