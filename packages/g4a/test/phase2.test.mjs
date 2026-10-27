import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { canonicalJson } from '../../../src/lib/canonical.ts';
import { initAuthority, agentPermit, mainPermit, pushWithPermit, landAgent, auditAuthority, revokeClaim } from '../src/authority-repo.mjs';

const ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd, ...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, ...ID } }); if (r.status) throw new Error(a.join(' ') + ': ' + r.stderr); return r.stdout.trim(); };
const raw = (bin, cwd, ...a) => spawnSync(bin, a, { cwd, encoding: 'utf8', env: { ...process.env, ...ID } });

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'g4a-p2-'));
  const kd = path.join(root, 'keys');
  const seed = path.join(root, 'seed');
  fs.mkdirSync(seed); git(seed, 'init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(seed, 'src/a'), { recursive: true }); fs.mkdirSync(path.join(seed, 'src/b'));
  fs.writeFileSync(path.join(seed, 'src/a/x.txt'), 'a\n'); fs.writeFileSync(path.join(seed, 'src/b/y.txt'), 'b\n');
  git(seed, 'add', '.'); git(seed, 'commit', '-qm', 'seed');
  const dir = path.join(root, 'authority.git');
  initAuthority({ dir, seedRepo: seed, kd });
  const work = path.join(root, 'work');
  git(root, '-c', 'protocol.file.allow=always', 'clone', '-q', dir, work);
  const base = git(work, 'rev-parse', 'HEAD');
  return { root, kd, dir, work, base };
}
const edit = (work, f, t, m) => { fs.writeFileSync(path.join(work, f), t); git(work, 'add', '.'); git(work, 'commit', '-qm', m); return git(work, 'rev-parse', 'HEAD'); };
const pushOpt = (bin, work, dir, ref, permit) => raw(bin, work, '-c', 'protocol.file.allow=always', 'push', ...(permit ? ['-o', `permit=${permit}`] : []), dir, `HEAD:${ref}`);

test('B: absolute /usr/bin/git push without a permit is refused (main and agent refs)', () => {
  const s = setup();
  edit(s.work, 'src/a/x.txt', 'a2\n', 'c');
  for (const ref of ['refs/heads/main', 'refs/heads/agents/alice', 'refs/heads/other']) {
    const r = pushOpt('/usr/bin/git', s.work, s.dir, ref);
    assert.notEqual(r.status, 0); assert.match(r.stderr, /no permit/);
  }
  // GIT_CONFIG_PARAMETERS / -c core.hooksPath on the client does not reach the authority
  const r = raw('/usr/bin/git', s.work, '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=always', 'push', s.dir, 'HEAD:refs/heads/main');
  assert.notEqual(r.status, 0); assert.match(r.stderr, /no permit/);
  assert.equal(git(s.dir, 'rev-parse', 'main'), s.base);
});

test('B: valid agent permit lands in-claim push; out-of-claim push refused; deletes refused', () => {
  const s = setup();
  const p = { agent: 'alice', claim: 'c1', paths: ['src/a/**'], baseline: s.base };
  edit(s.work, 'src/a/x.txt', 'a2\n', 'in');
  assert.equal(pushOpt('/usr/bin/git', s.work, s.dir, 'refs/heads/agents/alice', agentPermit(p, { kd: s.kd })).status, 0);
  edit(s.work, 'src/b/y.txt', 'b2\n', 'out');
  const r = pushOpt('/usr/bin/git', s.work, s.dir, 'refs/heads/agents/alice', agentPermit(p, { kd: s.kd }));
  assert.notEqual(r.status, 0); assert.match(r.stderr, /out-of-claim paths: src\/b\/y.txt/);
  // permit for alice cannot write bob's ref
  const rb = pushOpt('/usr/bin/git', s.work, s.dir, 'refs/heads/agents/bob', agentPermit(p, { kd: s.kd }));
  assert.match(rb.stderr, /permit is for refs\/heads\/agents\/alice/);
  const d = raw('/usr/bin/git', s.work, '-c', 'protocol.file.allow=always', 'push', '-o', `permit=${agentPermit(p, { kd: s.kd })}`, s.dir, ':refs/heads/agents/alice');
  assert.notEqual(d.status, 0);
  revokeClaim(s.dir, 'c1');
  git(s.work, 'reset', '-q', '--hard', 'HEAD~1'); edit(s.work, 'src/a/x.txt', 'a3\n', 'after-revoke');
  assert.match(pushOpt('/usr/bin/git', s.work, s.dir, 'refs/heads/agents/alice', agentPermit(p, { kd: s.kd })).stderr, /claim revoked/);
});

