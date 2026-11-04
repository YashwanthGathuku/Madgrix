// Red-team of the long-running same-user authority server: real attack attempts against the socket.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

delete process.env.G4A_LOCAL_LAND;
const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(PKG, 'bin', 'g4a.mjs');
const SERVER = path.join(PKG, 'src', 'authority-server.mjs');
const ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const genv = { ...process.env, ...ID, G4A_RAW: '1' };
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: genv }).trim();
const tryGit = (cwd, ...a) => spawnSync('git', ['-c', 'protocol.file.allow=always', ...a], { cwd, encoding: 'utf8', env: genv });

const W = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'g4a-srv-')));
const repo = path.join(W, 'repo'), home = path.join(W, 'home'), root = path.join(W, 'auth');
let srv;
const raw = (line, sock = path.join(root, 'run', 'a.sock')) => new Promise((res) => {
  const c = net.connect(sock); let buf = '';
  c.on('connect', () => c.write(line));
  c.on('data', (d) => { buf += d; if (buf.includes('\n')) { c.destroy(); res(JSON.parse(buf.split('\n')[0])); } });
  c.on('error', (e) => res({ connectError: e.code })); c.on('close', () => res(buf ? JSON.parse(buf.split('\n')[0]) : { closed: true }));
});
const token = () => fs.readFileSync(path.join(root, 'run', 'token'), 'utf8').trim();
const req = (cmd, p = {}, over = {}) => raw(JSON.stringify({ id: randomBytes(16).toString('hex'), token: token(), cmd, p, ...over }) + '\n');

test.before(async () => {
  fs.mkdirSync(repo); git(repo, 'init', '-q', '-b', 'main'); fs.mkdirSync(path.join(repo, 'src')); fs.writeFileSync(path.join(repo, 'src', 'a'), '1\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base'); git(repo, 'checkout', '-q', '--detach');
  const r = spawnSync(process.execPath, ['--no-warnings', CLI, 'authority', 'init', root, '--repo', repo], { encoding: 'utf8', env: { ...process.env, G4A_HOME: home, G4A_KEY_DIR: `${home}-keys` } });
  assert.match(r.stdout, /"ok": ?true/, r.stderr);
  srv = spawn(process.execPath, ['--no-warnings', SERVER, '--root', root], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((res) => srv.stdout.once('data', res));
});
test.after(() => { srv.kill('SIGTERM'); fs.rmSync(W, { recursive: true, force: true }); fs.rmSync(`${home}-keys`, { recursive: true, force: true }); });

test('socket, run dir and token are private to the authority uid', () => {
  assert.equal(fs.statSync(path.join(root, 'run')).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(root, 'run', 'a.sock')).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(root, 'run', 'token')).mode & 0o777, 0o600);
});

test('another OS user cannot connect', { skip: spawnSync('sudo', ['-n', 'true']).status !== 0 && 'no passwordless sudo' }, () => {
  const sock = path.join(root, 'run', 'a.sock');
  const py = `import socket\ns=socket.socket(socket.AF_UNIX)\ntry:\n  s.connect(${JSON.stringify(sock)}); print('CONNECTED')\nexcept OSError as e: print('ERR', e.errno)`;
  const r = spawnSync('sudo', ['-n', '-u', 'nobody', '/usr/bin/python3', '-c', py], { encoding: 'utf8', cwd: '/' });
  assert.match(r.stdout, /ERR (13|2)\b/, r.stdout + r.stderr); assert.doesNotMatch(r.stdout, /CONNECTED/);
});

test('missing, wrong, or malformed token is refused', async () => {
  assert.equal((await raw(JSON.stringify({ id: randomBytes(16).toString('hex'), cmd: 'status' }) + '\n')).error, 'unauthorized');
  assert.equal((await req('status', {}, { token: '0'.repeat(64) })).error, 'unauthorized');
  assert.equal((await req('status', {}, { token: { length: 64 } })).error, 'unauthorized');
  assert.equal((await raw('not json\n')).error, 'bad json');
  assert.equal((await raw('[1]\n')).error, 'bad request');
});

test('replayed request id is refused; bad ids are refused', async () => {
  const id = randomBytes(16).toString('hex');
  const one = await raw(JSON.stringify({ id, token: token(), cmd: 'status' }) + '\n');
  assert.equal(one.r.ok, true);
  assert.equal((await raw(JSON.stringify({ id, token: token(), cmd: 'status' }) + '\n')).error, 'replayed request id');
  assert.equal((await req('status', {}, { id: '../x' })).error, 'bad request id');
});

