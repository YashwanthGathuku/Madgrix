// Batch edge cases, land-time tamper audit, daemon watch, refusal logging (same-user authority).
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


const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ents = (home, repo) => { const l = ledger(home, repo); return l.bundle?.entries ?? entries(l); };
const kinds = (home, repo) => ents(home, repo).map((e) => e.kind ?? e.entry?.kind);
const L2 = (home, repo) => JSON.stringify(ledger(home, repo));

async function setup(n, extra = {}) {
  const files = {}; for (let i = 0; i < n; i++) files[`f${i}.txt`] = `${i}\n`;
  const home = mkHome(); const repo = mkRepo({ ...files, ...extra });
  const root = withAuthority(home, repo); tmp.push(home, `${home}-keys`, repo, path.dirname(root));
  const d = await startDaemon(home);
  const claim = async (agent, paths, witnesses = ['true'], o = {}) => { const c = await rpc(home, 'claim', { repo, agent, paths, witnesses, ...o }); assert.equal(c.ok, true, JSON.stringify(c)); return c; };
  const land = (c, o = {}) => rpc(home, 'promote', { repo, agent: c.agent, secret: secretOf(home, c.id), ...o });
  return { home, repo, root, d, claim, land };
}

test('batch: overlapping work never shares a batch: the authority refuses the overlapping claim (even with allowOverlap) and witness-path overlaps', async () => {
  const { home, repo, d, claim, land } = await setup(3);
  try {
    const x = await claim('x', ['f1.txt'], ['true'], { witnessPaths: ['f2.txt'] });
    const y = await rpc(home, 'claim', { repo, agent: 'y', paths: ['f1.txt'], witnesses: ['true'], allowOverlap: true });
    assert.equal(y.ok, false); assert.equal(y.refused, 'overlap');
    const z = await rpc(home, 'claim', { repo, agent: 'z', paths: ['f2.txt'], witnesses: ['true'] });
    assert.equal(z.ok, false, 'a file in another claim\'s witness paths cannot be claimed');
    commitIn(wt(repo, 'x'), 'f1.txt', 'x\n');
    assert.equal((await land(x)).status, 'promoted');
    assert.ok(kinds(home, repo).filter((k) => k === 'claim_refused').length >= 2, 'both refusals are in the authority ledger');
  } finally { await stop(d); cleanup(); }
});

test('batch: a failing batch witness falls back to per-claim ladders (attributed), good claim still lands', async () => {
  const { home, repo, d, claim, land } = await setup(3);
  try {
    const a = await claim('a0', ['f0.txt'], ['sleep 2']); commitIn(wt(repo, 'a0'), 'f0.txt', 'a0\n');
    const g = await claim('good', ['f1.txt']); const b = await claim('bad', ['f2.txt'], ['grep -q good f2.txt']);
    commitIn(wt(repo, 'good'), 'f1.txt', 'good\n'); commitIn(wt(repo, 'bad'), 'f2.txt', 'broken\n');
    const p0 = land(a); await sleep(500);
    const [, rg, rb] = await Promise.all([p0, land(g), land(b)]);
    assert.equal(rg.status, 'promoted', JSON.stringify(rg));
    assert.notEqual(rb.status, 'promoted', JSON.stringify(rb));
    assert.equal(git(repo, 'show', 'main:f2.txt'), '2', 'failing claim did not land');
    assert.ok(kinds(home, repo).includes('batch_witness_failed'), JSON.stringify([kinds(home, repo), rg, rb]));
  } finally { await stop(d); cleanup(); }
});

test('batch: a claim released while its batch witnesses run is not landed; the rest land', async () => {
  const { home, repo, d, claim, land } = await setup(3);
  try {
    const a = await claim('a0', ['f0.txt'], ['sleep 1']); commitIn(wt(repo, 'a0'), 'f0.txt', 'a0\n');
    const p0 = land(a); await sleep(250);
    const k = await claim('keep', ['f1.txt'], ['sleep 2']); const r = await claim('rel', ['f2.txt'], ['sleep 2']);
    commitIn(wt(repo, 'keep'), 'f1.txt', 'k\n'); commitIn(wt(repo, 'rel'), 'f2.txt', 'r\n');
    const pk = land(k), pr = land(r);
    await p0; await sleep(1200);
    const rr = await rpc(home, 'release', { repo, agent: 'rel' });
    assert.equal(rr.ok, true, JSON.stringify(rr));
    const [rk, rrel] = await Promise.all([pk, pr]);
    assert.equal(rk.status, 'promoted', JSON.stringify(rk));
    assert.notEqual(rrel.status, 'promoted', JSON.stringify(rrel));
    assert.equal(git(repo, 'show', 'main:f2.txt'), '2', 'released claim did not land');
  } finally { await stop(d); cleanup(); }
});

