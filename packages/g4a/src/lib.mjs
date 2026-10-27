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

// Full parser for git's global options (git(1) "OPTIONS"), used for enforcement. Unlike
// parseArgs (conservative: unknown => no compaction) this knows every global option, records
// the ones that change which repo/config/binaries git uses, and returns null only for input git
// itself would reject. Callers in an agent context treat null as "block" (fail closed).
const G_SEP = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--attr-source', '--super-prefix']);
const G_EQ = new Set(['--git-dir', '--work-tree', '--namespace', '--config-env', '--exec-path', '--super-prefix', '--attr-source', '--list-cmds']);
const G_BOOL = new Set(['-p', '--paginate', '-P', '--no-pager', '--bare', '--no-replace-objects', '--no-lazy-fetch', '--no-optional-locks', '--no-advice',
  '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs', '-v', '--version', '-h', '--help', '--html-path', '--man-path', '--info-path', '--exec-path']);
export function parseGit(argv) {
  const g = { C: [], config: [], configEnv: [], gitDir: null, workTree: null, execPath: null, bare: false, other: [] };
  const set = (o, v) => {
    if (o === '-C') g.C.push(v); else if (o === '-c') g.config.push(v); else if (o === '--config-env') g.configEnv.push(v);
    else if (o === '--git-dir') g.gitDir = v; else if (o === '--work-tree') g.workTree = v; else if (o === '--exec-path') g.execPath = v;
    else g.other.push(o);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (G_SEP.has(a)) { if (i + 1 >= argv.length) return null; set(a, String(argv[++i])); continue; }
    const eq = /^(--[a-z-]+)=(.*)$/s.exec(a);
    if (eq && G_EQ.has(eq[1])) { set(eq[1], eq[2]); continue; }
    if (G_BOOL.has(a)) { if (a === '--bare') g.bare = true; continue; }
    if (a.startsWith('-')) return null;
    return { ...g, sub: a, rest: argv.slice(i + 1).map(String) };
  }
  return { ...g, sub: null, rest: [] };
}
// Config keys an agent must not override per command in a g4a-managed repo: they disable the
// reference-transaction guard / reflog evidence, define aliases, or redirect git's own files.
export const DANGEROUS_CONFIG = /^(core\.hookspath|core\.logallrefupdates|core\.fsmonitor|core\.worktree|core\.gitproxy|core\.sshcommand|alias\..*|include\..*|includeif\..*)$/i;
export const UNPARSABLE_CONFIG = 'include.<unparsable GIT_CONFIG_PARAMETERS>';
// GIT_CONFIG_PARAMETERS as git writes and reads it (sq_quote): whitespace-separated tokens, each
// either 'key=value' (legacy form) or 'key'='value' (git >= 2.31), where a quote inside a quoted
// string is written '\''. Returns the keys, or null when the string is not in that form (callers
// fail closed).
export function parseConfigParameters(str) {
  const keys = []; let i = 0; const n = str.length;
  const sq = () => { // one shell-single-quoted word, possibly glued from 'a'\''b' pieces
    if (str[i] !== "'") return null;
    let out = '';
    for (;;) {
      if (str[i] !== "'") return null;
      const j = str.indexOf("'", i + 1); if (j < 0) return null;
      out += str.slice(i + 1, j); i = j + 1;
      if (str[i] === '\\' && (str[i + 1] === "'" || str[i + 1] === '!') && str[i + 2] === "'") { out += str[i + 1]; i += 2; continue; }
      return out;
    }
  };
  for (;;) {
    while (i < n && /\s/.test(str[i])) i++;
    if (i >= n) return keys;
    const w = sq(); if (w === null) return null;
    if (str[i] === '=') { i++; if (sq() === null) return null; keys.push(w); }
    else keys.push(w.includes('=') ? w.slice(0, w.indexOf('=')) : w);
    if (i < n && !/\s/.test(str[i])) return null;
  }
}
// Every config key a git process will see from the command line and the environment.
export function configKeys(p, env = process.env) {
  const keys = [...p.config.map((v) => v.split('=')[0]), ...p.configEnv.map((v) => v.split('=')[0])];
  const n = Number(env.GIT_CONFIG_COUNT || 0);
  for (let i = 0; i < n && i < 1000; i++) if (env[`GIT_CONFIG_KEY_${i}`]) keys.push(env[`GIT_CONFIG_KEY_${i}`]);
  const gp = parseConfigParameters(env.GIT_CONFIG_PARAMETERS || '');
  keys.push(...(gp ?? [UNPARSABLE_CONFIG]));
  return keys.map((k) => k.trim().toLowerCase());
}

// Subcommands that can change refs, the index, history or the work tree. `read` forms of
// multi-purpose commands (listing tags/stashes/worktrees/notes, reading a symbolic ref, showing
// the reflog) are not writes. Unknown subcommands are resolved as aliases by the shim first.
export const WRITE_SUBS = new Set(['commit', 'push', 'merge', 'rebase', 'reset', 'checkout', 'switch', 'cherry-pick', 'am', 'apply', 'revert', 'pull', 'update-ref', 'branch',
  'tag', 'stash', 'notes', 'symbolic-ref', 'replace', 'commit-tree', 'worktree', 'rm', 'mv', 'restore', 'clean', 'reflog', 'update-index', 'read-tree', 'checkout-index',
  'fast-import', 'filter-branch', 'filter-repo', 'mktag', 'submodule', 'sparse-checkout', 'bisect']);
export function isWrite(sub, rest = []) {
  if (!WRITE_SUBS.has(sub)) return false;
  const pos = rest.filter((a) => !a.startsWith('-'));
  switch (sub) {
    case 'tag': return pos.length > 0 || rest.some((a) => /^-[a-zA-Z]*[dfas]|^--(delete|force|annotate|sign)/.test(a));
    case 'stash': return !['list', 'show'].includes(pos[0]);
    case 'worktree': return pos[0] !== 'list';
    case 'notes': return !['list', 'show', 'get-ref'].includes(pos[0] ?? 'list');
    case 'symbolic-ref': return pos.length > 1 || rest.some((a) => /^(-d|--delete)$/.test(a));
    case 'reflog': return ['expire', 'delete'].includes(pos[0]);
    case 'branch': return !(pos.length === 0 && rest.every((a) => /^(-a|-r|--all|--remotes|--no-color|--color|-v|-vv|--verbose|--list|-l|--show-current|--merged|--no-merged|--contains|--sort=.*|--format=.*)$/.test(a)));
    default: return true;
  }
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
