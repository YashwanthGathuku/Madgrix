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

// Real-world interception paths coding tools use that do NOT pass through the PATH shim.
const REAL = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8', env: { ...process.env, PATH: '/usr/local/bin:/usr/bin:/bin' } }).trim();
const EXTRA = ['/usr/local/bin', '/usr/bin', '/bin'];
function tryCommit(kind, w, file) {
  fs.writeFileSync(path.join(w, file), `${kind}\n`);
  const env = { ...ID, PATH: EXTRA.join(':'), HOME: process.env.HOME };
  const sh = (cmd) => spawnSync('sh', ['-c', cmd], { cwd: w, encoding: 'utf8', env });
  const q = JSON.stringify;
  if (kind === 'absolute') return sh(`${REAL} add ${file} && ${REAL} commit -qm abs`);
  if (kind === 'env-i') return spawnSync('env', ['-i', ...Object.entries(ID).map(([k, v]) => `${k}=${v}`), 'sh', '-c', `cd ${q(w)} && git add ${file} && git commit -qm envi`], { encoding: 'utf8' });
  if (kind === 'ide') { const gd = git(w, 'rev-parse', '--absolute-git-dir'); return spawnSync('sh', ['-c', `${REAL} add ${file} && ${REAL} commit -qm ide`], { encoding: 'utf8', env: { ...env, GIT_DIR: gd, GIT_WORK_TREE: w }, cwd: os.tmpdir() }); }
  throw new Error(kind);
}

test('scope guard: out-of-claim commits via absolute git / env -i / IDE-style GIT_DIR are refused by the ref hook; in-claim passes; release lifts it', async () => {
  const home = mkHome(); const repo = mkRepo({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
  const root = withAuthority(home, repo); tmp.push(home, `${home}-keys`, repo, path.dirname(root));
  const d = await startDaemon(home);
  try {
    const c = await rpc(home, 'claim', { repo, agent: 'sc', paths: ['a.txt'], witnesses: ['true'] });
    assert.equal(c.ok, true, JSON.stringify(c));
    const w = wt(repo, 'sc');
    assert.ok(fs.existsSync(path.join(repo, '.git', 'g4a-scope', 'sc.json')), 'claim writes the scope file');
    for (const kind of ['absolute', 'env-i', 'ide']) {
      const before = git(w, 'rev-parse', 'HEAD');
      const r = tryCommit(kind, w, 'b.txt');
      assert.notEqual(r.status, 0, `${kind} out-of-claim commit must fail: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /g4a: refused: refs\/heads\/g4a\/sc paths outside claim .*b\.txt/, kind);
      assert.equal(git(w, 'rev-parse', 'HEAD'), before, `${kind}: branch did not move`);
      git(w, 'reset', '-q');
      git(w, 'checkout', '-q', '--', 'b.txt');
    }
    const ok = tryCommit('absolute', w, 'a.txt');
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(fs.readFileSync(path.join(repo, '.git', 'g4a-ref-events.log'), 'utf8'), /refused refs\/heads\/g4a\/sc paths outside claim/);
    const rel = await rpc(home, 'release', { repo, agent: 'sc' });
    assert.equal(rel.ok, true, JSON.stringify(rel));
    assert.ok(!fs.existsSync(path.join(repo, '.git', 'g4a-scope', 'sc.json')), 'release clears the scope file');
  } finally { await stop(d); cleanup(); }
});

test('scope guard: unit — deletions, unrelated refs and refs without a scope file pass', async () => {
  const { checkTransaction, writeScope } = await import('../src/scopecheck.mjs');
  const repo = mkRepo({ 'a.txt': 'a\n' }); tmp.push(repo); git(repo, 'checkout', '-q', 'main');
  const base = git(repo, 'rev-parse', 'HEAD');
  fs.writeFileSync(path.join(repo, 'z.txt'), 'z\n'); git(repo, 'add', 'z.txt'); git(repo, 'commit', '-qm', 'z');
  const head = git(repo, 'rev-parse', 'HEAD');
  const cd = path.join(repo, '.git');
  assert.deepEqual(checkTransaction(cd, `${base} ${head} refs/heads/g4a/x\n`), []); // no scope file
  writeScope(cd, 'x', { baseline: base, paths: ['dir/'] });
  assert.equal(checkTransaction(cd, `${base} ${head} refs/heads/g4a/x\n`).length, 1);
  assert.deepEqual(checkTransaction(cd, `${head} ${'0'.repeat(40)} refs/heads/g4a/x\n`), []);
  assert.deepEqual(checkTransaction(cd, `${base} ${head} refs/heads/feature\n`), []);
  writeScope(cd, 'x', { baseline: base, paths: ['z.txt'] });
  assert.deepEqual(checkTransaction(cd, `${base} ${head} refs/heads/g4a/x\n`), []);
  cleanup();
});
