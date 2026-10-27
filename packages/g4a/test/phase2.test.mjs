// Phase 2: authority-mediated promotion (same-user authority root; detect-only for the uid but the
// git-level guards are enforced). G4A_LOCAL_LAND is NOT set here: promote must go via the authority.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { generateKeyPairSync, sign } from 'node:crypto';

delete process.env.G4A_LOCAL_LAND;
const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(PKG, 'bin', 'g4a.mjs');
const ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, ...ID, G4A_RAW: '1' } }).trim();
const tryGit = (cwd, ...a) => spawnSync('git', ['-c', 'protocol.file.allow=always', ...a], { cwd, encoding: 'utf8', env: { ...process.env, ...ID, G4A_RAW: '1' } });
function mkRepo(files) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'g4a-p2-repo-')));
  git(d, 'init', '-q', '-b', 'main');
  for (const [f, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), t); }
  git(d, 'add', '-A'); git(d, 'commit', '-qm', 'base'); git(d, 'checkout', '-q', '--detach');
  return d;
}
const mkHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'g4a-p2-home-'));
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'g4a-p2-auth-'));
  const r = cli(home, ['authority', 'init', path.join(root, 'a'), '--repo', repo]);
  assert.equal(r.json?.ok, true, r.stdout + r.stderr);
  return path.join(root, 'a');
}
const accepted = (root) => (fs.existsSync(path.join(root, 'accepted.jsonl')) ? fs.readFileSync(path.join(root, 'accepted.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []);

test('item 1: without an authority (and without the test-only G4A_LOCAL_LAND) promote is refused', async () => {
  const home = mkHome(); const repo = mkRepo({ 'a.txt': 'a\n' });
  const d = await startDaemon(home);
  try {
    assert.equal((await rpc(home, 'claim', { repo, agent: 'a1', paths: ['a.txt'], witnesses: ['true'] })).ok, true);
    commitIn(wt(repo, 'a1'), 'a.txt', 'b\n');
    const main0 = git(repo, 'rev-parse', 'main');
    const p = cli(home, ['promote', '--repo', repo, '--agent', 'a1']);
    assert.equal(p.json.ok, false); assert.equal(p.json.reason, 'no_authority', p.stdout);
    assert.equal(git(repo, 'rev-parse', 'main'), main0);
  } finally { await stop(d); }
});

test('items 1,3,6: promote via the authority, overlap review case, verify + audit agree, accepted log exact', async () => {
  const home = mkHome();
  const src = 'export function add(a, b) {\n  return a + b;\n}\n';
  const repo = mkRepo({ 'add.js': src, 'b.txt': 'b\n', 'package.json': '{"type":"module","scripts":{"test":"node --test"}}\n', 'test/t.test.mjs': 'import "node:test";\n' });
  const root = withAuthority(home, repo);
  const d = await startDaemon(home);
  try {
    const c1 = await rpc(home, 'claim', { repo, agent: 'a1', paths: ['add.js'], witnesses: ['npm test'], allowOverlap: true });
    assert.equal(c1.ok, true, JSON.stringify(c1));
    assert.deepEqual([...c1.witness_paths].sort(), ['package.json', 'test/**']); // item 7: auto-derived
    const c2 = await rpc(home, 'claim', { repo, agent: 'a2', paths: ['add.js'], witnesses: ['true'], allowOverlap: true });
    assert.equal(c2.ok, true, JSON.stringify(c2));
    const c3 = await rpc(home, 'claim', { repo, agent: 'a3', paths: ['b.txt'], witnesses: ['true'] });
    assert.equal(c3.ok, true);
    commitIn(wt(repo, 'a1'), 'add.js', src.replace('a + b', 'a + b + 0'));
    commitIn(wt(repo, 'a2'), 'add.js', src.replace('a + b', 'Number(a) + Number(b)'));
    commitIn(wt(repo, 'a3'), 'b.txt', 'B\n');
    const p1 = cli(home, ['promote', '--repo', repo, '--agent', 'a1']);
    assert.equal(p1.json.status, 'promoted', p1.stdout + p1.stderr);
    assert.equal(p1.json.via, 'authority:user');
    const p3 = cli(home, ['promote', '--repo', repo, '--agent', 'a3']);
    assert.equal(p3.json.status, 'promoted', p3.stdout);
    const p2 = cli(home, ['promote', '--repo', repo, '--agent', 'a2']);
    assert.equal(p2.json.status, 'review', p2.stdout); assert.equal(p2.json.reason, 'same_region_overlap');
    assert.equal(git(repo, 'show', 'main:add.js'), src.replace('a + b', 'a + b + 0').trim());
    assert.equal(git(repo, 'show', 'main:b.txt'), 'B');
    assert.equal(git(repo, 'rev-parse', 'main'), git(path.join(root, 'repo'), 'rev-parse', 'main'));
    const v = cli(home, ['verify', '--repo', repo]);
    assert.equal(v.json.ok, true, JSON.stringify(v.json.errors)); assert.equal(v.json.authority.ok, true);
    assert.equal(v.json.promotions, 2);
    const au = cli(home, ['authority', 'audit', '--repo', repo]);
    assert.equal(au.json.ok, true, au.stdout);
    // accepted log: exactly the three permitted agent pushes, no false entries
    assert.deepEqual(accepted(root).filter((x) => x.kind === 'push').map((x) => x.ref).sort(), ['refs/heads/agents/a1', 'refs/heads/agents/a2', 'refs/heads/agents/a3']);
    // item 6: a local main edit is detected against the authority
    const good = git(repo, 'rev-parse', 'main');
    git(repo, 'update-ref', 'refs/heads/main', git(repo, 'rev-parse', `${good}~1`));
    const v2 = cli(home, ['verify', '--repo', repo]);
    assert.equal(v2.json.ok, false); assert.match(JSON.stringify(v2.json.errors), /main/);
    git(repo, 'update-ref', 'refs/heads/main', good);
    // item 6: a local DB edit (delete the newest ledger row) is detected against the authority anchors
    await stop(d);
    const db = new DatabaseSync(path.join(home, 'g4a.db'));
    db.exec('DELETE FROM ledger WHERE seq = (SELECT MAX(seq) FROM ledger)'); db.close();
    const v3 = cli(home, ['verify', '--repo', repo]);
    assert.equal(v3.json.ok, false, v3.stdout);
  } finally { await stop(d); }
});

test('items 3,5,6: pre-receive refuses unpermitted pushes, anchors are append-only, same-user ref edits are detected', async () => {
  const home = mkHome(); const repo = mkRepo({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
  const root = withAuthority(home, repo);
  const d = await startDaemon(home);
  try {
    assert.equal((await rpc(home, 'claim', { repo, agent: 'a1', paths: ['a.txt'], witnesses: ['true'] })).ok, true);
    const w = wt(repo, 'a1');
    commitIn(w, 'a.txt', 'x\n');
    const url = path.join(root, 'repo');
    const push = (...a) => tryGit(w, 'push', ...a);
    assert.notEqual(push(url, 'HEAD:refs/heads/agents/a1').status, 0, 'no permit');
    assert.notEqual(push(url, 'HEAD:refs/heads/main').status, 0, 'main');
    const { privateKey } = generateKeyPairSync('ed25519');
    const forged = { version: 'g4a-permit/v1', kind: 'agent', agent: 'a1', ref: 'refs/heads/agents/a1', nonce: 'f'.repeat(32), exp: new Date(Date.now() + 60e3).toISOString(), paths: ['**'] };
    const { canonicalJson } = await import('../../../src/lib/canonical.ts');
    const fb = Buffer.from(JSON.stringify({ permit: forged, signature: sign(null, Buffer.from(canonicalJson(forged)), privateKey).toString('base64') })).toString('base64');
    assert.notEqual(push('-o', `permit=${fb}`, url, 'HEAD:refs/heads/agents/a1').status, 0, 'forged');
    const { call, locate } = await import('../src/authority-client.mjs');
    const loc = locate(repo);
    const pm = call(loc, 'permit', { agent: 'a1' }).permit;
    assert.equal(push('-o', `permit=${pm}`, url, 'HEAD:refs/heads/agents/a1').status, 0, 'permitted push');
    commitIn(w, 'a.txt', 'y\n');
    assert.notEqual(push('-o', `permit=${pm}`, url, 'HEAD:refs/heads/agents/a1').status, 0, 'replay');
    commitIn(w, 'b.txt', 'out of scope\n');
    assert.notEqual(push('-o', `permit=${call(loc, 'permit', { agent: 'a1' }).permit}`, url, 'HEAD:refs/heads/agents/a1').status, 0, 'out-of-claim');
    assert.notEqual(push('-o', `permit=${call(loc, 'permit', { agent: 'a1' }).permit}`, url, ':refs/heads/agents/a1').status, 0, 'delete');
    assert.equal(accepted(root).length, 1, 'only the one permitted push is logged');
    // item 5: the anchor remote is append-only
    const anchors = path.join(root, 'anchors.git');
    const aref = tryGit(repo, 'ls-remote', anchors).stdout;
    assert.match(aref, /refs\/g4a\/(client|authority)-ledger/);
    assert.notEqual(tryGit(repo, 'push', anchors, 'main:refs/heads/x').status, 0, 'non-g4a ref');
    assert.notEqual(tryGit(repo, 'push', anchors, ':refs/g4a/client-ledger').status, 0, 'delete anchor');
    assert.notEqual(tryGit(repo, 'push', '--force', anchors, 'main:refs/g4a/client-ledger').status, 0, 'rewrite anchor');
    // item 6 (detect-only in same-user mode): a direct authority ref edit is caught by audit
    git(url, 'update-ref', 'refs/heads/agents/a1', git(url, 'rev-parse', 'main'));
    const au = cli(home, ['authority', 'audit', '--repo', repo]);
    assert.equal(au.json.ok, false, au.stdout);
  } finally { await stop(d); }
});

test('item 7: witnessPathsFor derives paths from commands, package scripts and dirs', async () => {
  const { Authority } = await import('../src/authority.mjs');
  const witnessPathsFor = (top, w) => Authority.prototype.witnessPathsFor.call(null, top, w);
  const repo = mkRepo({ 'package.json': JSON.stringify({ scripts: { test: 'npm run unit && node scripts/x.mjs', unit: 'node --test tests/' } }), 'scripts/x.mjs': '', 'tests/a.test.mjs': '', 'lib/a.js': '' });
  const s = (cmd) => [...witnessPathsFor(repo, [cmd])].sort();
  assert.deepEqual(s('npm test'), ['package.json', 'scripts/x.mjs', 'tests/**']);
  assert.deepEqual(s('FOO=1 node scripts/x.mjs | cat'), ['scripts/x.mjs']);
  assert.deepEqual(s('node --test'), ['tests/**']); // only default dirs that exist on main
  assert.deepEqual(s('node -e "require(\'./lib/a.js\')"'), []);
  assert.deepEqual(s('node --test lib'), ['lib/**']);
  assert.deepEqual(s("node --test 'tests/*.test.mjs'"), ['tests/*.test.mjs']);
});

test('item 9: keyDir refuses the real key dir under node --test', async () => {
  const { keyDir } = await import('../src/lib.mjs');
  assert.throws(() => keyDir({ NODE_TEST_CONTEXT: 'child' }), /G4A_KEY_DIR must be set/);
  assert.equal(keyDir({ NODE_TEST_CONTEXT: 'child', G4A_KEY_DIR: '/x' }), '/x');
});

const hasScript = spawnSync('script', ['--version']).status === 0 && spawnSync('setsid', ['--version']).status === 0;
test('item 4: operator key lives authority-side; override needs the passphrase typed on /dev/tty', { skip: !hasScript && 'needs util-linux script/setsid' }, async () => {
  const home = mkHome(); const repo = mkRepo({ 'a.txt': 'a\n' });
  const root = withAuthority(home, repo);
  const env = { ...process.env, ...H(home), G4A_AGENT: '0' };
  for (const k of Object.keys(env)) if (/^(CLAUDECODE|CODEX_|GEMINI_CLI|CURSOR_AGENT|G4A_AGENT_ID)/.test(k)) delete env[k];
  const q = (s) => `'${s.replace(/'/g, "'\\''")}'`;
  const cmd = (args) => `${q(process.execPath)} --no-warnings ${q(CLI)} ${args.map(q).join(' ')}`;
  // no controlling terminal: refused even with stdin piped
  const nt = spawnSync('setsid', ['-w', process.execPath, '--no-warnings', CLI, 'operator', 'init', '--repo', repo], { input: 'correct horse\ncorrect horse\n', encoding: 'utf8', env });
  assert.match(nt.stdout + nt.stderr, /\/dev\/tty unavailable/);
  assert.ok(!fs.existsSync(path.join(root, 'pub', 'operator.pub.hex')));
  const tty = (args, input) => spawnSync('script', ['-qec', cmd(args), '/dev/null'], { input, encoding: 'utf8', env });
  const oi = tty(['operator', 'init', '--repo', repo], 'correct horse\ncorrect horse\n');
  assert.match(oi.stdout, /"ok": true/, oi.stdout + oi.stderr);
  assert.ok(fs.existsSync(path.join(root, 'pub', 'operator.pub.hex')));
  assert.ok(fs.readdirSync(path.join(root, 'keys')).some((f) => /operator/.test(f)), 'operator key authority-side');
  assert.ok(!fs.existsSync(path.join(`${home}-keys`, 'operator-ed25519.pem')), 'no client-side operator key');
  const bad = tty(['override', '--repo', repo, '--minutes', '5', '--reason', 't'], 'wrong passphrase\n');
  assert.match(bad.stdout, /wrong passphrase/);
  const good = tty(['override', '--repo', repo, '--minutes', '5', '--reason', 't'], 'correct horse\n');
  assert.match(good.stdout, /"ok": true/, good.stdout);
  const { validOverride, overrideName } = await import('../src/override.mjs');
  const { repoId } = await import('../src/authority.mjs');
  const file = path.join(root, 'pub', 'overrides', overrideName(repoId(repo)));
  assert.ok(validOverride(repoId(repo), 'G4A_ENFORCE', `${home}-keys`, Date.now(), { pubFile: path.join(root, 'pub', 'operator.pub.hex'), file }));
  assert.ok(!validOverride(repoId(repo), 'G4A_ENFORCE', `${home}-keys`, Date.now() + 10 * 60e3, { pubFile: path.join(root, 'pub', 'operator.pub.hex'), file }), 'expires');
  // agent marker refuses outright
  const ag = spawnSync(process.execPath, ['--no-warnings', CLI, 'override', '--repo', repo, '--minutes', '5'], { encoding: 'utf8', env: { ...env, G4A_AGENT: 'a1' } });
  assert.notEqual(ag.status, 0);
});