test('B: forged permit (other key, tampered payload, expired) is refused', () => {
  const s = setup();
  const sha = edit(s.work, 'src/a/x.txt', 'a2\n', 'c');
  const { privateKey } = generateKeyPairSync('ed25519');
  const permit = { version: 'g4a-permit/v1', kind: 'main', ref: 'refs/heads/main', old: s.base, new: sha, nonce: 'a'.repeat(32), exp: new Date(Date.now() + 60000).toISOString() };
  const forged = Buffer.from(JSON.stringify({ permit, signature: sign(null, Buffer.from(canonicalJson(permit)), privateKey).toString('base64') })).toString('base64');
  assert.match(pushOpt('/usr/bin/git', s.work, s.dir, 'refs/heads/main', forged).stderr, /signature invalid/);
  const good = JSON.parse(Buffer.from(mainPermit({ old: s.base, new: s.base }, { kd: s.kd }), 'base64'));
  good.permit.new = sha; // tamper
  assert.match(pushOpt('/usr/bin/git', s.work, s.dir, 'refs/heads/main', Buffer.from(JSON.stringify(good)).toString('base64')).stderr, /signature invalid/);
  assert.match(pushOpt('/usr/bin/git', s.work, s.dir, 'refs/heads/main', mainPermit({ old: s.base, new: sha }, { kd: s.kd, ttlMs: -1 })).stderr, /expired/);
  assert.equal(git(s.dir, 'rev-parse', 'main'), s.base);
});

test('B: replayed permit is refused', () => {
  const s = setup();
  const p = { agent: 'alice', claim: 'c1', paths: ['src/a/**'], baseline: s.base };
  const permit = agentPermit(p, { kd: s.kd });
  edit(s.work, 'src/a/x.txt', 'a2\n', 'one');
  assert.equal(pushOpt('git', s.work, s.dir, 'refs/heads/agents/alice', permit).status, 0);
  edit(s.work, 'src/a/x.txt', 'a3\n', 'two');
  assert.match(pushOpt('git', s.work, s.dir, 'refs/heads/agents/alice', permit).stderr, /replay/);
  // main permit replay: same old/new pinned, nonce consumed
  const m = git(s.dir, 'rev-parse', 'main');
  const sha = git(s.dir, 'rev-parse', 'refs/heads/agents/alice');
  const mp = mainPermit({ old: m, new: sha }, { kd: s.kd });
  assert.equal(pushWithPermit(s.dir, s.dir, sha, 'refs/heads/main', mp).status, 0);
  assert.equal(fs.readdirSync(path.join(s.dir, 'g4a/nonces')).length, 2); // one agent + one main nonces consumed
});

test('B: authority-side ladder lands main through the hook; witness failure rejects', async () => {
  const s = setup();
  const p = { agent: 'alice', claim: 'c1', paths: ['src/a/**'], baseline: s.base };
  edit(s.work, 'src/a/x.txt', 'a2\n', 'alice');
  assert.equal(pushOpt('git', s.work, s.dir, 'refs/heads/agents/alice', agentPermit(p, { kd: s.kd })).status, 0);
  const bad = await landAgent({ dir: s.dir, agent: 'alice', witnesses: ['exit 3'], kd: s.kd });
  assert.equal(bad.verdict, 'REJECT');
  const r = await landAgent({ dir: s.dir, agent: 'alice', witnesses: ['grep -q a2 src/a/x.txt'], kd: s.kd });
  assert.equal(r.verdict, 'PROMOTED', JSON.stringify(r));
  assert.equal(git(s.dir, 'rev-parse', 'main'), r.sha);
  assert.ok(auditAuthority(s.dir).ok);
});

test('B: direct ref write bypassing the hook is detected by audit (not prevented)', () => {
  const s = setup();
  const sha = edit(s.work, 'src/a/x.txt', 'zz\n', 'evil');
  // objects + ref written straight into the bare repo
  git(s.dir, '-c', 'protocol.file.allow=always', 'fetch', '-q', s.work, `${sha}:refs/heads/main`);
  const a = auditAuthority(s.dir);
  assert.equal(a.ok, false);
  assert.deepEqual(a.external.map((e) => e.ref), ['refs/heads/main']);
  // --receive-pack override from the same uid also bypasses the hook: also only detected
  const s2 = setup();
  edit(s2.work, 'src/a/x.txt', 'q\n', 'q');
  const r = raw('git', s2.work, '-c', 'protocol.file.allow=always', 'push', '--receive-pack=git -c core.hooksPath=/dev/null receive-pack', s2.dir, 'HEAD:refs/heads/main');
  assert.equal(r.status, 0);
  assert.equal(auditAuthority(s2.dir).ok, false);
});