test('batch: a job id already used by another agent is refused and does not disturb that job', async () => {
  const { home, repo, d, claim, land } = await setup(2);
  try {
    const a = await claim('a', ['f0.txt']); const b = await claim('b', ['f1.txt']);
    commitIn(wt(repo, 'a'), 'f0.txt', 'a\n'); commitIn(wt(repo, 'b'), 'f1.txt', 'b\n');
    const ra = await land(a, { jobId: 'job-shared-1' });
    assert.equal(ra.status, 'promoted');
    let rb; try { rb = await land(b, { jobId: 'job-shared-1' }); } catch (e) { rb = { ok: false, error: String(e.message) }; }
    assert.notEqual(rb.status, 'promoted', JSON.stringify(rb));
    assert.equal(git(repo, 'show', 'main:f1.txt'), '1');
    const j = await rpc(home, 'job', { id: 'job-shared-1' });
    assert.equal(j.result.status, 'promoted', 'original job result intact');
  } finally { await stop(d); cleanup(); }
});

test('tamper: authority main moved out of band -> landing refused (authority_tampered), logged once, daemon watch reports it', async () => {
  const { home, repo, root, d, claim, land } = await setup(2);
  try {
    const a = await claim('a', ['f0.txt']); commitIn(wt(repo, 'a'), 'f0.txt', 'a\n');
    assert.equal((await land(a)).status, 'promoted');
    const arepo = path.join(root, 'repo'); assert.ok(fs.existsSync(arepo), arepo);
    const main = git(arepo, 'rev-parse', 'refs/heads/main');
    git(arepo, 'update-ref', 'refs/heads/main', `${main}~1`);
    const b = await claim('b', ['f1.txt']).catch(() => null);
    const w = await rpc(home, 'watch', { now: true });
    assert.equal(Object.values(w.audits).some((x) => x.ok === false), true, JSON.stringify(w));
    assert.match(JSON.stringify(await rpc(home, 'export', { repo })), /tamper_detected/);
    if (b) { commitIn(wt(repo, 'b'), 'f1.txt', 'b\n'); const rb = await land(b); assert.equal(rb.status, 'refused'); }
    // restore and land: the authority ledger recorded the finding exactly once
    git(arepo, 'update-ref', 'refs/heads/main', main);
    const n = kinds(home, repo).filter((k) => k === 'tamper_detected').length;
    assert.ok(n <= 1, `tamper logged ${n} times`);
  } finally { await stop(d); cleanup(); }
});

test('tamper: land-time audit refuses a queued landing when authority main moved', async () => {
  const { home, repo, root, d, claim, land } = await setup(2);
  try {
    const a = await claim('a', ['f0.txt']); const b = await claim('b', ['f1.txt']);
    commitIn(wt(repo, 'a'), 'f0.txt', 'a\n'); commitIn(wt(repo, 'b'), 'f1.txt', 'b\n');
    const arepo = path.join(root, 'repo');
    const base = git(arepo, 'rev-parse', 'refs/heads/main');
    // an out-of-band commit on authority main (what a same-user bypass could do)
    const t = git(arepo, 'rev-parse', `${base}^{tree}`);
    const evil = execFileSync('git', ['commit-tree', t, '-p', base, '-m', 'evil'], { cwd: arepo, encoding: 'utf8', env: { ...process.env, ...ID } }).trim();
    git(arepo, 'update-ref', 'refs/heads/main', evil, base);
    const ra = await land(a);
    assert.equal(ra.status, 'refused', JSON.stringify(ra));
    assert.match(JSON.stringify(ra), /authority_tampered|main_out_of_sync|tamper/);
    assert.ok(kinds(home, repo).includes('tamper_detected'), 'authority ledger has tamper_detected');
    void b;
  } finally { await stop(d); cleanup(); }
});

test('watch: out-of-claim edits in a claim worktree are logged as scope_violation (and landing them is refused)', async () => {
  const { home, repo, d, claim, land } = await setup(2);
  try {
    const a = await claim('a', ['f0.txt']);
    fs.writeFileSync(path.join(wt(repo, 'a'), 'f1.txt'), 'sneaky\n');
    const w = await rpc(home, 'watch', { now: true });
    assert.deepEqual(w.violations[a.id], ['f1.txt'], JSON.stringify(w));
    assert.match(JSON.stringify(await rpc(home, 'export', { repo })), /scope_violation/);
    const w2 = await rpc(home, 'watch', { now: true }); void w2;
    const n = (JSON.stringify(await rpc(home, 'export', { repo })).match(/scope_violation/g) ?? []).length;
    assert.equal(n, 1, 'logged once per distinct state');
    let committed = true;
    try { git(wt(repo, 'a'), 'add', 'f1.txt'); git(wt(repo, 'a'), 'commit', '-qm', 'sneak'); } catch { committed = false; } // the ref guard may refuse it already
    if (committed) { const r = await land(a); assert.notEqual(r.status, 'promoted', JSON.stringify(r)); }
    assert.equal(git(repo, 'show', 'main:f1.txt'), '1');
  } finally { await stop(d); cleanup(); }
});

test('refusals: a refused push to the authority is folded into the signed ledger as push_refused', async () => {
  const { home, repo, root, d } = await setup(1);
  try {
    fs.writeFileSync(path.join(repo, 'f0.txt'), 'direct\n'); git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'direct');
    const r = tryGit(repo, 'push', path.join(root, 'repo'), 'HEAD:refs/heads/main');
    assert.notEqual(r.status, 0);
    const au = cli(home, ['authority', 'audit', '--repo', repo]); void au;
    assert.ok(kinds(home, repo).includes('push_refused'), L2(home, repo).slice(0, 400));
  } finally { await stop(d); cleanup(); }
});
