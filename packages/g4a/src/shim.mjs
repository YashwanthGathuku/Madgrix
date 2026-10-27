#!/usr/bin/env node
// Invoked by the sh shim when an agent marker is set and stdout is not a TTY, or for any
// caller inside a .g4a/worktrees/ checkout.
// Everything not classified as a safe read command is spawned with inherited stdio.
import { spawn, spawnSync } from 'node:child_process';
import { ensurePrivateDir, pruneTee, writePrivate, redact } from './privacy.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { classify, parseArgs, parseGit, configKeys, DANGEROUS_CONFIG, isWrite, WRITE_SUBS, altArgs, compactors, appendLog, estTokens, g4aHome, agentMarker, keyDir } from './lib.mjs';
import { validOverride } from './override.mjs';

const REAL = process.env.G4A_REAL_GIT;
const argv = process.argv.slice(2);
const env = { ...process.env }; // no recursion-guard variable: an env flag would be a forgeable bypass
const t0 = Date.now();
const p = parseArgs(argv);
const base = { event: 'git', ts: new Date().toISOString(), cwd: process.cwd(), argv, sub: p?.sub ?? null, agent: agentMarker() };

if (!REAL || !fs.existsSync(REAL)) { process.stderr.write('g4a: real git not configured (G4A_REAL_GIT); run g4a doctor\n'); process.exit(127); }

