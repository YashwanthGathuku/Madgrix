// Limits pass: per-agent credentials (same-uid impersonation), out-of-band ref detection,
// SQLite driver fallback, MCP progress/cancel. Every fixture lives under os.tmpdir() and is removed.
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
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'g4a-l2-repo-')));
  git(d, 'init', '-q', '-b', 'main');
  for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), t); }
  git(d, 'add', '-A'); git(d, 'commit', '-qm', 'base'); git(d, 'checkout', '-q', '--detach');
  return d;
}
const mkHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'g4a-l2-home-'));
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
function commitIn(wt, file, text) { fs.writeFileSync(path.join(wt, file), text); git(wt, 'add', file); git(wt, 'commit', '-qm', `edit ${file}`); }
const wt = (repo, a) => path.join(repo, '.g4a', 'worktrees', a);
function withAuthority(home, repo) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'g4a-l2-auth-'));
  const r = cli(home, ['authority', 'init', path.join(root, 'a'), '--repo', repo]);
  assert.equal(r.json?.ok, true, r.stdout + r.stderr);
  return path.join(root, 'a');
}
const tmp = [];
const cleanup = () => { for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true }); };
const hasScript = spawnSync('script', ['--version']).status === 0;
const q = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
const ttyCli = (home, args, input, env = {}) => spawnSync('script', ['-qec', `${q(process.execPath)} --no-warnings ${q(CLI)} ${args.map(q).join(' ')}`, '/dev/null'], { input, encoding: 'utf8', env: { ...humanEnv(), ...H(home), ...env } });
function humanEnv() { const e = { ...process.env, G4A_AGENT: '0' }; for (const k of Object.keys(e)) if (/^(CLAUDECODE|CODEX_|GEMINI_CLI|CURSOR_AGENT|G4A_AGENT_ID)/.test(k)) delete e[k]; return e; }

