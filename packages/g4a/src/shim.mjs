#!/usr/bin/env node
// Invoked by the sh shim when an agent marker is set and stdout is not a TTY, or for any
// caller inside a .g4a/worktrees/ checkout.
// Everything not classified as a safe read command is spawned with inherited stdio.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { classify, parseArgs, altArgs, compactors, appendLog, estTokens, g4aHome, agentMarker } from './lib.mjs';

const REAL = process.env.G4A_REAL_GIT;
const argv = process.argv.slice(2);
const env = { ...process.env, G4A_ACTIVE: '1' }; // recursion guard for nested git calls
const t0 = Date.now();
const p = parseArgs(argv);
const base = { event: 'git', ts: new Date().toISOString(), cwd: process.cwd(), argv, sub: p?.sub ?? null, agent: agentMarker() };

if (!REAL || !fs.existsSync(REAL)) { process.stderr.write('g4a: real git not configured (G4A_REAL_GIT); run g4a doctor\n'); process.exit(127); }

// Phase 1 hardening: agent write commands in a g4a-managed repo are checked by the daemon
// and BLOCKED by default when out of scope (opt out: G4A_ENFORCE=0). Daemon down => agents
// fail closed. Humans (no agent marker, or G4A_AGENT=0) are never checked.
// Not covered (honest limits): calling the real git by absolute path, or editing files
// directly without git; Phase 2's authority repo is what closes those.
const marker = agentMarker();
const isAgent = !!marker && process.env.G4A_AGENT !== '0';
const WRITE_SUBS = new Set(['commit', 'push', 'merge', 'rebase', 'reset', 'checkout', 'switch', 'cherry-pick', 'am', 'apply', 'revert', 'pull', 'update-ref', 'branch']);
function managedRepo(dir) {
  if (`${dir}/`.includes('/.g4a/worktrees/')) return true;
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.g4a', 'worktrees'))) return true;
    if (fs.existsSync(path.join(d, '.git')) || d === path.dirname(d)) return false;
  }
}
if (!isAgent) {
  // reached only via the worktree route of the sh shim: plain passthrough, no checks
  const r = spawnSync(REAL, argv, { stdio: 'inherit', env });
  if (r.signal) process.kill(process.pid, r.signal);
  process.exit(r.status ?? 1);
}
if (p?.sub && WRITE_SUBS.has(p.sub) && managedRepo(process.cwd())) {
  const enforce = process.env.G4A_ENFORCE !== '0';
  const { checkWithDaemon } = await import('./check-client.mjs');
  const r = await checkWithDaemon({ cwd: process.cwd(), argv }, { home: g4aHome(), timeoutMs: Number(process.env.G4A_CHECK_TIMEOUT_MS || 2000) });
  appendLog({ ...base, event: 'scope_check', warnings: r.warnings ?? [], unavailable: r.unavailable ?? null, enforce });
  if (r.unavailable) {
    if (enforce) { process.stderr.write(`[g4a] blocked: g4a daemon unavailable (${r.unavailable}); agent writes in a g4a-managed repo fail closed. Start it with \`g4a daemon --detach\`, or set G4A_ENFORCE=0 to opt out.\n`); process.exit(1); }
    process.stderr.write(`[g4a] warning: daemon unavailable (${r.unavailable}); scope not checked (G4A_ENFORCE=0)\n`);
  }
  for (const w of r.warnings ?? []) process.stderr.write(`[g4a] ${enforce ? 'blocked' : 'warning'}: ${w}\n`);
  if ((r.warnings ?? []).length && enforce) { process.stderr.write('[g4a] blocked by scope enforcement (set G4A_ENFORCE=0 to opt out)\n'); process.exit(1); }
}

const kind = classify(argv);

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
