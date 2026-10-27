#!/usr/bin/env node
// ForgeMark-shaped push race, local only: N agents, each loops for D seconds making a
// checkpoint-sized commit (1-3 files x 1 KB) on its own branch/claim and landing it.
//   node bench/race.mjs plain <remote-url|path> [N] [secs]   -> git commit + git push <own branch>
//   node bench/race.mjs g4a [N] [secs] [--system]            -> g4a claim + commit + promote + release (authority)
// Prints JSON: ops, ops/s, p50/p95/p99/max ms, errors. Latency = one full op, client side.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(PKG, 'bin', 'g4a.mjs');
const [mode, ...rest] = process.argv.slice(2);
const system = rest.includes('--system');
const pos = rest.filter((a) => !a.startsWith('--'));
const remote = mode === 'plain' ? pos.shift() : null;
const N = Number(pos[0] || 16), SECS = Number(pos[1] || 60);
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'g4a-race-'));
fs.chmodSync(W, 0o755);
const env = { ...process.env, G4A_HOME: path.join(W, 'home'), G4A_KEY_DIR: path.join(W, 'keys'), GIT_AUTHOR_NAME: 'race', GIT_AUTHOR_EMAIL: 'race@local', GIT_COMMITTER_NAME: 'race', GIT_COMMITTER_EMAIL: 'race@local', G4A_RAW: '1' };
for (const k of Object.keys(env)) if (k.startsWith('CODEX_') || k === 'CLAUDECODE' || k === 'G4A_AGENT' || k === 'G4A_LOCAL_LAND') delete env[k];
const run = (cmd, args, opts = {}) => new Promise((res) => execFile(cmd, args, { env, maxBuffer: 1 << 24, ...opts }, (err, stdout, stderr) => res({ code: err ? (err.code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) })));
const g4a = (args) => run(process.execPath, ['--no-warnings', CLI, ...args]);
const json = (s) => { try { return JSON.parse(s); } catch { return {}; } };
const files = (dir, tag) => { const n = 1 + crypto.randomInt(3); for (let i = 0; i < n; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), crypto.randomBytes(512).toString('hex')); return n; };

const repo = path.join(W, 'repo');
fs.mkdirSync(repo);
execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, env });
fs.writeFileSync(path.join(repo, 'README'), 'race\n');
execFileSync('git', ['add', '-A'], { cwd: repo, env });
execFileSync('git', ['commit', '-qm', 'base'], { cwd: repo, env });
if (mode === 'plain') {
  execFileSync('git', ['push', '-q', remote, 'main'], { cwd: repo, env });
} else {
  execFileSync('git', ['checkout', '-q', '--detach'], { cwd: repo, env });
  execFileSync(process.execPath, ['--no-warnings', CLI, 'daemon', '--detach'], { env, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 1000));
  const r = json((await g4a(system ? ['authority', 'init', '--system', '--repo', repo] : ['authority', 'init', path.join(W, 'auth'), '--repo', repo])).stdout);
  if (!r.ok && r.ok !== undefined) throw new Error('authority init failed');
}

const lat = []; let errors = 0, syncRetries = 0; const errSamples = [];
const deadline = Date.now() + SECS * 1000;
async function agent(i) {
  const id = `a${i}`; let seq = 0;
  let wt;
  if (mode === 'plain') { wt = path.join(W, id); execFileSync('git', ['clone', '-q', remote, wt], { env }); execFileSync('git', ['checkout', '-q', '-b', `agent/${id}`], { cwd: wt, env }); }
  while (Date.now() < deadline) {
    const t0 = process.hrtime.bigint(); let ok = false, why = '';
    seq++;
    if (mode === 'plain') {
      const d = path.join(wt, id); fs.mkdirSync(d, { recursive: true }); files(d);
      const c = await run('git', ['-C', wt, 'add', '-A']).then(() => run('git', ['-C', wt, 'commit', '-qm', `${id} ${seq}`]));
      const p = c.code ? c : await run('git', ['-C', wt, 'push', '-q', 'origin', `agent/${id}`]);
      ok = p.code === 0; why = p.stderr;
    } else {
      const ag = `${id}-${seq}`, dir = `agents/${id}`;
      const cl = json((await g4a(['claim', '--repo', repo, '--agent', ag, '--paths', `${dir}/**`, '--witness', 'true'])).stdout);
      if (cl.ok) {
        const w = path.join(repo, '.g4a', 'worktrees', ag); const d = path.join(w, dir); fs.mkdirSync(d, { recursive: true }); files(d);
        const c = await run('git', ['-C', w, 'add', '-A']).then(() => run('git', ['-C', w, 'commit', '-qm', `${ag}`]));
        const p = c.code ? { stdout: '{}' , stderr: c.stderr } : await g4a(['promote', '--repo', repo, '--agent', ag]);
        const pr = json(p.stdout); ok = pr.status === 'promoted'; why = ok ? '' : (p.stdout + p.stderr).slice(0, 300);
        await g4a(['release', '--repo', repo, '--agent', ag, '--remove-worktree']);
      } else if (cl.refused === 'main_out_of_sync') { syncRetries++; continue; } else why = JSON.stringify(cl).slice(0, 300);
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (ok) lat.push(ms); else { errors++; if (errSamples.length < 3) errSamples.push(why); }
  }
}
const t0 = Date.now();
await Promise.all(Array.from({ length: N }, (_, i) => agent(i)));
const wall = (Date.now() - t0) / 1000;
lat.sort((a, b) => a - b);
const q = (p) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(p * lat.length))].toFixed(0) : null);
let verify = null;
if (mode === 'g4a') verify = json((await g4a(['verify', '--repo', repo])).stdout).ok ?? null;
console.log(JSON.stringify({ mode: mode + (system ? ':system' : ''), remote, agents: N, secs: SECS, wall: +wall.toFixed(1), ops: lat.length, opsPerSec: +(lat.length / wall).toFixed(2), p50: q(0.5), p95: q(0.95), p99: q(0.99), max: lat.length ? lat[lat.length - 1].toFixed(0) : null, errors, syncRetries, errSamples, verify }));
await g4a(['stop']);
if (system) await g4a(['authority', 'uninstall', '--system', '--repo', repo]);
fs.rmSync(W, { recursive: true, force: true });
