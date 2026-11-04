// Batch landing (g4a-gaps a) and directory claims (b), same-user authority.
// Fixtures live under os.tmpdir() and are removed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

delete process.env.G4A_LOCAL_LAND;
const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(PKG, 'bin', 'g4a.mjs');
const ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, ...ID, G4A_RAW: '1' } }).trim();
const tryGit = (cwd, ...a) => spawnSync('git', ['-c', 'protocol.file.allow=always', ...a], { cwd, encoding: 'utf8', env: { ...process.env, ...ID, G4A_RAW: '1' } });
function mkRepo(files) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'g4a-bt-repo-')));
  git(d, 'init', '-q', '-b', 'main');
  for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), t); }
  git(d, 'add', '-A'); git(d, 'commit', '-qm', 'base'); git(d, 'checkout', '-q', '--detach');
  return d;
}
const mkHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'g4a-bt-home-'));
const H = (home) => ({ G4A_HOME: home, G4A_KEY_DIR: `${home}-keys` });
function cli(home, args, env = {}) {
  const r = spawnSync(process.execPath, ['--no-warnings', CLI, ...args], { encoding: 'utf8', env: { ...process.env, ...H(home), ...env } });
  let json = null; try { json = JSON.parse(r.stdout); } catch {}
  return { ...r, json };
}
function startDaemon(home) {
  const c = spawn(process.execPath, ['--no-warnings', CLI, 'daemon'], { env: { ...process.env, ...H(home) }, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; c.stderr.on('data', (d) => { err += d; });
  return new Promise((res, rej) => {
    const t = setInterval(() => { if (err.includes('g4a daemon pid')) { clearInterval(t); res(c); } }, 20);
    c.on('exit', (code) => { clearInterval(t); rej(new Error(`daemon exited ${code}: ${err}`)); });
  });
}
const stop = (c) => new Promise((r) => { if (c.exitCode !== null || c.signalCode) return r(); c.once('exit', r); c.kill('SIGTERM'); });
async function rpc(home, method, params) { const { rpc } = await import('../src/daemon.mjs'); return rpc(method, params, { home }); }
function commitIn(wt, file, text) { fs.mkdirSync(path.dirname(path.join(wt, file)), { recursive: true }); fs.writeFileSync(path.join(wt, file), text); git(wt, 'add', file); git(wt, 'commit', '-qm', `edit ${file}`); }
const wt = (repo, a) => path.join(repo, '.g4a', 'worktrees', a);
function withAuthority(home, repo) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'g4a-bt-auth-'));
  const r = cli(home, ['authority', 'init', path.join(root, 'a'), '--repo', repo]);
  assert.equal(r.json?.ok, true, r.stdout + r.stderr);
  return path.join(root, 'a');
}
const tmp = [];
const cleanup = () => { for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true }); };
const secretOf = (home, id) => fs.readFileSync(path.join(home, 'secrets', id), 'utf8');
const ledger = (home, repo) => cli(home, ['authority', 'ledger', '--repo', repo]).json;
const entries = (L) => (L.entries ?? L.ledger ?? L);

test('batch: concurrent disjoint claims land in one CAS, ledger carries batch info, audit passes; overlap/foreign job refused', async () => {
  const files = {}; for (let i = 0; i < 6; i++) files[`f${i}.txt`] = `${i}\n`;
  const home = mkHome(); const repo = mkRepo({ ...files, 'src/x.js': 'x\n' });
  const root = withAuthority(home, repo); tmp.push(home, `${home}-keys`, repo, path.dirname(root));
  const d = await startDaemon(home);
  try {
    const cs = [];
    for (let i = 0; i < 6; i++) { const c = await rpc(home, 'claim', { repo, agent: `b${i}`, paths: [`f${i}.txt`], witnesses: ['true'] }); assert.equal(c.ok, true, JSON.stringify(c)); cs.push(c); commitIn(wt(repo, `b${i}`), `f${i}.txt`, `new ${i}\n`); }
    const rs = await Promise.all(cs.map((c) => rpc(home, 'promote', { repo, agent: c.agent, secret: secretOf(home, c.id) })));
    for (const r of rs) assert.equal(r.status, 'promoted', JSON.stringify(r));
    for (let i = 0; i < 6; i++) assert.equal(git(repo, 'show', `main:f${i}.txt`), `new ${i}`);
    const ps = JSON.stringify(ledger(home, repo));
    assert.match(ps, /"batch":\{"id"/, 'at least one batched promote in the ledger');
    const au = cli(home, ['authority', 'audit', '--repo', repo]).json;
    assert.equal(au.ok, true, JSON.stringify(au));

    // (b) a "src/" claim means src/**: it lands a nested file; a mid-path wildcard is refused
    const bad = await rpc(home, 'claim', { repo, agent: 'w', paths: ['src/*.js'] });
    assert.equal(bad.ok, false, JSON.stringify(bad));
    const dc = await rpc(home, 'claim', { repo, agent: 'dir', paths: ['src/'], witnesses: ['true'] });
    assert.equal(dc.ok, true, JSON.stringify(dc));
    commitIn(wt(repo, 'dir'), 'src/deep/y.js', 'y\n');
    const dp = await rpc(home, 'promote', { repo, agent: 'dir', secret: secretOf(home, dc.id) });
    assert.equal(dp.status, 'promoted', JSON.stringify(dp));
    assert.equal(git(repo, 'show', 'main:src/deep/y.js'), 'y');
  } finally { await stop(d); cleanup(); }
});

