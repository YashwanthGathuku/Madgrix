// g4a Phase 0 core: agent detection, safe-command classification, compactors,
// token estimate, JSONL log. Deterministic; no network, no LLM.
import fs from 'node:fs';
import { ensurePrivateDir, rotateLog, minimiseArgv, redactDeep, appendPrivate } from './privacy.mjs';
import os from 'node:os';
import path from 'node:path';

export function g4aHome(env = process.env) {
  return env.G4A_HOME || path.join(os.homedir(), '.g4a');
}

// Agent context = an agent env marker. Plain non-TTY alone (e.g. `git status | grep`)
// is NOT treated as an agent unless G4A_NONTTY_IS_AGENT=1, to keep human scripts untouched.
export function keyDir(env = process.env) {
  // tests must never touch the real key dir: under `node --test` an explicit G4A_KEY_DIR is required
  if (env.NODE_TEST_CONTEXT && !env.G4A_KEY_DIR) throw new Error('g4a: G4A_KEY_DIR must be set under node --test (refusing to use the real key dir)');
  return env.G4A_KEY_DIR || path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'g4a-keys');
}

export function agentMarker(env = process.env) {
  if (env.G4A_AGENT === '1') return 'G4A_AGENT';
  if (env.CLAUDECODE) return 'CLAUDECODE';
  for (const k of Object.keys(env)) if (k.startsWith('CODEX_')) return k;
  if (env.GEMINI_CLI) return 'GEMINI_CLI';
  if (env.G4A_NONTTY_IS_AGENT === '1') return 'G4A_NONTTY_IS_AGENT';
  return null;
}

// Token estimate heuristic: ceil(UTF-8 bytes / 4). Same rough rule RTK uses; it is an
// estimate, not a tokenizer. bench/run.mjs optionally cross-checks with js-tiktoken.
export function estTokens(bytes) { return Math.ceil(bytes / 4); }

const GLOBAL_WITH_ARG = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);
const GLOBAL_FLAGS = new Set(['--no-pager', '-P', '--no-replace-objects', '--bare', '--literal-pathspecs', '--no-optional-locks']);

// Split argv into { globals, sub, rest }. Unknown global option => null (pass through).
export function parseArgs(argv) {
  const globals = [];
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (GLOBAL_WITH_ARG.has(a)) { globals.push(a, argv[i + 1]); i += 2; continue; }
    if (/^--(git-dir|work-tree|namespace|config-env)=/.test(a) || GLOBAL_FLAGS.has(a)) { globals.push(a); i++; continue; }
    if (a.startsWith('-')) return null;
    return { globals, sub: a, rest: argv.slice(i + 1) };
  }
  return null;
}

// Any of these anywhere in the args means a tool may be parsing the output: never touch.
const MACHINE_FLAG = /^(--porcelain|-z$|--null|--format|--pretty|--oneline$|--json|--name-only|--name-status|--numstat|--shortstat|--raw$|--patch-with-raw|--short$|-s$|--column|--points-at|--contains|--merged|--no-merged|--list$|-l$|--show-current|--set-upstream|--unset-upstream|-[dDmMcC]$|--delete|--move|--copy|--edit-description|-u$|--track|--abbrev-commit|--graph|-p$|--patch$|-u$|--stat=|--dry-run|-n$|--verbose|-v$|-vv$|--progress|--quiet|-q$)/;

// Returns a compaction kind for a SAFE read command, else null (exact pass-through).
export function classify(argv) {
  const p = parseArgs(argv);
  if (!p) return null;
  const { sub, rest } = p;
  const hasMachine = rest.some((a) => MACHINE_FLAG.test(a));
  const nonOpt = rest.filter((a) => !a.startsWith('-'));
  switch (sub) {
    case 'status':
      // only bare `git status` [-- paths]
      return rest.every((a) => a === '--' || !a.startsWith('-')) ? 'status' : null;
    case 'log': {
      const limit = /^(-n$|-\d+$|--max-count)/;
      const machine = rest.some((a) => !limit.test(a) && MACHINE_FLAG.test(a));
      if (machine || rest.some((a) => /^(-L|-S|-G|--stat|--summary|--follow|--word-diff|--cc|-m$)/.test(a))) return null;
      return 'log';
    }
    case 'diff':
    case 'show':
      // only the --stat summary form, never patches
      return rest.includes('--stat') && !hasMachine && !rest.some((a) => a === '-p' || a === '--patch') ? 'stat' : null;
    case 'branch':
      // listing only: no names given (would create/delete), only -a/-r/--all/--remotes
      return nonOpt.length === 0 && rest.every((a) => ['-a', '-r', '--all', '--remotes', '--no-color'].includes(a)) ? 'branch' : null;
    case 'push': case 'pull': case 'fetch':
      return hasMachine ? null : 'netnoise';
    default:
      return null; // plumbing, porcelain-producing and everything else: untouched
  }
}