test('limit 1: per-agent credential: a same-uid process that only knows the name cannot promote/release; operator rebind/unbind', { skip: !hasScript && 'needs util-linux script' }, async () => {
  const home = mkHome(); const repo = mkRepo({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
  const root = withAuthority(home, repo); tmp.push(home, `${home}-keys`, repo, path.dirname(root));
  const d = await startDaemon(home);
  try {
    // session store: the daemon keeps nothing; the claimant gets the credential once
    const c = await rpc(home, 'claim', { repo, agent: 'a1', paths: ['a.txt'], witnesses: ['true'], credentialStore: 'session' });
    assert.equal(c.ok, true, JSON.stringify(c)); assert.equal(c.credential_store, 'session');
    const cred = c.agent_credential; assert.match(cred, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(!fs.existsSync(path.join(home, 'credentials')), 'session credential not written to disk');
    assert.ok(!fs.readFileSync(path.join(root, 'state', 'agents.json'), 'utf8').includes(cred), 'authority stores only the hash');
    commitIn(wt(repo, 'a1'), 'a.txt', 'x\n');
    // impersonator: same uid, same G4A_HOME (can read the claim secret), knows the name, no credential
    const imp = cli(home, ['promote', '--repo', repo, '--agent', 'a1']);
    assert.equal(imp.json.ok, false, imp.stdout); assert.match(JSON.stringify(imp.json), /credential missing or wrong/);
    const wrong = cli(home, ['promote', '--repo', repo, '--agent', 'a1'], { G4A_AGENT_CREDENTIAL: 'z'.repeat(43) });
    assert.equal(wrong.json.ok, false);
    assert.equal(cli(home, ['claim', '--repo', repo, '--agent', 'a1', '--paths', 'b.txt']).json.ok, false, 're-claim of a bound name needs the credential');
    const relImp = cli(home, ['release', '--repo', repo, '--agent', 'a1']);
    assert.equal(relImp.json.ok, false); assert.equal(relImp.json.reason, 'agent_identity', 'neither authority nor local claim released');
    assert.equal((await rpc(home, 'status', { repo })).claims.some((x) => x.agent === 'a1'), true);
    // the real agent: credential on stdin (never argv)
    const okr = spawnSync(process.execPath, ['--no-warnings', CLI, 'promote', '--repo', repo, '--agent', 'a1', '--credential-stdin'], { input: cred, encoding: 'utf8', env: { ...process.env, ...H(home) } });
    assert.equal(JSON.parse(okr.stdout || '{}').status, 'promoted', okr.stdout + okr.stderr);
    assert.equal(cli(home, ['release', '--repo', repo, '--agent', 'a1', '--remove-worktree'], { G4A_AGENT_CREDENTIAL: cred }).json.authority.ok, true);
    git(repo, 'branch', '-D', 'g4a/a1');
    // default file store: written 0600 under G4A_HOME, used automatically
    const f = await rpc(home, 'claim', { repo, agent: 'a2', paths: ['b.txt'] });
    assert.equal(f.credential_store, 'file'); assert.equal(f.agent_credential, undefined);
    const cdir = path.join(home, 'credentials'); const cf = path.join(cdir, fs.readdirSync(cdir)[0], 'a2');
    assert.equal(fs.statSync(cf).mode & 0o777, 0o600);
    assert.equal((await rpc(home, 'release', { repo, agent: 'a2' })).authority.ok, true);
    // operator rebind / unbind: human-only, passphrase on /dev/tty, refused for agents
    assert.match(ttyCli(home, ['operator', 'init', '--repo', repo], 'correct horse\ncorrect horse\n').stdout, /"ok": true/);
    const ag = spawnSync(process.execPath, ['--no-warnings', CLI, 'authority', 'rebind', '--repo', repo, '--agent', 'a1'], { encoding: 'utf8', env: { ...process.env, ...H(home), G4A_AGENT: '1' } });
    assert.notEqual(ag.status, 0); assert.match(ag.stdout + ag.stderr, /human-only/, `${ag.status} ${ag.signal} ${ag.stdout}${ag.stderr}`);
    assert.match(ttyCli(home, ['authority', 'rebind', '--repo', repo, '--agent', 'a1'], 'wrong passphrase\n').stdout, /wrong passphrase/);
    const out = path.join(home, 'a1.cred');
    const rb = ttyCli(home, ['authority', 'rebind', '--repo', repo, '--agent', 'a1', '--credential-out', out], 'correct horse\n');
    assert.match(rb.stdout, /"ok": true/, rb.stdout); assert.ok(!rb.stdout.includes(fs.readFileSync(out, 'utf8')), 'credential not printed');
    const nc = fs.readFileSync(out, 'utf8');
    assert.equal(cli(home, ['claim', '--repo', repo, '--agent', 'a1', '--paths', 'a.txt'], { G4A_AGENT_CREDENTIAL: cred }).json.ok, false, 'old credential revoked');
    const c3 = cli(home, ['claim', '--repo', repo, '--agent', 'a1', '--paths', 'a.txt'], { G4A_AGENT_CREDENTIAL: nc });
    assert.equal(c3.json?.ok, true, c3.stdout + c3.stderr);
    assert.equal(cli(home, ['release', '--repo', repo, '--agent', 'a1'], { G4A_AGENT_CREDENTIAL: nc }).json.authority.ok, true);
    assert.match(ttyCli(home, ['authority', 'unbind', '--repo', repo, '--agent', 'a1'], 'correct horse\n').stdout, /"removed": true/);
    const log = fs.readFileSync(path.join(root, 'state', 'identity.jsonl'), 'utf8');
    assert.match(log, /"event":"rebind"[^\n]*operator_sig/); assert.match(log, /"event":"unbind"[^\n]*operator_sig/);
    assert.ok(!log.includes(cred) && !log.includes(nc));
  } finally { await stop(d); cleanup(); }
});

test('limit 3: reference-transaction guard refuses git-CLI main moves (any binary path); hook-skipping writes are detected by verify', async () => {
  const home = mkHome(); const repo = mkRepo({ 'a.txt': 'a\n' });
  // pre-existing user hook is chained, not clobbered
  const hd = path.join(repo, '.git', 'hooks'); fs.mkdirSync(hd, { recursive: true });
  fs.writeFileSync(path.join(hd, 'reference-transaction'), '#!/bin/sh\ncat >/dev/null\necho "$1" >> "$(dirname "$0")/../user-hook-ran"\n', { mode: 0o755 });
  const root = withAuthority(home, repo); tmp.push(home, `${home}-keys`, repo, path.dirname(root));
  assert.ok(fs.existsSync(path.join(hd, 'reference-transaction.g4a-prev')));
  const d = await startDaemon(home);
  const verify = () => cli(home, ['verify', '--repo', repo]).json;
  try {
    const c = await rpc(home, 'claim', { repo, agent: 'a1', paths: ['a.txt'], witnesses: ['true'] });
    commitIn(wt(repo, 'a1'), 'a.txt', 'b\n');
    assert.equal(cli(home, ['promote', '--repo', repo, '--agent', 'a1']).json.status, 'promoted', 'g4a control plane is not blocked by the guard');
    assert.equal(verify().ok, true, JSON.stringify(verify()));
    const main = git(repo, 'rev-parse', 'main'); const base = git(repo, 'rev-parse', 'main~1');
    // git CLI by absolute path, plain env (no shim): prevented
    const gitBin = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    for (const args of [['update-ref', 'refs/heads/main', base], ['branch', '-f', 'main', base], ['update-ref', 'refs/g4a/ledger-head', base]]) {
      const r = spawnSync(gitBin, args, { cwd: repo, encoding: 'utf8', env: { ...process.env, ...ID, G4A_RAW: '1' } });
      assert.notEqual(r.status, 0, args.join(' ')); assert.match(r.stderr, /g4a: refused/);
    }
    assert.equal(git(repo, 'rev-parse', 'main'), main);
    assert.ok(fs.existsSync(path.join(repo, '.git', 'user-hook-ran')), 'chained user hook still runs');
    // ordinary work on other refs is unaffected
    git(repo, 'branch', 'feature', base); git(repo, 'branch', '-D', 'feature');
    // the refusals themselves are reported
    assert.match(verify().errors.join('\n'), /hook refused an out-of-band ref change/);
    fs.rmSync(path.join(repo, '.git', 'g4a-ref-events.log'));
    assert.equal(verify().ok, true);
    // a hook-skipping write (what libgit2 / isomorphic-git / -c core.hooksPath do): NOT prevented, detected
    git(repo, '-c', 'core.hooksPath=/dev/null', 'update-ref', '-m', 'sneaky', 'refs/heads/main', base);
    let v = verify(); assert.equal(v.ok, false);
    assert.match(v.errors.join('\n'), /local main .* differs from authority main/); assert.match(v.errors.join('\n'), /"sneaky" was not written by g4a/);
    // restoring main does not hide it: the reflog entry stays
    git(repo, '-c', 'core.hooksPath=/dev/null', 'update-ref', '-m', 'restore', 'refs/heads/main', main);
    v = verify(); assert.equal(v.ok, false); assert.match(v.errors.join('\n'), /"sneaky"/);
    // raw file write, no reflog at all (a library writing .git/refs directly): detected via the authority main
    git(repo, 'reflog', 'expire', '--expire=now', '--all');
    fs.writeFileSync(path.join(repo, '.git', 'refs', 'heads', 'main'), base + '\n');
    v = verify(); assert.equal(v.ok, false); assert.match(v.errors.join('\n'), /differs from authority main/);
    // and the authority main is untouched throughout
    assert.equal(cli(home, ['authority', 'status', '--repo', repo]).json.main, main);
    void c;
  } finally { await stop(d); cleanup(); }
});

// Limit 4: storage behind a driver interface, exercised with node:sqlite and better-sqlite3.
test('limit 4: sqlite driver interface works with node:sqlite and better-sqlite3 (cross-readable)', () => {
  const bsq = process.env.G4A_BETTER_SQLITE3 || '/home/box/.cache/g4a-bsq';
  const haveBetter = fs.existsSync(path.join(bsq, 'node_modules', 'better-sqlite3'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g4a-l2-sqlite-')); tmp.push(dir); try {
    const script = (drv, n) => `
      const A = await import(${JSON.stringify(path.resolve('src/authority.mjs'))});
      const db = A.openDb(${JSON.stringify(dir)});
      db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)").run(${JSON.stringify(drv)}, String(${n}));
      const rows = db.prepare('SELECT k, v FROM meta ORDER BY k').all(); db.close();
      const ro = A.openDb(${JSON.stringify(dir)}, { readOnly: true }); const one = ro.prepare('SELECT v FROM meta WHERE k = ?').get(${JSON.stringify(drv)}); ro.close();
      console.log(JSON.stringify({ driver: A.SQLITE.driver, rows, one }));`;
    const run = (drv, n) => {
      const r = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', script(drv, n)], { encoding: 'utf8', env: { ...process.env, G4A_SQLITE_DRIVER: drv, G4A_BETTER_SQLITE3: bsq } });
      assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout.trim().split('\n').pop());
    };
    const a = run('node', 1);
    assert.equal(a.driver, 'node:sqlite'); assert.equal(a.one.v, '1');
    const bad = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', `const A = await import(${JSON.stringify(path.resolve('src/authority.mjs'))}); A.openDb(${JSON.stringify(dir)})`], { encoding: 'utf8', env: { ...process.env, G4A_SQLITE_DRIVER: 'bogus' } });
    assert.notEqual(bad.status, 0); assert.match(bad.stderr, /G4A_SQLITE_DRIVER must be/);
    if (!haveBetter) { console.log(`# limit 4: better-sqlite3 not installed at ${bsq}; only node:sqlite exercised`); return; }
    const b = run('better-sqlite3', 2);
    assert.equal(b.driver, 'better-sqlite3'); assert.equal(b.one.v, '2');
    assert.deepEqual(b.rows.map((r) => r.k), ['better-sqlite3', 'node']); // reads what node:sqlite wrote
    const c = run('node', 3); assert.deepEqual(c.rows.map((r) => [r.k, r.v]), [['better-sqlite3', '2'], ['node', '3']]);
  } finally { cleanup(); }
});
