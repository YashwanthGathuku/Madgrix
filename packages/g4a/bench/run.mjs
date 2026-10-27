#!/usr/bin/env node
// Benchmark: run an agent-like git workload against real repos, through real git and
// through the g4a shim (G4A_AGENT=1, stdout piped), and report measured bytes/tokens.
// usage: node bench/run.mjs <repo> [<repo>...]   (env G4A_TIKTOKEN=/path/to/node_modules/js-tiktoken optional)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'g4a-bench-'));
const HOME = path.join(tmp, 'g4a');
const REAL = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
const env0 = { ...process.env, G4A_HOME: HOME, GIT_AUTHOR_NAME: 'bench', GIT_AUTHOR_EMAIL: 'b@b', GIT_COMMITTER_NAME: 'bench', GIT_COMMITTER_EMAIL: 'b@b' };
for (const k of Object.keys(env0)) if (k.startsWith('CODEX_') || k === 'CLAUDECODE' || k === 'G4A_AGENT') delete env0[k];
execFileSync(process.execPath, [path.join(PKG, 'bin', 'g4a.mjs'), 'install'], { env: env0, stdio: 'ignore' });
const SHIM = path.join(HOME, 'bin', 'git');

let enc = null;
if (process.env.G4A_TIKTOKEN) { const req = createRequire(path.join(process.env.G4A_TIKTOKEN, 'x.js')); const { getEncoding } = req('js-tiktoken'); enc = getEncoding('o200k_base'); }
const tok = (s) => (enc ? enc.encode(s).length : Math.ceil(Buffer.byteLength(s) / 4));

const WORKLOAD = [
  ['status'], ['log'], ['log', '-n', '20'], ['diff', '--stat'], ['show', '--stat', 'HEAD'], ['branch', '-a'],
  ['status'], ['diff'], ['status', '--porcelain'], ['log', '--oneline', '-n', '20'], ['rev-parse', 'HEAD'],
  ['__commit'], ['push', 'bench', 'HEAD:refs/heads/g4a-bench'], ['fetch', 'bench'], ['status'],
];

const rows = [];
for (const src of process.argv.slice(2)) {
  const name = path.basename(path.resolve(src));
  const work = path.join(tmp, name);
  execFileSync(REAL, ['clone', '-q', '--no-hardlinks', path.resolve(src), work]);
  execFileSync(REAL, ['init', '-q', '--bare', path.join(tmp, name + '-remote.git')]);
  execFileSync(REAL, ['-C', work, 'remote', 'add', 'bench', path.join(tmp, name + '-remote.git')]);
  // make the tree dirty like an agent mid-task: edit 3 tracked files, add 2 untracked
  const files = execFileSync(REAL, ['-C', work, 'ls-files'], { encoding: 'utf8' }).split('\n').filter((f) => /\.(ts|js|md|mjs)$/.test(f)).slice(0, 3);
  for (const f of files) fs.appendFileSync(path.join(work, f), '\n// g4a bench edit\n'.repeat(5));
  fs.writeFileSync(path.join(work, 'NOTES.tmp'), 'x\n'); fs.writeFileSync(path.join(work, 'scratch.tmp'), 'y\n');
  for (const [i, args] of WORKLOAD.entries()) {
    if (args[0] === '__commit') { execFileSync(REAL, ['-C', work, 'commit', '-qam', `bench commit ${i}`], { env: env0 }); continue; }
    // push/fetch mutate state: measure raw on one ref name, shim on another
    const a2 = args[0] === 'push' ? ['push', 'bench', 'HEAD:refs/heads/g4a-bench-shim'] : args;
    const t1 = process.hrtime.bigint();
    const r = spawnSync(REAL, args, { cwd: work, env: env0 });
    const t2 = process.hrtime.bigint();
    const s = spawnSync(SHIM, a2, { cwd: work, env: { ...env0, G4A_AGENT: '1' } });
    const t3 = process.hrtime.bigint();
    const rawS = r.stdout.toString() + r.stderr.toString(), shS = s.stdout.toString() + s.stderr.toString();
    rows.push({ repo: name, cmd: args.join(' '), exitSame: r.status === s.status, rawBytes: Buffer.byteLength(rawS), shimBytes: Buffer.byteLength(shS), rawTok: tok(rawS), shimTok: tok(shS), rawMs: Number(t2 - t1) / 1e6, shimMs: Number(t3 - t2) / 1e6 });
  }
}

const pct = (a, b) => (a ? ((1 - b / a) * 100).toFixed(1) + '%' : '-');
console.log(`token counter: ${enc ? 'js-tiktoken o200k_base' : 'heuristic ceil(bytes/4)'}\n`);
console.log('| repo | command | exit same | raw bytes | g4a bytes | raw tok | g4a tok | saved | raw ms | g4a ms |');
console.log('|---|---|---|---:|---:|---:|---:|---:|---:|---:|');
for (const r of rows) console.log(`| ${r.repo} | \`git ${r.cmd}\` | ${r.exitSame ? 'yes' : 'NO'} | ${r.rawBytes} | ${r.shimBytes} | ${r.rawTok} | ${r.shimTok} | ${pct(r.rawTok, r.shimTok)} | ${r.rawMs.toFixed(1)} | ${r.shimMs.toFixed(1)} |`);
const sum = (k, f = () => true) => rows.filter(f).reduce((a, r) => a + r[k], 0);
console.log(`\nwhole workload: ${sum('rawTok')} -> ${sum('shimTok')} tokens (${pct(sum('rawTok'), sum('shimTok'))}), ${sum('rawBytes')} -> ${sum('shimBytes')} bytes (${pct(sum('rawBytes'), sum('shimBytes'))})`);
const nl = (r) => r.cmd !== 'log';
console.log(`excluding unbounded \`git log\` (capped to 50 commits): ${sum('rawTok', nl)} -> ${sum('shimTok', nl)} tokens (${pct(sum('rawTok', nl), sum('shimTok', nl))})`);
console.log('note: push rows use a different ref name for the g4a run (g4a-bench-shim), so their byte delta is the ref name, not g4a.');
const bad = rows.filter((r) => !r.exitSame).length;
console.log(`exit-code mismatches: ${bad}`);
console.log(`total wall time: real ${sum('rawMs').toFixed(0)} ms, g4a ${sum('shimMs').toFixed(0)} ms`);
fs.rmSync(tmp, { recursive: true, force: true });
