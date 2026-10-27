// Phase 1 remaining limits (Part A): witness-path pinning, anchor remote + passphrase key,
// checked-out main, per-repo job queues. No network, no Cloudflare.
// phase-1 fixtures exercise the test-only local landing path (production promotes via the authority)
process.env.G4A_LOCAL_LAND = '1';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(PKG, 'bin', 'g4a.mjs');
const ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, ...ID, G4A_RAW: '1' } }).trim();
function mkRepo(files, { detach = true } = {}) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'g4a-lim-repo-')));
  git(d, 'init', '-q', '-b', 'main');
  for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), t); }
  git(d, 'add', '-A'); git(d, 'commit', '-qm', 'base');
  if (detach) git(d, 'checkout', '-q', '--detach');
  return d;
}
const keysOf = (home) => `${home}-keys`;
const H = (home) => ({ G4A_HOME: home, G4A_KEY_DIR: keysOf(home) });
const mkHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'g4a-lim-home-'));
function cli(home, args, env = {}) {
  const r = spawnSync(process.execPath, ['--no-warnings', CLI, ...args], { encoding: 'utf8', env: { ...process.env, ...H(home), ...env } });
  let json = null; try { json = JSON.parse(r.stdout); } catch {}
  return { ...r, json };
}
function startDaemon(home, env = {}) {
  const c = spawn(process.execPath, ['--no-warnings', CLI, 'daemon'], { env: { ...process.env, ...H(home), ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; c.stderr.on('data', (d) => { err += d; });
  return new Promise((res, rej) => {
    const t = setInterval(() => { if (err.includes('g4a daemon pid')) { clearInterval(t); res(c); } }, 20);
    c.on('exit', (code) => { clearInterval(t); rej(new Error(`daemon exited ${code}: ${err}`)); });
  });
}
const stop = (c) => new Promise((r) => { if (c.exitCode !== null || c.signalCode) return r(); c.once('exit', r); c.kill('SIGTERM'); });
async function rpc(home, method, params) { const { rpc } = await import('../src/daemon.mjs'); return rpc(method, params, { home }); }
function commitIn(wt, file, text, msg) { fs.mkdirSync(path.dirname(path.join(wt, file)), { recursive: true }); fs.writeFileSync(path.join(wt, file), text); git(wt, 'add', file); git(wt, 'commit', '-qm', msg); }
const secretOf = (home, id) => fs.readFileSync(path.join(home, 'secrets', id), 'utf8');
const promote = (home, repo, c) => rpc(home, 'promote', { repo, agent: c.agent, secret: secretOf(home, c.id) });

const TEST = 'import { f } from "../src/a.js";\nprocess.exit(f() === 1 ? 0 : 1);\n';
const BASE = { 'package.json': '{"type":"module"}\n', 'src/a.js': 'export const f = () => 1;\n', 'src/b.js': 'export const g = 2;\n', 'test/a.test.mjs': TEST };

test('A1 witness paths: claims over another agent\'s witness files are refused (active and frozen)', async () => {
  const home = mkHome(); const repo = mkRepo(BASE);
  const d = await startDaemon(home);
  try {
    const a = await rpc(home, 'claim', { repo, agent: 'alice', paths: ['src/a.js'], witnesses: ['node test/a.test.mjs'] });
    assert.deepEqual(a.witness_paths, ['test/a.test.mjs']); // derived from the executed script
    const b = await rpc(home, 'claim', { repo, agent: 'bob', paths: ['test/**'], witnesses: ['true'] });
    assert.equal(b.ok, false); assert.equal(b.refused, 'witness_paths'); assert.equal(b.guarded[0].with, 'alice');
    // the reverse: a witness path inside another agent's active claim is refused too
    const cl = await rpc(home, 'claim', { repo, agent: 'carol', paths: ['docs/x.md'], witnesses: ['node src/a.js'] });
    assert.equal(cl.ok, false); assert.equal(cl.refused, 'witness_paths');
    commitIn(a.worktree, 'src/a.js', 'export const f = () => 1; // tidy\n', 'a');
    assert.equal((await promote(home, repo, a)).status, 'promoted');
    await rpc(home, 'release', { repo, agent: 'alice' });
    // frozen: after alice's promotion and release, test/a.test.mjs stays pinned for everyone else
    const b2 = await rpc(home, 'claim', { repo, agent: 'bob', paths: ['test/a.test.mjs'], witnesses: ['true'] });
    assert.equal(b2.ok, false); assert.ok(b2.guarded.some((g) => g.frozen && g.with === 'alice'));
    // explicit --witness-path globs are protected the same way
    const dv = await rpc(home, 'claim', { repo, agent: 'dave', paths: ['src/b.js'], witnesses: ['true'], witnessPaths: ['test/**'] });
    assert.ok(dv.ok); assert.deepEqual(dv.witness_paths, ['test/**']);
    const er = await rpc(home, 'claim', { repo, agent: 'erin', paths: ['test/new.mjs'], witnesses: ['true'] });
    assert.equal(er.ok, false);
  } finally { await stop(d); }
});

test('A1 witness pins: an agent weakening its OWN frozen witness gets REVIEW; external drift gets REVIEW', async () => {
  const home = mkHome(); const repo = mkRepo(BASE);
  const d = await startDaemon(home);
  try {
    const a = await rpc(home, 'claim', { repo, agent: 'alice', paths: ['src/a.js', 'test/a.test.mjs'], witnesses: ['node test/a.test.mjs'] });
    commitIn(a.worktree, 'src/a.js', 'export const f = () => 1; // v1\n', 'v1');
    assert.equal((await promote(home, repo, a)).status, 'promoted'); // own unfrozen witness: fine
    await rpc(home, 'release', { repo, agent: 'alice', removeWorktree: true }); git(repo, 'branch', '-D', 'g4a/alice');
    const a2 = await rpc(home, 'claim', { repo, agent: 'alice', paths: ['src/a.js', 'test/a.test.mjs'], witnesses: ['node test/a.test.mjs'] });
    assert.ok(a2.ok, JSON.stringify(a2));
    commitIn(a2.worktree, 'src/a.js', 'export const f = () => 2;\n', 'break f');
    commitIn(a2.worktree, 'test/a.test.mjs', 'process.exit(0);\n', 'weaken the witness');
    const before = git(repo, 'rev-parse', 'main');
    const r = await promote(home, repo, a2);
    assert.equal(r.verdict, 'REVIEW', JSON.stringify(r)); assert.equal(r.reason, 'witness_modified'); assert.deepEqual(r.paths, ['test/a.test.mjs']);
    assert.equal(git(repo, 'rev-parse', 'main'), before);
    await rpc(home, 'release', { repo, agent: 'alice' });
    // main moved outside the daemon and changed the pinned witness => the next promotion is REVIEW
    const t = git(repo, 'commit-tree', '-p', before, '-m', 'x', (() => { const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'g4a-x-')); git(repo, 'worktree', 'add', '-q', '--detach', wt, before); fs.writeFileSync(path.join(wt, 'test/a.test.mjs'), 'process.exit(0);\n'); git(wt, 'add', '-A'); const tr = git(wt, 'write-tree'); git(repo, 'worktree', 'remove', '--force', wt); return tr; })());
    git(repo, 'update-ref', 'refs/heads/main', t);
    const b = await rpc(home, 'claim', { repo, agent: 'bob', paths: ['src/b.js'], witnesses: ['true'] });
    commitIn(b.worktree, 'src/b.js', 'export const g = 3;\n', 'b');
    const rb = await promote(home, repo, b);
    assert.equal(rb.verdict, 'REVIEW', JSON.stringify(rb)); assert.equal(rb.reason, 'witness_tamper');
  } finally { await stop(d); }
});

test('A3 external anchor remote: a full local rollback (db + ref + key-dir anchor) is caught by the remote', async () => {
  const home = mkHome(); const repo = mkRepo({ 'f.txt': '1\n' });
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'g4a-anchor-remote-'));
  git(remote, 'init', '-q', '--bare'); git(remote, 'config', 'receive.denyNonFastForwards', 'true'); git(remote, 'config', 'receive.denyDeletes', 'true');
  const env = { G4A_ANCHOR_REMOTE: remote };
  let d = await startDaemon(home, env);
  await rpc(home, 'claim', { repo, agent: 'a', paths: ['f.txt'], witnesses: ['true'] });
  await stop(d);
  // attacker snapshot (same uid): db files, key-dir anchor file, local anchor ref
  const snap = fs.mkdtempSync(path.join(os.tmpdir(), 'g4a-snap-'));
  for (const f of fs.readdirSync(home)) if (f.startsWith('g4a.db')) fs.copyFileSync(path.join(home, f), path.join(snap, f));
  const af = path.join(keysOf(home), 'anchors'); const afName = fs.readdirSync(af)[0];
  fs.copyFileSync(path.join(af, afName), path.join(snap, afName));
  const ref = git(repo, 'rev-parse', 'refs/g4a/ledger-head');
  d = await startDaemon(home, env);
  await rpc(home, 'release', { repo, agent: 'a' });
  await rpc(home, 'claim', { repo, agent: 'b', paths: ['f.txt'], witnesses: ['true'] });
  await stop(d);
  for (const f of fs.readdirSync(home)) if (f.startsWith('g4a.db')) fs.rmSync(path.join(home, f));
  for (const f of fs.readdirSync(snap)) if (f.startsWith('g4a.db')) fs.copyFileSync(path.join(snap, f), path.join(home, f));
  fs.copyFileSync(path.join(snap, afName), path.join(af, afName));
  git(repo, 'update-ref', 'refs/g4a/ledger-head', ref);
  // locally consistent again: verify without the remote cannot tell
  assert.equal(cli(home, ['verify', '--repo', repo]).json.ok, true);
  const v = cli(home, ['verify', '--repo', repo, '--anchor-remote', remote]);
  assert.equal(v.json.ok, false); assert.match(v.json.errors.join('\n'), /truncated or rolled back/);
  await assert.rejects(startDaemon(home, env), /rollback detected/);
  // the remote refuses the rolled-back chain (non-fast-forward)
  assert.notEqual(spawnSync('git', ['push', '-q', remote, `${ref}:refs/g4a/ledger-head`], { cwd: repo, env: { ...process.env, G4A_RAW: '1' } }).status, 0);
});

