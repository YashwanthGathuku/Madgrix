// Per-agent-ref locking red-team: permits and pushes for different agent refs run in parallel,
// while one-time permits, exact refs, claim scope, ledger chain and audit still hold.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { agentLockName } from '../src/authority-service.mjs';

delete process.env.G4A_LOCAL_LAND;
const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(PKG, 'bin', 'g4a.mjs');
const SERVER = path.join(PKG, 'src', 'authority-server.mjs');
const ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const genv = { ...process.env, ...ID, G4A_RAW: '1' };
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: genv }).trim();
const gitA = (cwd, ...a) => new Promise((res) => { const c = spawn('git', ['-c', 'protocol.file.allow=always', ...a], { cwd, env: genv, stdio: 'ignore' }); c.on('close', (code) => res(code)); });

const W = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'g4a-perref-')));
const repo = path.join(W, 'repo'), home = path.join(W, 'home'), root = path.join(W, 'auth'), url = path.join(W, 'auth', 'repo');
let srv;
const startServer = async () => { srv = spawn(process.execPath, ['--no-warnings', SERVER, '--root', root], { stdio: ['ignore', 'pipe', 'ignore'] }); await new Promise((res) => srv.stdout.once('data', res)); };
const raw = (line) => new Promise((res) => {
  const c = net.connect(path.join(root, 'run', 'a.sock')); let buf = '';
  c.on('connect', () => c.write(line));
  c.on('data', (d) => { buf += d; if (buf.includes('\n')) { c.destroy(); res(JSON.parse(buf.split('\n')[0])); } });
  c.on('error', (e) => res({ connectError: e.code })); c.on('close', () => res(buf ? JSON.parse(buf.split('\n')[0]) : { closed: true }));
});
const token = () => fs.readFileSync(path.join(root, 'run', 'token'), 'utf8').trim();
const req = async (cmd, p = {}) => (await raw(JSON.stringify({ id: randomBytes(16).toString('hex'), token: token(), cmd, p }) + '\n')).r;
const creds = {};
const claim = async (agent, paths) => { const c = await req('claim', { agent, paths }); if (c?.ok) creds[agent] = c.agent_credential; return c; };
const work = (name, file) => { const w = path.join(W, `w-${name}-${randomBytes(3).toString('hex')}`); git(repo, 'worktree', 'add', '-q', '--detach', w); fs.mkdirSync(path.dirname(path.join(w, file)), { recursive: true }); fs.writeFileSync(path.join(w, file), randomBytes(8).toString('hex')); git(w, 'add', '-A'); git(w, 'commit', '-qm', name); return w; };

test.before(async () => {
  fs.mkdirSync(repo); git(repo, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(repo, 'README'), 'x\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base'); git(repo, 'checkout', '-q', '--detach');
  const r = spawnSync(process.execPath, ['--no-warnings', CLI, 'authority', 'init', root, '--repo', repo], { encoding: 'utf8', env: { ...process.env, G4A_HOME: home, G4A_KEY_DIR: `${home}-keys` } });
  assert.match(r.stdout, /"ok": ?true/, r.stderr);
  await startServer();
  for (const a of ['alice', 'bob']) assert.equal((await claim(a, [`agents/${a}/**`])).ok, true);
});
test.after(() => { srv?.kill('SIGTERM'); fs.rmSync(W, { recursive: true, force: true }); fs.rmSync(`${home}-keys`, { recursive: true, force: true }); });

test('agent lock names cannot escape the locks dir', () => {
  for (const a of ['..', '../x', 'a/b', '', '.x', 'a..b']) assert.throws(() => agentLockName(a), a);
  assert.equal(agentLockName('a-1'), path.join('locks', 'agent-a-1.d'));
});

test('one permit raced on two refs and twice on its own ref: at most one push lands', async () => {
  const pm = await req('permit', { agent: 'alice', credential: creds.alice });
  assert.equal(pm.ok, true);
  const w1 = work('a1', 'agents/alice/x'), w2 = work('a2', 'agents/alice/y'), w3 = work('b1', 'agents/bob/x');
  const codes = await Promise.all([
    gitA(w1, 'push', '-q', '-o', `permit=${pm.permit}`, url, 'HEAD:refs/heads/agents/alice'),
    gitA(w2, 'push', '-q', '-o', `permit=${pm.permit}`, url, 'HEAD:refs/heads/agents/alice'),
    gitA(w3, 'push', '-q', '-o', `permit=${pm.permit}`, url, 'HEAD:refs/heads/agents/bob'),
    gitA(w1, 'push', '-q', '-o', `permit=${pm.permit}`, url, 'HEAD:refs/heads/agents/alice', 'HEAD:refs/heads/agents/bob'),
  ]);
  assert.equal(codes.filter((c) => c === 0).length, 1, `codes ${codes}`);
  assert.notEqual(codes[2], 0, 'alice permit must never write agents/bob');
  assert.notEqual(codes[3], 0, 'multi-ref push refused');
  assert.equal(spawnSync('git', ['-C', url, 'rev-parse', '--verify', '--quiet', 'refs/heads/agents/bob']).status, 1, 'bob ref untouched');
});

