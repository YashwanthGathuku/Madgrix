// Storage driver behind one interface: open(file, { readOnly }) -> { exec, prepare(sql).{run,get,all}, close }.
// g4a uses only positional parameters and that call surface, which node:sqlite (DatabaseSync) and
// better-sqlite3 implement identically. Selection: G4A_SQLITE_DRIVER = node | better-sqlite3 | auto
// (default auto: node:sqlite when the runtime has it, else better-sqlite3 if installed).
// better-sqlite3 is an optional native dependency resolved from the package, NODE_PATH, or
// G4A_BETTER_SQLITE3 (a directory containing node_modules/better-sqlite3 or the module itself).
import { createRequire } from 'node:module';
import path from 'node:path';

const nodeSqlite = await import('node:sqlite').then((m) => ({ ok: true, DatabaseSync: m.DatabaseSync }), (e) => ({ ok: false, error: String(e.message || e) }));

function loadBetter() {
  const tries = [];
  const req = createRequire(import.meta.url);
  const roots = [process.env.G4A_BETTER_SQLITE3, process.env.G4A_BETTER_SQLITE3 && path.join(process.env.G4A_BETTER_SQLITE3, 'node_modules', 'better-sqlite3')].filter(Boolean);
  for (const r of [...roots, 'better-sqlite3']) { try { return { ok: true, Database: req(r) }; } catch (e) { tries.push(String(e.code || e.message)); } }
  return { ok: false, error: `better-sqlite3 not installed (${tries.join('; ')})` };
}

export function resolveDriver(want = process.env.G4A_SQLITE_DRIVER || 'auto') {
  if (!['auto', 'node', 'better-sqlite3'].includes(want)) throw new Error(`G4A_SQLITE_DRIVER must be node, better-sqlite3 or auto, not ${want}`);
  if (want !== 'better-sqlite3' && nodeSqlite.ok) {
    return { name: 'node:sqlite', open: (f, { readOnly = false } = {}) => new nodeSqlite.DatabaseSync(f, readOnly ? { readOnly: true } : {}) };
  }
  if (want === 'node') throw new Error(`g4a: G4A_SQLITE_DRIVER=node but node:sqlite is unavailable on ${process.version} (needs Node >= 22.5): ${nodeSqlite.error}`);
  const b = loadBetter();
  if (b.ok) return { name: 'better-sqlite3', open: (f, { readOnly = false } = {}) => new b.Database(f, readOnly ? { readonly: true, fileMustExist: true } : {}) };
  throw new Error(`g4a needs a SQLite driver: node:sqlite (Node >= 22.5; this is ${process.version}${nodeSqlite.ok ? '' : `: ${nodeSqlite.error}`}) or better-sqlite3 (${b.error})`);
}

let cached;
export function driver() { return (cached ??= resolveDriver()); }
export function openSqlite(file, opts) { return driver().open(file, opts); }
export const NODE_SQLITE = nodeSqlite;