test('privileged and unknown commands are not served (injection via cmd)', async () => {
  for (const cmd of ['operator-init', 'override', 'os-bind', 'os-unbind', 'os-policy', 'rebind', 'unbind', 'init-root', '__proto__', 'constructor', 'toString', 'status;id', ['status']])
    assert.equal((await req(cmd)).error, 'command not served', String(cmd));
  assert.equal((await req('status', [1, 2])).error, 'bad params');
  assert.equal((await req('status', 'x')).error, 'bad params');
});

test('oversized request is cut off', async () => {
  const r = await raw('x'.repeat((1 << 20) + 10));
  assert.ok(r.error === 'request too large' || r.closed, JSON.stringify(r));
});

test('agent-name injection and prototype keys are refused by the normal checks', async () => {
  for (const agent of ['..', '.', '.hidden', '../../etc', 'a;id', 'a b', '$(id)', '-rf', 'x'.repeat(65)]) {
    const r = (await req('claim', { agent, paths: ['src/**'] })).r;
    assert.notEqual(r.ok, true, agent);
  }
  const r = (await raw(`{"id":"${randomBytes(16).toString('hex')}","token":"${token()}","cmd":"status","p":{"__proto__":{"ok":false,"mode":"system"}}}\n`)).r;
  assert.equal(r.ok, true); assert.equal(r.mode, 'user');
});

test('credentials, one-time permits and claim scope still hold through the server', async () => {
  const c = (await req('claim', { agent: 'alice', paths: ['src/**'] })).r;
  assert.equal(c.ok, true, JSON.stringify(c).slice(0, 400));
  const cred = c.agent_credential; assert.ok(cred);
  assert.equal((await req('permit', { agent: 'alice', credential: 'wrong' + cred })).r.reason, 'agent_identity');
  assert.equal((await req('release', { agent: 'alice', credential: 'nope' })).r.ok, false);
  const pm = (await req('permit', { agent: 'alice', credential: cred })).r;
  assert.equal(pm.ok, true);
  const work = path.join(W, 'work'); git(repo, 'worktree', 'add', '-q', '--detach', work);
  fs.writeFileSync(path.join(work, 'src', 'a'), '2\n'); git(work, 'commit', '-qam', 'in scope');
  const url = path.join(root, 'repo');
  assert.equal(tryGit(work, 'push', '-q', '-o', `permit=${pm.permit}`, url, 'HEAD:refs/heads/agents/alice').status, 0);
  fs.writeFileSync(path.join(work, 'src', 'a'), '3\n'); git(work, 'commit', '-qam', 'again');
  const replay = tryGit(work, 'push', '-q', '-o', `permit=${pm.permit}`, url, 'HEAD:refs/heads/agents/alice');
  assert.notEqual(replay.status, 0, 'permit replay must be refused');
  const pm2 = (await req('permit', { agent: 'alice', credential: cred })).r;
  fs.writeFileSync(path.join(work, 'OUT'), 'x'); git(work, 'add', 'OUT'); git(work, 'commit', '-qm', 'out of scope');
  assert.notEqual(tryGit(work, 'push', '-q', '-o', `permit=${pm2.permit}`, url, 'HEAD:refs/heads/agents/alice').status, 0, 'out-of-claim push must be refused');
  assert.equal((await req('release', { agent: 'alice', credential: cred })).r.ok, true);
});

test('client refuses a run dir that is not private (no token use)', async () => {
  const { request } = await import('../src/authority-server.mjs');
  const fake = path.join(W, 'fake'); fs.mkdirSync(path.join(fake, 'run'), { recursive: true, mode: 0o777 }); fs.chmodSync(path.join(fake, 'run'), 0o777);
  fs.writeFileSync(path.join(fake, 'run', 'token'), 'a'.repeat(64));
  assert.equal(await request(fake, 'status', {}), null);
  const link = path.join(W, 'lnk'); fs.mkdirSync(link); fs.symlinkSync(path.join(root, 'run'), path.join(link, 'run'));
  assert.equal(await request(link, 'status', {}), null, 'symlinked run dir is not followed');
});

test('concurrent overlapping claims through the server: exactly one wins', async () => {
  const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => req('claim', { agent: `race${i}`, paths: ['src/**'] })));
  const won = rs.filter((x) => x.r?.ok);
  assert.equal(won.length, 1, JSON.stringify(rs.map((x) => x.r?.refused ?? x.r?.ok)));
  const i = rs.indexOf(won[0]);
  assert.equal((await req('release', { agent: `race${i}`, credential: won[0].r.agent_credential })).r.ok, true);
});