test('parallel permits for 12 agent refs: all distinct, all pushes land in parallel', async () => {
  const ids = Array.from({ length: 12 }, (_, i) => `p${i}`);
  const cs = await Promise.all(ids.map((a) => claim(a, [`agents/${a}/**`])));
  assert.ok(cs.every((c) => c.ok), JSON.stringify(cs.find((c) => !c.ok)));
  const pms = await Promise.all(ids.map((a) => req('permit', { agent: a, credential: creds[a] })));
  assert.ok(pms.every((p) => p.ok));
  const nonces = pms.map((p) => JSON.parse(Buffer.from(p.permit, 'base64')).permit.nonce);
  assert.equal(new Set(nonces).size, ids.length);
  const ws = ids.map((a) => work(a, `agents/${a}/f`));
  const codes = await Promise.all(ids.map((a, i) => gitA(ws[i], 'push', '-q', '-o', `permit=${pms[i].permit}`, url, `HEAD:refs/heads/agents/${a}`)));
  assert.deepEqual(codes, ids.map(() => 0));
  // cross-ref write with a fresh permit: p0's permit to p1's ref is refused
  const x = await req('permit', { agent: 'p0', credential: creds.p0 });
  assert.notEqual(await gitA(work('x', 'agents/p1/g'), 'push', '-q', '-o', `permit=${x.permit}`, url, 'HEAD:refs/heads/agents/p1'), 0);
  // out-of-claim path on own ref is refused
  const y = await req('permit', { agent: 'p0', credential: creds.p0 });
  assert.notEqual(await gitA(work('y', 'agents/p1/g'), 'push', '-q', '-o', `permit=${y.permit}`, url, 'HEAD:refs/heads/agents/p0'), 0);
});

test('claim race: same agent name 8x, and 8 agents on one path: exactly one wins each', async () => {
  const same = await Promise.all(Array.from({ length: 8 }, () => req('claim', { agent: 'dup', paths: ['agents/dup/**'] })));
  assert.equal(same.filter((r) => r?.ok).length, 1, JSON.stringify(same.map((r) => r?.ok)));
  const over = await Promise.all(Array.from({ length: 8 }, (_, i) => req('claim', { agent: `ov${i}`, paths: ['shared/**'] })));
  assert.equal(over.filter((r) => r?.ok).length, 1);
});

test('lock-file tampering: planted symlink, dead-pid and pid-less stale dirs are cleared, never followed', async () => {
  const locks = path.join(root, 'locks'); fs.mkdirSync(locks, { recursive: true });
  const victim = path.join(W, 'victim'); fs.mkdirSync(victim); fs.writeFileSync(path.join(victim, 'keep'), 'k');
  const L = (a) => path.join(root, agentLockName(a));
  fs.rmSync(L('alice'), { recursive: true, force: true }); fs.symlinkSync(victim, L('alice'));
  assert.equal((await req('permit', { agent: 'alice', credential: creds.alice })).ok, true);
  assert.equal(fs.readFileSync(path.join(victim, 'keep'), 'utf8'), 'k', 'symlink target untouched');
  // dead pid
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
  fs.mkdirSync(L('bob')); fs.writeFileSync(path.join(L('bob'), 'pid'), dead);
  assert.equal((await req('permit', { agent: 'bob', credential: creds.bob })).ok, true);
  // pid-less dir older than 30 s (crash between mkdir and pid write)
  fs.mkdirSync(L('p1')); const old = new Date(Date.now() - 60_000); fs.utimesSync(L('p1'), old, old);
  assert.equal((await req('permit', { agent: 'p1', credential: creds.p1 })).ok, true);
  // a held lock (live pid) on alice delays only alice, not bob
  fs.mkdirSync(L('alice')); fs.writeFileSync(path.join(L('alice'), 'pid'), String(process.pid));
  const t0 = Date.now(); const pa = req('permit', { agent: 'alice', credential: creds.alice });
  const pb = await req('permit', { agent: 'bob', credential: creds.bob }); const tb = Date.now() - t0;
  assert.equal(pb.ok, true); assert.ok(tb < 700, `bob blocked ${tb} ms by alice's lock`);
  await new Promise((r) => setTimeout(r, 800)); fs.rmSync(L('alice'), { recursive: true });
  assert.equal((await pa).ok, true); assert.ok(Date.now() - t0 >= 800);
  // forged permit (tampered field) still refused at receive
  const pm = await req('permit', { agent: 'alice', credential: creds.alice });
  const o = JSON.parse(Buffer.from(pm.permit, 'base64')); o.permit.ref = 'refs/heads/agents/bob'; o.permit.agent = 'bob';
  assert.notEqual(await gitA(work('f', 'agents/bob/z'), 'push', '-q', '-o', `permit=${Buffer.from(JSON.stringify(o)).toString('base64')}`, url, 'HEAD:refs/heads/agents/bob'), 0);
});

test('crash mid-append: SIGKILL the authority during a claim burst; restart, chain and audit verify', async () => {
  const burst = Array.from({ length: 10 }, (_, i) => req('claim', { agent: `k${i}`, paths: [`agents/k${i}/**`] }));
  await new Promise((r) => setTimeout(r, 60)); srv.kill('SIGKILL'); await Promise.all(burst);
  await new Promise((r) => srv.once('exit', r)).catch(() => {});
  await startServer();
  const au = await req('audit');
  assert.equal(au.ok, true, JSON.stringify(au).slice(0, 600));
  const lg = await req('ledger'); assert.equal(lg.ok, true);
  const es = lg.bundle.entries; assert.ok(es.length > 5, 'ledger has entries');
  for (let i = 1; i < es.length; i++) if (es[i].prev_hash !== undefined) assert.equal(es[i].prev_hash, es[i - 1].entry_hash, `chain break at ${i}`);
  // the service still works after the crash (stale lock dirs of the dead pid are cleared)
  assert.equal((await claim('after', ['agents/after/**'])).ok, true);
  const pm = await req('permit', { agent: 'after', credential: creds.after });
  assert.equal(await gitA(work('after', 'agents/after/f'), 'push', '-q', '-o', `permit=${pm.permit}`, url, 'HEAD:refs/heads/agents/after'), 0);
});