// Agent write commands in a g4a-managed repo are checked by the daemon and BLOCKED when out
// of scope; daemon down => agents fail closed. In an agent context the opt-outs G4A_RAW=1,
// G4A_ENFORCE=0 and G4A_AGENT=0 are IGNORED unless a valid operator-signed override for this
// repo exists (see src/override.mjs); every attempt is logged to the ledger (or the local log
// when the daemon is unreachable). Humans (no agent marker) are never checked.
// Not covered here: calling the real git by absolute path, or editing files directly; the
// Phase 2 authority repo is what closes those for anything that reaches main.
const marker = agentMarker({ ...process.env, G4A_AGENT: process.env.G4A_AGENT === '0' ? '' : process.env.G4A_AGENT });
function managedRepo(dir) {
  let start = path.resolve(dir);
  try { start = fs.realpathSync(start); } catch {}
  if (`${start}/`.includes('/.g4a/worktrees/') || `${path.resolve(dir)}/`.includes('/.g4a/worktrees/')) return true;
  for (let d = start; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.g4a', 'worktrees'))) return true;
    if (fs.existsSync(path.join(d, '.git')) || d === path.dirname(d)) return false;
  }
}
function repoCommonDir(cwd) {
  const r = spawnSync(REAL, ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_GLOBAL: '/dev/null' } });
  if (r.status !== 0) return null;
  try { return fs.realpathSync(r.stdout.trim()); } catch { return null; }
}
const honored = {};
if (marker) {
  const asked = [];
  if (process.env.G4A_RAW) asked.push('G4A_RAW');
  if (process.env.G4A_ENFORCE === '0') asked.push('G4A_ENFORCE');
  if (process.env.G4A_AGENT === '0') asked.push('G4A_AGENT');
  if (asked.length) {
    const repo = repoCommonDir(process.cwd());
    const kd = keyDir();
    // phase 2: with an authority, only overrides signed by the authority-side operator key count
    let pubDir = null;
    if (repo) {
      try { pubDir = JSON.parse(fs.readFileSync(process.env.G4A_SYSTEM_MAP_TEST || '/etc/g4a/authority.json', 'utf8'))[repo]?.pub ?? null; } catch {}
      if (!pubDir) { const c = spawnSync(REAL, ['config', '--get', 'g4a.authority'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_CONFIG_GLOBAL: '/dev/null' } }); if (c.status === 0 && c.stdout.trim()) pubDir = path.join(path.resolve(c.stdout.trim()), 'pub'); }
    }
    const ovName = (await import('./override.mjs')).overrideName;
    for (const v of asked) {
      const o = repo && (pubDir ? validOverride(repo, v, kd, Date.now(), { pubFile: path.join(pubDir, 'operator.pub.hex'), file: path.join(pubDir, 'overrides', ovName(repo)) }) : validOverride(repo, v, kd));
      honored[v] = !!o;
      if (!o) process.stderr.write(`[g4a] ignoring ${v} in an agent context (${marker}): no valid operator override for this repo\n`);
    }
    const rec = { cwd: process.cwd(), argv, vars: asked, honored: asked.every((v) => honored[v]), override: Object.fromEntries(asked.map((v) => [v, honored[v]])) };
    appendLog({ ...base, event: 'opt_out', ...rec });
    if (repo && managedRepo(process.cwd())) {
      const { callDaemon } = await import('./check-client.mjs');
      await callDaemon('opt_out', rec, { home: g4aHome(), timeoutMs: Number(process.env.G4A_CHECK_TIMEOUT_MS || 2000) });
    }
  }
}
const isAgent = !!marker && !honored.G4A_AGENT;
if (!isAgent) {
  // humans via the worktree route, or an agent with an honored G4A_AGENT=0 override
  const r = spawnSync(REAL, argv, { stdio: 'inherit', env });
  if (r.signal) process.kill(process.pid, r.signal);
  process.exit(r.status ?? 1);
}
// ---- agent-context enforcement (F1/F2 of the red-team review) ----
// Parse every git global option; anything git itself would not accept is blocked (fail closed).
const block = (why) => {
  const enforce = !honored.G4A_ENFORCE;
  appendLog({ ...base, event: 'scope_check', blocked: why, enforce });
  process.stderr.write(`[g4a] ${enforce ? 'blocked' : 'warning (operator override)'}: ${why}\n`);
  if (enforce) process.exit(1);
};
const pg = parseGit(argv);
if (!pg) { block('unrecognised git global option in an agent context; g4a fails closed (run the command without it)'); }
const pgx = pg ?? { C: [], config: [], configEnv: [], gitDir: null, workTree: null, execPath: null, sub: null, rest: [] };
// The repo git will actually act on: -C (cumulative), --git-dir/--work-tree and GIT_DIR/GIT_WORK_TREE.
let eff = process.cwd();
for (const c of pgx.C) if (c !== '') eff = path.resolve(eff, c);
const gitDir = pgx.gitDir ?? env.GIT_DIR ?? null, workTree = pgx.workTree ?? env.GIT_WORK_TREE ?? null;
const managed = [eff, gitDir && path.resolve(eff, gitDir), workTree && path.resolve(eff, workTree)].some((d) => d && managedRepo(d));
let sub = pgx.sub, rest = pgx.rest;
if (managed) {
  const keys = configKeys(pgx, env);
  for (const f of [env.GIT_CONFIG_GLOBAL, env.GIT_CONFIG_SYSTEM, env.GIT_CONFIG].filter((x) => x && x !== '/dev/null')) {
    const r = spawnSync(REAL, ['config', '--file', f, '--name-only', '--list'], { encoding: 'utf8', env: { PATH: env.PATH, HOME: env.HOME } });
    if (r.status === 0) keys.push(...r.stdout.split('\n').filter(Boolean).map((k) => k.toLowerCase()));
  }
  const bad = keys.filter((k) => DANGEROUS_CONFIG.test(k));
  if (bad.length) block(`config override ${[...new Set(bad)].join(', ')} is not allowed for agents in a g4a-managed repo (it would disable the ref guard, define an alias or redirect git)`);
  if ((pgx.execPath !== null && sub) || env.GIT_EXEC_PATH) block('--exec-path / GIT_EXEC_PATH is not allowed for agents in a g4a-managed repo');
  // aliases: resolve (non-builtin names only; git ignores aliases that shadow builtins)
  const READS = new Set(['status', 'log', 'diff', 'show', 'fetch', 'ls-files', 'ls-tree', 'ls-remote', 'rev-parse', 'rev-list', 'cat-file', 'blame', 'grep', 'describe', 'shortlog', 'help', 'version', 'config', 'remote', 'for-each-ref', 'show-ref', 'name-rev', 'merge-base', 'hash-object', 'var', 'check-ignore', 'check-attr', 'diff-tree', 'diff-index', 'diff-files', 'count-objects', 'fsck', 'verify-commit', 'verify-tag', 'whatchanged', 'archive', 'bundle', 'format-patch', 'range-diff', 'clone', 'init', 'gc', 'prune', 'repack', 'maintenance', 'pack-refs']);
  const seen = new Set();
  while (sub && !WRITE_SUBS.has(sub) && !READS.has(sub)) {
    if (seen.has(sub) || seen.size > 10) block(`alias loop at ${sub}`);
    seen.add(sub);
    const a = spawnSync(REAL, ['config', '--get', `alias.${sub}`], { cwd: fs.existsSync(eff) ? eff : process.cwd(), encoding: 'utf8', env });
    const val = a.status === 0 ? a.stdout.trim() : '';
    if (!val) break; // not an alias: a git-<name> extension or an error; nothing to check
    if (val.startsWith('!')) break; // shell alias: any nested `git` it runs re-enters this shim and is checked there
    if (/['"\\]/.test(val)) block(`alias ${sub} uses quoting g4a cannot resolve safely; run the underlying git command`);
    const toks = val.split(/\s+/).filter(Boolean);
    if (!toks.length || toks[0].startsWith('-')) block(`alias ${sub} starts with a global option; run the underlying git command`);
    sub = toks[0]; rest = [...toks.slice(1), ...rest];
  }
  const write = sub && isWrite(sub, rest);
  if (write && (gitDir || workTree || env.GIT_COMMON_DIR || env.GIT_OBJECT_DIRECTORY || env.GIT_ALTERNATE_OBJECT_DIRECTORIES)) block('--git-dir/--work-tree (or GIT_DIR/GIT_WORK_TREE/GIT_COMMON_DIR/GIT_OBJECT_DIRECTORY) is not allowed on agent writes in a g4a-managed repo; cd into .g4a/worktrees/<agent> instead');
  if (sub === 'commit' && env.GIT_INDEX_FILE) block('GIT_INDEX_FILE is not allowed on agent commits in a g4a-managed repo (the scope check reads the real index)');
  if (sub === 'config') {
    const pos = rest.filter((x) => !x.startsWith('-'));
    const writes = rest.some((x) => /^(--add|--replace-all|--unset|--unset-all|--rename-section|--remove-section|-e|--edit)$/.test(x)) || ['set', 'unset', 'rename-section', 'remove-section', 'edit'].includes(pos[0]) || pos.length >= 2;
    if (writes && (pos.some((k) => DANGEROUS_CONFIG.test(k)) || rest.some((x) => /^(-e|--edit)$/.test(x)) || pos[0] === 'edit')) block('setting core.hooksPath, core.logAllRefUpdates, alias.*, include.* (or editing config) is not allowed for agents in a g4a-managed repo');
  }
}
// OS agent users (g4a agent add): once a repo has agent users, an agent context running as any
// other uid (the operator, root) is refused on writes; agents start via `g4a run --agent NAME`.
if (sub && isWrite(sub, rest) && managed) {
  let am = null; try { am = JSON.parse(fs.readFileSync(process.env.G4A_AGENTS_MAP_TEST || '/etc/g4a/agents.json', 'utf8')); } catch {}
  const repo = am && repoCommonDir(fs.existsSync(eff) ? eff : process.cwd());
  const mine = repo ? Object.values(am.agents ?? {}).filter((a) => a.repo === repo || a.cloneId === repo) : [];
  if (mine.length && !mine.some((a) => a.uid === process.getuid()) && !mine.some((a) => am.policy?.[a.repo]?.allowOperator)) block(`this repo runs agents as their own OS users; start the agent with \`g4a run --agent <name> -- <command>\` instead of as uid ${process.getuid()} (or: g4a agent policy --allow-operator on)`);
}
if (sub && isWrite(sub, rest) && managed) {
  const enforce = !honored.G4A_ENFORCE;
  const { checkWithDaemon } = await import('./check-client.mjs');
  const r = await checkWithDaemon({ cwd: fs.existsSync(eff) ? eff : process.cwd(), argv, sub, rest }, { home: g4aHome(), timeoutMs: Number(process.env.G4A_CHECK_TIMEOUT_MS || 2000) });
  appendLog({ ...base, event: 'scope_check', warnings: r.warnings ?? [], unavailable: r.unavailable ?? null, enforce });
  if (r.unavailable) {
    if (enforce) { process.stderr.write(`[g4a] blocked: g4a daemon unavailable (${r.unavailable}); agent writes in a g4a-managed repo fail closed. Start it with \`g4a daemon --detach\`.\n`); process.exit(1); }
    process.stderr.write(`[g4a] warning: daemon unavailable (${r.unavailable}); scope not checked (operator override)\n`);
  }
  for (const w of r.warnings ?? []) process.stderr.write(`[g4a] ${enforce ? 'blocked' : 'warning'}: ${w}\n`);
  if ((r.warnings ?? []).length && enforce) { process.stderr.write('[g4a] blocked by scope enforcement\n'); process.exit(1); }
}
if (honored.G4A_RAW) {
  const r = spawnSync(REAL, argv, { stdio: 'inherit', env });
  appendLog({ ...base, mode: 'raw-override', exit: r.status, ms: Date.now() - t0 });
  if (r.signal) process.kill(process.pid, r.signal);
  process.exit(r.status ?? 1);
}

// a terminal gets git's own output (enforcement above still applied)
const kind = process.stdout.isTTY ? null : classify(argv);

if (!kind) {
  const child = spawn(REAL, argv, { stdio: 'inherit', env });
  const fwd = (s) => () => { try { child.kill(s); } catch {} };
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) process.on(s, fwd(s));
  child.on('exit', (code, sig) => {
    appendLog({ ...base, mode: 'passthrough', exit: code, signal: sig, ms: Date.now() - t0 });
    if (sig) { for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) process.removeAllListeners(s); process.kill(process.pid, sig); }
    else process.exit(code ?? 1);
  });
} else {
  const run = (args) => spawnSync(REAL, args, { env, encoding: 'buffer', maxBuffer: 1 << 30, stdio: ['inherit', 'pipe', 'pipe'] });
  const raw = run(argv);
  const rawOut = raw.stdout ?? Buffer.alloc(0), rawErr = raw.stderr ?? Buffer.alloc(0);
  const emitRaw = (mode) => {
    process.stdout.write(rawOut); process.stderr.write(rawErr);
    appendLog({ ...base, mode, exit: raw.status, ms: Date.now() - t0 });
    if (raw.signal) process.kill(process.pid, raw.signal);
    process.exitCode = raw.status ?? 1;
  };
  const isText = (b) => !b.includes(0);
  if (raw.status !== 0 || raw.signal || !isText(rawOut)) emitRaw('raw-fallback');
  else {
    let alt = null, ok = true;
    const aa = altArgs(kind, p);
    if (aa) { const r = run(aa); ok = r.status === 0; alt = { stdout: r.stdout.toString('utf8') }; }
    if (!ok) emitRaw('raw-fallback');
    else {
      const res = compactors[kind]({ raw: { stdout: rawOut.toString('utf8'), stderr: rawErr.toString('utf8') }, alt });
      const outC = res.stdout ?? rawOut.toString('utf8');
      const errC = res.stderr ?? rawErr.toString('utf8');
      const before = rawOut.length + rawErr.length;
      let after = Buffer.byteLength(outC) + Buffer.byteLength(errC);
      if (after >= before) emitRaw('raw-nogain');
      else {
        // tee: keep the full raw output so nothing is lost
        // tee: keep the full raw output (redacted, 0600, pruned by age/count) so nothing is lost.
        // G4A_TEE=0 disables it.
        let tee = '';
        if (process.env.G4A_TEE === '0') tee = '(tee disabled; rerun with G4A_RAW=1)';
        else try {
          const teeDir = ensurePrivateDir(path.join(ensurePrivateDir(g4aHome()), 'tee'));
          pruneTee(teeDir);
          tee = path.join(teeDir, `${Date.now()}-${process.pid}.txt`);
          writePrivate(tee, redact(Buffer.concat([rawOut, rawErr]).toString('utf8')));
        } catch { tee = '(tee failed)'; }
        const o = outC.replaceAll('{TEE}', tee), e = errC.replaceAll('{TEE}', tee);
        after = Buffer.byteLength(o) + Buffer.byteLength(e);
        process.stdout.write(o); process.stderr.write(e);
        appendLog({ ...base, mode: 'compact', kind, exit: 0, bytesBefore: before, bytesAfter: after, tokensBefore: estTokens(before), tokensAfter: estTokens(after), tee, ms: Date.now() - t0 });
        process.exitCode = 0;
      }
    }
  }
}
