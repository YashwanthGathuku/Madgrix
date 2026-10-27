// Phase 1: local daemon, claims, worktrees, ledger, promotion. No network, no Cloudflare.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(PKG, 'bin', 'g4a.mjs');
const ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

function git(cwd, ...a) { return execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, ...ID, G4A_RAW: '1' } }).trim(); }
function mkRepo(files) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'g4a-p1-repo-')));
  git(d, 'init', '-q', '-b', 'main');
  for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), t); }
  git(d, 'add', '-A'); git(d, 'commit', '-qm', 'base');
  git(d, 'checkout', '-q', '--detach'); // main is moved by update-ref, so keep it unchecked-out
  return d;
}
function cli(home, args, opts = {}) {
  const r = spawnSync(process.execPath, ['--no-warnings', CLI, ...args], { encoding: 'utf8', env: { ...process.env, G4A_HOME: home, ...opts.env }, cwd: opts.cwd });
  let json = null; try { json = JSON.parse(r.stdout); } catch {}
  return { ...r, json };
}
function startDaemon(home, env = {}) {
  const c = spawn(process.execPath, ['--no-warnings', CLI, 'daemon'], { env: { ...process.env, G4A_HOME: home, ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; c.stderr.on('data', (d) => { err += d; });
  return new Promise((res, rej) => {
    const t = setInterval(() => { if (err.includes('g4a daemon pid')) { clearInterval(t); res(c); } }, 20);
    c.on('exit', (code) => { clearInterval(t); rej(new Error(`daemon exited ${code}: ${err}`)); });
  });
}
const stop = (c) => new Promise((r) => { if (c.exitCode !== null || c.signalCode) return r(); c.once('exit', r); c.kill('SIGTERM'); });
const mkHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'g4a-p1-home-'));
async function rpc(home, method, params) { const { rpc } = await import('../src/daemon.mjs'); return rpc(method, params, { home }); }
function commitIn(wt, file, text, msg) { fs.mkdirSync(path.dirname(path.join(wt, file)), { recursive: true }); fs.writeFileSync(path.join(wt, file), text); git(wt, 'add', file); git(wt, 'commit', '-qm', msg); }
const secretOf = (home, id) => fs.readFileSync(path.join(home, 'secrets', id), 'utf8');

test('20 concurrent claimers on 4 contested paths: exactly one winner per path', async () => {
  const home = mkHome(); const repo = mkRepo({ 'a.txt': 'a' });
  const d = await startDaemon(home);
  try {
    const paths = ['src/p0.js', 'src/p1.js', 'src/p2.js', 'src/p3.js'];
    const rs = await Promise.all(Array.from({ length: 20 }, (_, i) => rpc(home, 'claim', { repo, agent: `ag${i}`, paths: [paths[i % 4]], witnesses: ['true'] }).catch((e) => ({ ok: false, error: e.message }))));
    const winners = rs.filter((r) => r.ok);
    assert.equal(winners.length, 4, JSON.stringify(rs.filter((r) => !r.ok).slice(0, 2)));
    assert.deepEqual(winners.map((w) => w.paths[0]).sort(), paths);
    const st = await rpc(home, 'status', { repo });
    assert.equal(st.claims.length, 4);
    for (const w of winners) assert.ok(fs.existsSync(path.join(repo, '.g4a', 'worktrees', w.agent, 'a.txt')));
    // dir ** overlap is also refused
    const ov = await rpc(home, 'claim', { repo, agent: 'late', paths: ['src/**'], witnesses: ['true'] });
    assert.equal(ov.ok, false);
    const v = cli(home, ['verify', '--repo', repo]);
    assert.equal(v.json.ok, true, v.stdout + v.stderr);
    assert.ok(v.json.entries >= 20); // 4 claims + 16 refusals + 1
  } finally { await stop(d); }
});

test('socket and key permissions; second daemon refuses; stale socket is cleaned', async () => {
  const home = mkHome();
  const d = await startDaemon(home);
  try {
    assert.equal(fs.statSync(path.join(home, 'g4a.sock')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(home, 'witness-ed25519.pem')).mode & 0o777, 0o600);
    await assert.rejects(startDaemon(home), /already running/);
  } finally { d.kill('SIGKILL'); await new Promise((r) => d.once('exit', r)); }
  assert.ok(fs.existsSync(path.join(home, 'g4a.sock'))); // stale after kill -9
  const d2 = await startDaemon(home); await stop(d2);
});

test('e2e local fork-crew: overlapping edits resolved by mergiraf in bwrap, witnesses signed, CAS to main, conflicting agent refused', async () => {
  const home = mkHome();
  const calc = 'export class Calc {\n  static VERSION = 1;\n  add(a, b) {\n    return a + b;\n  }\n}\n';
  const repo = mkRepo({
    'src/calc.js': calc, 'README.md': '# demo\n',
    'check.mjs': "import { Calc } from './src/calc.js';\nconst c = new Calc();\nif (c.add(2, 3) !== 5) process.exit(1);\nfor (const m of ['sub', 'mul']) if (typeof c[m] === 'function' && c[m](6, 3) !== (m === 'sub' ? 3 : 18)) process.exit(2);\n",
    'package.json': '{"type":"module"}\n',
  });
  const base = git(repo, 'rev-parse', 'main');
  const d = await startDaemon(home);
  try {
    const W = ['node check.mjs'];
    const a = await rpc(home, 'claim', { repo, agent: 'alice', paths: ['src/calc.js'], witnesses: W, allowOverlap: true });
    const b = await rpc(home, 'claim', { repo, agent: 'bob', paths: ['src/calc.js'], witnesses: W, allowOverlap: true });
    const c = await rpc(home, 'claim', { repo, agent: 'carol', paths: ['README.md'], witnesses: W });
    assert.ok(a.ok && b.ok && c.ok, JSON.stringify([a, b, c]));
    commitIn(a.worktree, 'src/calc.js', calc.replace('  }\n}', '  }\n  sub(a, b) {\n    return a - b;\n  }\n}'), 'sub');
    commitIn(b.worktree, 'src/calc.js', calc.replace('  }\n}', '  }\n  mul(a, b) {\n    return a * b;\n  }\n}'), 'mul');
    commitIn(c.worktree, 'README.md', '# demo\n\nusage\n', 'docs');
    // out-of-scope edit by carol on a second branch commit would be refused; checked below with dave
    const pa = await rpc(home, 'promote', { repo, agent: 'alice', secret: secretOf(home, a.id) });
    assert.equal(pa.status, 'promoted', JSON.stringify(pa)); assert.equal(pa.rung, 'fast-forward');
    const pb = await rpc(home, 'promote', { repo, agent: 'bob', secret: secretOf(home, b.id) });
    assert.equal(pb.status, 'promoted', JSON.stringify(pb)); assert.equal(pb.rung, 'mergiraf');
    const pc = await rpc(home, 'promote', { repo, agent: 'carol', secret: secretOf(home, c.id) });
    assert.equal(pc.status, 'promoted', JSON.stringify(pc)); assert.equal(pc.rung, 'git-merge-tree');
    const merged = git(repo, 'show', 'main:src/calc.js');
    assert.match(merged, /sub\(a, b\)/); assert.match(merged, /mul\(a, b\)/); assert.doesNotMatch(merged, /<<<<<<<|>>>>>>>/);
    assert.equal(git(repo, 'show', 'main:README.md'), '# demo\n\nusage');
    assert.equal(git(repo, 'merge-base', '--is-ancestor', base, 'main'), '');
    // wrong secret refused
    const bad = await rpc(home, 'promote', { repo, agent: 'carol', secret: 'nope' });
    assert.equal(bad.ok, false);
    // dave: same line as alice changed differently, from the old baseline -> unresolvable -> capsule
    await rpc(home, 'release', { repo, agent: 'alice' });
    const dv = await rpc(home, 'claim', { repo, agent: 'dave', paths: ['src/calc.js'], witnesses: W, allowOverlap: true });
    git(dv.worktree, 'reset', '-q', '--hard', base);
    commitIn(dv.worktree, 'src/calc.js', calc.replace('VERSION = 1;', 'VERSION = 2;'), 'reorder');
    git(repo, 'update-ref', 'refs/heads/g4a/dave', git(dv.worktree, 'rev-parse', 'HEAD'));
    const mainBefore = git(repo, 'rev-parse', 'main');
    // alice already promoted a sibling change to that line? no: make main change the same line
    // so dave genuinely conflicts.
    const e = await rpc(home, 'claim', { repo, agent: 'erin', paths: ['src/calc.js'], witnesses: W, allowOverlap: true });
    commitIn(e.worktree, 'src/calc.js', git(repo, 'show', 'main:src/calc.js').replace('VERSION = 1;', 'VERSION = 3;') + '\n', 'parens');
    const pe = await rpc(home, 'promote', { repo, agent: 'erin', secret: secretOf(home, e.id) });
    assert.equal(pe.status, 'promoted', JSON.stringify(pe));
    // dave's baseline must be the old main for scope diff; use his claim baseline via scope (only calc.js changed)
    const pd = await rpc(home, 'promote', { repo, agent: 'dave', secret: secretOf(home, dv.id) });
    assert.equal(pd.status, 'refused', JSON.stringify(pd)); assert.equal(pd.reason, 'unresolved_conflict');
    assert.equal(pd.capsule.files[0].path, 'src/calc.js');
    assert.ok(git(repo, 'rev-parse', 'main') !== mainBefore); // erin moved it; dave did not
    // out-of-scope: erin edits README which is not hers
    commitIn(e.worktree, 'README.md', 'hijack\n', 'oops');
    const po = await rpc(home, 'promote', { repo, agent: 'erin', secret: secretOf(home, e.id) });
    assert.equal(po.reason, 'out_of_scope');
    // offline verify over an exported bundle, pinned to the key
    const bundleFile = path.join(home, 'bundle.json');
    assert.equal(cli(home, ['ledger', '--repo', repo, '--out', bundleFile]).status, 0);
    const bundle = JSON.parse(fs.readFileSync(bundleFile, 'utf8'));
    const v = cli(home, ['verify', bundleFile, '--pin', bundle.witness_pub]);
    assert.equal(v.json.ok, true, v.stdout); assert.equal(v.json.promotions, 4);
    const kinds = bundle.entries.map((x) => x.kind);
    assert.ok(kinds.includes('promote_refused'));
    const rep = bundle.entries.find((x) => x.kind === 'promote' && x.payload.rung === 'mergiraf').payload.witness.report;
    assert.equal(rep.results[0].sandbox, 'bwrap'); assert.equal(rep.results[0].exit, 0);
    // a wrong pin fails
    const v2 = cli(home, ['verify', bundleFile, '--pin', 'ab'.repeat(22)]);
    assert.equal(v2.json.ok, false);
  } finally { await stop(d); }
});

test('ledger tamper detection: edited payload, edited witness report, deleted row', async () => {
  const home = mkHome(); const repo = mkRepo({ 'f.txt': '1\n' });
  const d = await startDaemon(home);
  let id;
  try {
    const c = await rpc(home, 'claim', { repo, agent: 'a', paths: ['f.txt'], witnesses: ['true'] });
    commitIn(c.worktree, 'f.txt', '2\n', 'two');
    const p = await rpc(home, 'promote', { repo, agent: 'a', secret: secretOf(home, c.id) });
    assert.equal(p.status, 'promoted', JSON.stringify(p));
    await rpc(home, 'claim', { repo, agent: 'b', paths: ['g.txt'], witnesses: ['true'] });
    id = c.id;
  } finally { await stop(d); }
  assert.equal(cli(home, ['verify', '--repo', repo]).json.ok, true);
  const dbf = path.join(home, 'g4a.db');
  { const db = new DatabaseSync(dbf); db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close(); }
  const base = fs.readFileSync(dbf);
  const tamper = (sql) => { fs.writeFileSync(dbf, base); for (const f of ['-wal', '-shm']) fs.rmSync(dbf + f, { force: true }); const db = new DatabaseSync(dbf); const n = db.prepare(sql).run().changes; db.close(); assert.ok(n > 0, `no row changed: ${sql}`); return cli(home, ['verify', '--repo', repo]).json; };
  assert.equal(tamper("UPDATE ledger SET payload = json_set(payload, '$.agent', 'mallory') WHERE kind = 'claim'").ok, false);
  assert.equal(tamper("UPDATE ledger SET payload = json_set(payload, '$.witness.report.results[0].exit', 1) WHERE kind = 'promote'").ok, false);
  assert.equal(tamper("UPDATE ledger SET entry_hash = 'ff' || substr(entry_hash, 3) WHERE seq = 0").ok, false);
  assert.equal(tamper('DELETE FROM ledger WHERE seq = 1').ok, false);
  // Known limit: dropping the newest entries leaves a valid shorter chain (no external head anchor).
  assert.equal(tamper('DELETE FROM ledger WHERE seq = (SELECT max(seq) FROM ledger)').ok, true);
  void id;
});

for (const point of ['G4A_TEST_CRASH_AFTER_INTENT', 'G4A_TEST_CRASH_AFTER_CAS']) {
  test(`crash recovery: daemon kill -9 (${point}); restart resumes and ledger verifies`, async () => {
    const home = mkHome(); const repo = mkRepo({ 'f.txt': '1\n', 'g.txt': 'x\n' });
    const d = await startDaemon(home, { [point]: '1' });
    const c = await rpc(home, 'claim', { repo, agent: 'a', paths: ['f.txt'], witnesses: ['sleep 0.3'] });
    git(repo, 'commit', '--allow-empty', '-qm', 'noop'); // keep HEAD detached; move nothing
    commitIn(c.worktree, 'f.txt', '2\n', 'two');
    // diverge main so the merge is a real merge commit
    const o = await rpc(home, 'claim', { repo, agent: 'o', paths: ['g.txt'], witnesses: ['true'] }); void o;
    const exited = new Promise((r) => d.once('exit', (code, sig) => r(sig)));
    rpc(home, 'promote', { repo, agent: 'a', secret: secretOf(home, c.id) }).catch(() => {});
    assert.equal(await exited, 'SIGKILL');
    const d2 = await startDaemon(home);
    try {
      let job;
      for (let i = 0; i < 200; i++) { const st = await rpc(home, 'status', { repo }); job = st.jobs?.[0]; if (job?.status === 'done') break; await new Promise((r) => setTimeout(r, 50)); }
      assert.equal(job?.status, 'done', JSON.stringify(job));
      assert.equal(git(repo, 'show', 'main:f.txt'), '2');
      const v = cli(home, ['verify', '--repo', repo]);
      assert.equal(v.json.ok, true, v.stdout); assert.equal(v.json.promotions, 1);
    } finally { await stop(d2); }
  });
}

test('shim wiring: write commands in a claimed worktree are checked; warn by default, block with G4A_ENFORCE=1, fail open when daemon down', async () => {
  const home = mkHome(); const repo = mkRepo({ 'f.txt': '1\n', 'other.txt': 'o\n' });
  assert.equal(cli(home, ['install']).status, 0);
  const shimDir = path.join(home, 'bin');
  const env = { ...process.env, ...ID, G4A_HOME: home, PATH: `${shimDir}:${process.env.PATH}`, G4A_AGENT: 'test' };
  delete env.G4A_RAW; delete env.G4A_ACTIVE;
  const d = await startDaemon(home);
  let wt;
  try {
    const c = await rpc(home, 'claim', { repo, agent: 'a', paths: ['f.txt'], witnesses: ['true'] });
    wt = c.worktree;
    fs.writeFileSync(path.join(wt, 'other.txt'), 'changed\n');
    spawnSync('git', ['add', 'other.txt'], { cwd: wt, env });
    const warn = spawnSync('git', ['commit', '-qm', 'x'], { cwd: wt, env, encoding: 'utf8' });
    assert.match(warn.stderr, /\[g4a\] warning: .*other\.txt/); assert.equal(warn.status, 0);
    fs.writeFileSync(path.join(wt, 'other.txt'), 'again\n');
    spawnSync('git', ['add', 'other.txt'], { cwd: wt, env });
    const blocked = spawnSync('git', ['commit', '-qm', 'y'], { cwd: wt, env: { ...env, G4A_ENFORCE: '1' }, encoding: 'utf8' });
    assert.equal(blocked.status, 1); assert.match(blocked.stderr, /blocked/);
    const st = await rpc(home, 'export', { repo });
    assert.ok(st.entries.some((e) => e.kind === 'scope_warning'));
  } finally { await stop(d); }
  const down = spawnSync('git', ['commit', '-qm', 'z'], { cwd: wt, env, encoding: 'utf8' });
  assert.match(down.stderr, /daemon unavailable/); assert.equal(down.status, 0);
});
