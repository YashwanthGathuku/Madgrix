#!/usr/bin/env node
// Invoked by the sh shim when an agent marker is set and stdout is not a TTY, or for any
// caller inside a .g4a/worktrees/ checkout.
// Everything not classified as a safe read command is spawned with inherited stdio.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { classify, parseArgs, altArgs, compactors, appendLog, estTokens, g4aHome, agentMarker, keyDir } from './lib.mjs';
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
const WRITE_SUBS = new Set(['commit', 'push', 'merge', 'rebase', 'reset', 'checkout', 'switch', 'cherry-pick', 'am', 'apply', 'revert', 'pull', 'update-ref', 'branch']);
function managedRepo(dir) {
  if (`${dir}/`.includes('/.g4a/worktrees/')) return true;
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
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
if (p?.sub && WRITE_SUBS.has(p.sub) && managedRepo(process.cwd())) {
  const enforce = !honored.G4A_ENFORCE;
  const { checkWithDaemon } = await import('./check-client.mjs');
  const r = await checkWithDaemon({ cwd: process.cwd(), argv }, { home: g4aHome(), timeoutMs: Number(process.env.G4A_CHECK_TIMEOUT_MS || 2000) });
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
        const teeDir = path.join(g4aHome(), 'tee');
        let tee = '';
        try { fs.mkdirSync(teeDir, { recursive: true }); tee = path.join(teeDir, `${Date.now()}-${process.pid}.txt`); fs.writeFileSync(tee, Buffer.concat([rawOut, rawErr])); } catch { tee = '(tee failed)'; }
        const o = outC.replaceAll('{TEE}', tee), e = errC.replaceAll('{TEE}', tee);
        after = Buffer.byteLength(o) + Buffer.byteLength(e);
        process.stdout.write(o); process.stderr.write(e);
        appendLog({ ...base, mode: 'compact', kind, exit: 0, bytesBefore: before, bytesAfter: after, tokensBefore: estTokens(before), tokensAfter: estTokens(after), tee, ms: Date.now() - t0 });
        process.exitCode = 0;
      }
    }
  }
}