export const LOG_CAP = 50;

// Compactors: pure functions of captured output. Return { stdout, stderr }.
export const compactors = {
  status({ alt }) {
    // alt = `git status --porcelain=v1 -b` output (rendered as `git status -sb`)
    return { stdout: alt.stdout };
  },
  log({ alt }) {
    // alt = `git log --format=%h %s (%an, %ar)` output; cap to LOG_CAP lines
    const lines = alt.stdout.split('\n').filter(Boolean);
    let out = lines.slice(0, LOG_CAP).join('\n') + (lines.length ? '\n' : '');
    if (lines.length > LOG_CAP) out += `[g4a] ${lines.length - LOG_CAP} more commits omitted; full output: {TEE} (or G4A_RAW=1)\n`;
    return { stdout: out };
  },
  stat({ raw }) {
    return { stdout: raw.stdout.replace(/^( .*?\|\s+(?:\d+|Bin [^\n]*?))(?: [+-]+)?$/gm, (m, a) => a.replace(/\s+\|\s+/, ' | ')) };
  },
  branch({ raw }) {
    const lines = raw.stdout.split('\n').filter(Boolean).map((l) => (l.startsWith('* ') ? l : l.replace(/^  /, '')));
    const cap = 40;
    let out = lines.slice(0, cap).join('\n') + (lines.length ? '\n' : '');
    if (lines.length > cap) out += `[g4a] ${lines.length - cap} more branches omitted; full output: {TEE} (or G4A_RAW=1)\n`;
    return { stdout: out };
  },
  netnoise({ raw }) {
    const noise = /^(remote: )?(Enumerating objects|Counting objects|Compressing objects|Writing objects|Total \d|Delta compression|Resolving deltas|Unpacking objects|Receiving objects)|^remote: *$|^remote: (Resolving deltas|Total)/;
    const strip = (s) => s.split('\n').filter((l) => !noise.test(l.replace(/^.*\r/, ''))).join('\n');
    return { stdout: strip(raw.stdout), stderr: strip(raw.stderr) };
  },
};

export function altArgs(kind, p) {
  const extra = p.rest;
  if (kind === 'status') return [...p.globals, 'status', '--porcelain=v1', '-b', ...extra];
  if (kind === 'log') return [...p.globals, '-c', 'log.showSignature=false', 'log', '--format=%h %s (%an, %ar)', ...extra];
  return null;
}

export function appendLog(rec, env = process.env) {
  try {
    const home = ensurePrivateDir(g4aHome(env));
    const f = path.join(home, 'log.jsonl');
    rotateLog(f, env);
    const r = { ...rec };
    if (Array.isArray(r.argv)) r.argv = minimiseArgv(r.argv, env);
    appendPrivate(f, JSON.stringify(redactDeep(r, env)) + '\n');
  } catch { /* logging must never break git */ }
}

export function readLog(env = process.env) {
  const f = path.join(g4aHome(env), 'log.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}

export function stats(records) {
  const by = {};
  const tot = { calls: 0, compacted: 0, bytesBefore: 0, bytesAfter: 0 };
  for (const r of records) {
    if (r.event !== 'git') continue;
    const k = r.sub || '?';
    const b = (by[k] ||= { calls: 0, compacted: 0, bytesBefore: 0, bytesAfter: 0 });
    for (const t of [b, tot]) {
      t.calls++;
      if (r.mode === 'compact') { t.compacted++; t.bytesBefore += r.bytesBefore; t.bytesAfter += r.bytesAfter; }
    }
  }
  return { by, tot };
}