test('A3 passphrase-protected witness key: encrypted at rest, daemon refuses to start without the passphrase', async () => {
  const home = mkHome(); const pf = path.join(os.tmpdir(), `g4a-pass-${process.pid}`);
  fs.writeFileSync(pf, 'correct horse battery\n', { mode: 0o600 });
  const d = await startDaemon(home, { G4A_KEY_PASSPHRASE_FILE: pf }); await stop(d);
  assert.match(fs.readFileSync(path.join(keysOf(home), 'witness-ed25519.pem'), 'utf8'), /ENCRYPTED PRIVATE KEY/);
  await assert.rejects(startDaemon(home), /passphrase-protected/);
  fs.writeFileSync(pf, 'wrong\n');
  await assert.rejects(startDaemon(home, { G4A_KEY_PASSPHRASE_FILE: pf }), /daemon exited/);
  fs.rmSync(pf);
});

test('A4 checked-out main: clean checkout is updated with the promotion, dirty checkout refuses', async () => {
  const home = mkHome(); const repo = mkRepo({ 'f.txt': '1\n', 'g.txt': 'g\n' }, { detach: false });
  const d = await startDaemon(home);
  try {
    const a = await rpc(home, 'claim', { repo, agent: 'a', paths: ['f.txt'], witnesses: ['true'] });
    commitIn(a.worktree, 'f.txt', '2\n', 'a');
    const r = await promote(home, repo, a);
    assert.equal(r.status, 'promoted', JSON.stringify(r));
    assert.equal(fs.readFileSync(path.join(repo, 'f.txt'), 'utf8'), '2\n');
    assert.equal(git(repo, 'status', '--porcelain', '--untracked-files=no'), '');
    await rpc(home, 'release', { repo, agent: 'a' });
    const b = await rpc(home, 'claim', { repo, agent: 'b', paths: ['f.txt'], witnesses: ['true'] });
    commitIn(b.worktree, 'f.txt', '3\n', 'b');
    fs.writeFileSync(path.join(repo, 'g.txt'), 'human edit in progress\n');
    const before = git(repo, 'rev-parse', 'main');
    const rb = await promote(home, repo, b);
    assert.equal(rb.reason, 'main_checked_out_dirty', JSON.stringify(rb));
    assert.equal(git(repo, 'rev-parse', 'main'), before);
    assert.equal(fs.readFileSync(path.join(repo, 'g.txt'), 'utf8'), 'human edit in progress\n');
  } finally { await stop(d); }
});

test('A5 per-repo job queues: promotions in two repos run in parallel', async () => {
  const home = mkHome();
  const r1 = mkRepo({ 'f.txt': '1\n' }), r2 = mkRepo({ 'f.txt': '1\n' });
  const d = await startDaemon(home);
  try {
    const cs = [];
    for (const repo of [r1, r2]) { const c = await rpc(home, 'claim', { repo, agent: 'a', paths: ['f.txt'], witnesses: ['sleep 1.5'] }); commitIn(c.worktree, 'f.txt', '2\n', 'x'); cs.push([repo, c]); }
    const t0 = Date.now();
    const rs = await Promise.all(cs.map(([repo, c]) => promote(home, repo, c)));
    const ms = Date.now() - t0;
    for (const r of rs) assert.equal(r.status, 'promoted', JSON.stringify(r));
    assert.ok(ms < 2900, `two 1.5s witnesses in two repos took ${ms}ms (serial would be >= 3000)`);
  } finally { await stop(d); }
});

test('A5 SQLite driver resolution is explicit', async () => {
  const A = await import('../src/authority.mjs');
  assert.equal(A.SQLITE.ok, true);
  assert.equal(typeof A.requireSqlite().open, 'function');
});
