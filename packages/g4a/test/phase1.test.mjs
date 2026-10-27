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
const keysOf = (home) => `${home}-keys`; // signing key + external anchor live outside G4A_HOME
const H = (home) => ({ G4A_HOME: home, G4A_KEY_DIR: keysOf(home) });
function cli(home, args, opts = {}) {
  const r = spawnSync(process.execPath, ['--no-warnings', CLI, ...args], { encoding: 'utf8', env: { ...process.env, ...H(home), ...opts.env }, cwd: opts.cwd });
  let json = null; try { json = JSON.parse(r.stdout); } catch {}
  return { ...r, json };
}
function startDaemon(home, env = {}, argv = [CLI, 'daemon']) {
  const c = spawn(process.execPath, ['--no-warnings', ...argv], { env: { ...process.env, ...H(home), ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
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
    assert.equal(fs.statSync(path.join(keysOf(home), 'witness-ed25519.pem')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(keysOf(home)).mode & 0o777, 0o700);
    assert.ok(!fs.existsSync(path.join(home, 'witness-ed25519.pem')), 'key must not live next to the db');
    await assert.rejects(startDaemon(home), /already running/);
  } finally { d.kill('SIGKILL'); await new Promise((r) => d.once('exit', r)); }
  assert.ok(fs.existsSync(path.join(home, 'g4a.sock'))); // stale after kill -9
  // a key dir inside G4A_HOME is refused
  await assert.rejects(startDaemon(home, { G4A_KEY_DIR: path.join(home, 'k') }), /must not be inside/);
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
    // both sides changed the same base line: REVIEW, never auto-merged, main untouched
    const mainErin = git(repo, 'rev-parse', 'main');
    const pd = await rpc(home, 'promote', { repo, agent: 'dave', secret: secretOf(home, dv.id) });
    assert.equal(pd.status, 'review', JSON.stringify(pd)); assert.equal(pd.reason, 'same_region_overlap'); assert.equal(pd.verdict, 'REVIEW');
    assert.equal(git(repo, 'rev-parse', 'main'), mainErin);
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
    assert.ok(kinds.includes('promote_review') && kinds.includes('promote_refused'));
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
  // tail deletion is caught by the anchors outside G4A_HOME (repo ref + key-dir file)
  const tail = tamper('DELETE FROM ledger WHERE seq = (SELECT max(seq) FROM ledger)');
  assert.equal(tail.ok, false); assert.equal(tail.errors.filter((e) => /truncated or rolled back/.test(e)).length, 2, JSON.stringify(tail.errors));
  const tail3 = tamper('DELETE FROM ledger WHERE seq >= 2');
  assert.equal(tail3.ok, false);
  // with only the repo ref removed, the key-dir anchor still catches truncation
  fs.writeFileSync(dbf, base);
  git(repo, 'update-ref', '-d', 'refs/g4a/ledger-head');
  const noRef = tamper('DELETE FROM ledger WHERE seq = (SELECT max(seq) FROM ledger)');
  assert.equal(noRef.ok, false); assert.ok(noRef.errors.some((e) => /anchor missing/.test(e)) && noRef.errors.some((e) => /key-dir anchor.*truncated/.test(e)), JSON.stringify(noRef.errors));
  void id;
});

test('ledger rollback: restoring an old db copy is detected by verify and the daemon refuses to write', async () => {
  const home = mkHome(); const repo = mkRepo({ 'f.txt': '1\n' });
  const dbf = path.join(home, 'g4a.db');
  let d = await startDaemon(home);
  try { await rpc(home, 'claim', { repo, agent: 'a', paths: ['f.txt'], witnesses: ['true'] }); } finally { await stop(d); }
  { const db = new DatabaseSync(dbf); db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close(); }
  const snapshot = fs.readFileSync(dbf);
  d = await startDaemon(home);
  try {
    await rpc(home, 'release', { repo, agent: 'a' });
    await rpc(home, 'claim', { repo, agent: 'b', paths: ['g.txt'], witnesses: ['true'] });
  } finally { await stop(d); }
  assert.equal(cli(home, ['verify', '--repo', repo]).json.ok, true);
  fs.writeFileSync(dbf, snapshot); for (const f of ['-wal', '-shm']) fs.rmSync(dbf + f, { force: true });
  const v = cli(home, ['verify', '--repo', repo]).json;
  assert.equal(v.ok, false); assert.ok(v.errors.some((e) => /rolled back/.test(e)), JSON.stringify(v.errors));
  // the anchor is monotonic: the daemon will not start appending on top of a rolled-back db
  await assert.rejects(startDaemon(home), /rollback detected/);
  // the anchor chain's counters are strictly monotonic
  const counters = git(repo, 'log', '--format=%s', 'refs/g4a/ledger-head').split('\n').map((l) => Number(l.split(' ').pop()));
  assert.deepEqual(counters, [...counters].sort((x, y) => y - x)); assert.equal(new Set(counters).size, counters.length);
});

test('production code has no test crash switches', () => {
  for (const f of ['src/promote.mjs', 'src/daemon.mjs', 'src/authority.mjs', 'bin/g4a.mjs']) assert.doesNotMatch(fs.readFileSync(path.join(PKG, f), 'utf8'), /G4A_TEST_|CRASH/);
});

for (const point of ['afterIntent', 'afterCas']) {
  test(`crash recovery: daemon kill -9 (${point}, injected hook); restart resumes and ledger verifies`, async () => {
    const home = mkHome(); const repo = mkRepo({ 'f.txt': '1\n', 'g.txt': 'x\n' });
    const d = await startDaemon(home, {}, [path.join(PKG, 'test', 'fixtures', 'crash-daemon.mjs'), point]);
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

function agentEnv(home, extra = {}) {
  const env = { ...process.env, ...ID, ...H(home), PATH: `${path.join(home, 'bin')}:${process.env.PATH}`, G4A_AGENT: '1', ...extra };
  delete env.G4A_RAW; delete env.G4A_ACTIVE; delete env.G4A_ENFORCE;
  return env;
}
function humanEnv(home) {
  const env = agentEnv(home);
  for (const k of Object.keys(env)) if (k === 'G4A_AGENT' || k === 'CLAUDECODE' || k === 'GEMINI_CLI' || k === 'G4A_NONTTY_IS_AGENT' || k.startsWith('CODEX_')) delete env[k];
  return env;
}

test('shim enforcement: agents blocked by default out of scope, G4A_ENFORCE=0 opts out, daemon down fails closed, humans unaffected', async () => {
  const home = mkHome(); const repo = mkRepo({ 'f.txt': '1\n', 'other.txt': 'o\n' });
  assert.equal(cli(home, ['install']).status, 0);
  const env = agentEnv(home);
  const d = await startDaemon(home);
  let wt;
  try {
    const c = await rpc(home, 'claim', { repo, agent: 'a', paths: ['f.txt'], witnesses: ['true'] });
    wt = c.worktree;
    fs.writeFileSync(path.join(wt, 'other.txt'), 'changed\n');
    spawnSync('git', ['add', 'other.txt'], { cwd: wt, env });
    const blocked = spawnSync('git', ['commit', '-qm', 'x'], { cwd: wt, env, encoding: 'utf8' });
    assert.equal(blocked.status, 1, blocked.stderr); assert.match(blocked.stderr, /\[g4a\] blocked: .*other\.txt/);
    assert.equal(git(wt, 'rev-list', '--count', 'HEAD'), '1');
    const opt = spawnSync('git', ['commit', '-qm', 'y'], { cwd: wt, env: { ...env, G4A_ENFORCE: '0' }, encoding: 'utf8' });
    assert.equal(opt.status, 0, opt.stderr); assert.match(opt.stderr, /\[g4a\] warning: .*other\.txt/);
    // in-scope commit passes
    fs.writeFileSync(path.join(wt, 'f.txt'), '2\n');
    spawnSync('git', ['add', 'f.txt'], { cwd: wt, env });
    const ok = spawnSync('git', ['commit', '-qm', 'z'], { cwd: wt, env, encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    // reserved refs: update-ref main / branch -f main are blocked in the worktree
    const ur = spawnSync('git', ['update-ref', 'refs/heads/main', 'HEAD'], { cwd: wt, env, encoding: 'utf8' });
    assert.equal(ur.status, 1); assert.match(ur.stderr, /reserved to the g4a daemon/);
    // the main checkout of a managed repo: agent writes outside any claimed worktree are blocked
    fs.writeFileSync(path.join(repo, 'f.txt'), 'direct\n');
    const main = spawnSync('git', ['commit', '-qam', 'direct'], { cwd: repo, env, encoding: 'utf8' });
    assert.equal(main.status, 1); assert.match(main.stderr, /outside a claimed worktree/);
    assert.equal(spawnSync('git', ['branch'], { cwd: repo, env, encoding: 'utf8' }).status, 0); // listing is a read
    // humans pass through untouched (no marker, or G4A_AGENT=0)
    const h = spawnSync('git', ['commit', '-qm', 'human', '--allow-empty'], { cwd: wt, env: humanEnv(home), encoding: 'utf8' });
    assert.equal(h.status, 0, h.stderr); assert.doesNotMatch(h.stderr, /g4a/);
    const st = await rpc(home, 'export', { repo });
    assert.ok(st.entries.some((e) => e.kind === 'scope_warning'));
  } finally { await stop(d); }
  const down = spawnSync('git', ['commit', '-qm', 'z', '--allow-empty'], { cwd: wt, env, encoding: 'utf8' });
  assert.equal(down.status, 1); assert.match(down.stderr, /daemon unavailable.*fail closed/);
  const downOpt = spawnSync('git', ['commit', '-qm', 'z', '--allow-empty'], { cwd: wt, env: { ...env, G4A_ENFORCE: '0' }, encoding: 'utf8' });
  assert.equal(downOpt.status, 0); assert.match(downOpt.stderr, /daemon unavailable/);
  const downHuman = spawnSync('git', ['commit', '-qm', 'h2', '--allow-empty'], { cwd: wt, env: { ...humanEnv(home), G4A_AGENT: '0' }, encoding: 'utf8' });
  assert.equal(downHuman.status, 0, downHuman.stderr);
});

// ---- Mergiraf is never trusted alone ----
async function twoAgents(home, repo, files, witnesses, edits) {
  const a = await rpc(home, 'claim', { repo, agent: 'a', paths: files, witnesses: witnesses.a, allowOverlap: true });
  const b = await rpc(home, 'claim', { repo, agent: 'b', paths: files, witnesses: witnesses.b, allowOverlap: true });
  for (const [f, t] of Object.entries(edits.a)) commitIn(a.worktree, f, t, 'a');
  for (const [f, t] of Object.entries(edits.b)) commitIn(b.worktree, f, t, 'b');
  const pa = await rpc(home, 'promote', { repo, agent: 'a', secret: secretOf(home, a.id) });
  assert.equal(pa.status, 'promoted', JSON.stringify(pa));
  const mainA = git(repo, 'rev-parse', 'main');
  const pb = await rpc(home, 'promote', { repo, agent: 'b', secret: secretOf(home, b.id) });
  return { pa, pb, mainA };
}

test('regression: a+b+0 vs Number(a)+Number(b) (Mergiraf merges it) goes to REVIEW, not promoted', async () => {
  const home = mkHome();
  const src = 'export function add(a, b) {\n  return a + b;\n}\n';
  const repo = mkRepo({ 'add.js': src, 'package.json': '{"type":"module"}\n' });
  const d = await startDaemon(home);
  try {
    const { pb, mainA } = await twoAgents(home, repo, ['add.js'], { a: ['true'], b: ['true'] }, {
      a: { 'add.js': src.replace('a + b', 'a + b + 0') }, b: { 'add.js': src.replace('a + b', 'Number(a) + Number(b)') } });
    assert.equal(pb.status, 'review', JSON.stringify(pb)); assert.equal(pb.reason, 'same_region_overlap');
    assert.equal(git(repo, 'rev-parse', 'main'), mainA);
    assert.equal(git(repo, 'show', 'main:add.js'), src.replace('a + b', 'a + b + 0').trim());
    const e = (await rpc(home, 'export', { repo })).entries.find((x) => x.kind === 'promote_review');
    assert.equal(e.payload.verdict, 'REVIEW'); assert.match(e.payload.capsule_sha256, /^[0-9a-f]{64}$/);
  } finally { await stop(d); }
});

test('frozen intents: a later agent that breaks an earlier agent\'s witness is REFUSED, even on a clean merge', async () => {
  const home = mkHome();
  const repo = mkRepo({ 'lib.js': 'export const rate = 2;\n', 'use.js': 'export const x = 1;\n', 'package.json': '{"type":"module"}\n' });
  const d = await startDaemon(home);
  try {
    // a's intent: rate * 3 === 6 ; b's own witness is trivially true but b edits lib.js in a disjoint file region? no: b edits lib.js wholesale on top of main later
    const a = await rpc(home, 'claim', { repo, agent: 'a', paths: ['use.js'], witnesses: ["node -e \"import('./lib.js').then(m=>process.exit(m.rate*3===6?0:1))\""] });
    commitIn(a.worktree, 'use.js', "import { rate } from './lib.js';\nexport const x = rate * 3;\n", 'a');
    assert.equal((await rpc(home, 'promote', { repo, agent: 'a', secret: secretOf(home, a.id) })).status, 'promoted');
    const b = await rpc(home, 'claim', { repo, agent: 'b', paths: ['lib.js'], witnesses: ['true'] });
    commitIn(b.worktree, 'lib.js', 'export const rate = 5;\n', 'b');
    const mainA = git(repo, 'rev-parse', 'main');
    const pb = await rpc(home, 'promote', { repo, agent: 'b', secret: secretOf(home, b.id) });
    assert.equal(pb.status, 'refused', JSON.stringify(pb)); assert.equal(pb.reason, 'witness_failed'); assert.equal(pb.verdict, 'REFUSE');
    const failed = pb.results.find((r) => r.exit !== 0);
    assert.deepEqual(failed.agents, ['a']);
    assert.equal(git(repo, 'rev-parse', 'main'), mainA);
  } finally { await stop(d); }
});

test('concurrent top-level insertions at the same point: union rung keeps both, both intents must pass', async () => {
  const home = mkHome();
  const src = 'export function one() {\n  return 1;\n}\n';
  const repo = mkRepo({ 'm.js': src, 'package.json': '{"type":"module"}\n' });
  const d = await startDaemon(home);
  try {
    const wa = ["node -e \"import('./m.js').then(m=>process.exit(m.two()===2?0:1))\""];
    const wb = ["node -e \"import('./m.js').then(m=>process.exit(m.three()===3?0:1))\""];
    const { pb } = await twoAgents(home, repo, ['m.js'], { a: wa, b: wb }, {
      a: { 'm.js': src + '\nexport function two() {\n  return 2;\n}\n' }, b: { 'm.js': src + '\nexport function three() {\n  return 3;\n}\n' } });
    assert.equal(pb.status, 'promoted', JSON.stringify(pb)); assert.ok(['mergiraf', 'union-insertions'].includes(pb.rung), pb.rung);
    const m = git(repo, 'show', 'main:m.js'); assert.match(m, /function two/); assert.match(m, /function three/);
    const last = (await rpc(home, 'export', { repo })).entries.filter((x) => x.kind === 'promote').pop();
    assert.equal(last.payload.verdict, 'ADMIT');
    const agents = last.payload.witness.report.results.flatMap((r) => r.agents).sort();
    assert.deepEqual(agents, ['a', 'b']);
  } finally { await stop(d); }
});

test('concurrent duplicate top-level declarations: union rung output fails the witnesses and is refused cleanly', async () => {
  const home = mkHome();
  const src = 'export const base = 0;\n';
  const repo = mkRepo({ 'v.js': src, 'package.json': '{"type":"module"}\n' });
  const d = await startDaemon(home);
  try {
    const w = ["node -e \"import('./v.js').then(()=>0,()=>process.exit(1))\""];
    const { pb, mainA } = await twoAgents(home, repo, ['v.js'], { a: w, b: w }, {
      a: { 'v.js': src + 'export const v = 1;\n' }, b: { 'v.js': src + 'export const v = 2;\n' } });
    assert.equal(pb.status, 'refused', JSON.stringify(pb));
    assert.ok(['witness_failed', 'unresolved_conflict'].includes(pb.reason), pb.reason);
    assert.equal(git(repo, 'rev-parse', 'main'), mainA);
  } finally { await stop(d); }
});
