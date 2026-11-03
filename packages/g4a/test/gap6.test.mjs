// Gap 6: opt-in capture (redacted, local), search, static review, advisory eval hook.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as G from '../src/gap6.mjs';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/g4a.mjs');
const ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', G4A_RAW: '1' };
function fixture() {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'g4a-g6-')));
  const repo = path.join(d, 'r'), home = path.join(d, 'h'); fs.mkdirSync(repo); fs.mkdirSync(home, { mode: 0o700 });
  const git = (...a) => execFileSync('git', a, { cwd: repo, env: { ...process.env, ...ID }, encoding: 'utf8' });
  git('init', '-q', '-b', 'main'); fs.writeFileSync(path.join(repo, 'x.txt'), '1'); git('add', '-A'); git('commit', '-qm', 'add <script>alert(1)</script> widget');
  return { d, repo, home };
}
const TOK = 'ghp_' + 'A'.repeat(36);

test('capture is off by default; on, it is redacted, 0600, outside the repo, never stores secrets', () => {
  const { d, repo, home } = fixture();
  try {
    assert.equal(G.capture(repo, 'a1', 'claim', { intent: 'x' }, {}, home), false);
    assert.equal(fs.existsSync(path.join(home, 'sessions')), false);
    const env = { G4A_CAPTURE: '1' };
    assert.equal(G.capture(repo, 'a1', 'claim', { intent: `fix login token=${TOK}`, secret: 's3', credential: 'c3' }, env, home), true);
    assert.equal(G.capture(repo, '../evil', 'claim', {}, env, home), false); // agent name cannot escape the dir
    const ss = G.sessions(repo, home); assert.equal(ss.length, 1);
    const ln = path.join(d, 'alias'); fs.symlinkSync(repo, ln); assert.equal(G.sessions(ln, home).length, 1); // same repo via a symlink path
    const sd = fs.readdirSync(path.join(home, 'sessions'))[0]; fs.symlinkSync('/etc/passwd', path.join(home, 'sessions', sd, 'evil.jsonl'));
    assert.throws(() => G.capture(repo, 'evil', 'x', {}, env, home)); // O_NOFOLLOW: a planted symlink is never written through
    const raw = JSON.stringify(ss);
    assert.ok(!raw.includes(TOK) && !raw.includes('s3') && !raw.includes('c3'), raw);
    assert.match(ss[0].intent, /fix login/);
    const f = fs.readdirSync(path.join(home, 'sessions')).map((x) => path.join(home, 'sessions', x))[0];
    assert.equal(fs.statSync(f).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(f, 'a1.jsonl')).mode & 0o777, 0o600);
    assert.equal(execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' }), '');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('search finds sessions and commits; review html is escaped and script-free; CLI works', () => {
  const { d, repo, home } = fixture();
  try {
    G.capture(repo, 'a1', 'promote', { intent: 'widget polish' }, { G4A_CAPTURE: '1' }, home);
    const r = G.search(repo, 'widget', home);
    assert.equal(r.ok, true); assert.equal(r.sessions.length, 1); assert.equal(r.commits.length, 1);
    assert.equal(G.search(repo, '', home).ok, false);
    const html = G.reviewHtml(repo, home);
    assert.ok(!html.includes('<script'), 'no live script');
    assert.match(html, /&lt;script&gt;/); assert.match(html, /default-src 'none'/);
    const out = path.join(d, 'rev.html'); assert.equal(G.writeReview(repo, out, home), out);
    assert.equal(fs.statSync(out).mode & 0o777, 0o600);
    const env = { ...process.env, G4A_HOME: home };
    const cli = JSON.parse(execFileSync(process.execPath, [BIN, 'search', 'widget', '--repo', repo], { env, encoding: 'utf8' }));
    assert.equal(cli.commits.length, 1);
    const rv = JSON.parse(execFileSync(process.execPath, [BIN, 'review', '--repo', repo, '--out', path.join(d, 'c.html')], { env, encoding: 'utf8' }));
    assert.equal(rv.ok, true); assert.ok(fs.existsSync(path.join(d, 'c.html')));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('eval hook is advisory: off by default, failure/timeout recorded, input redacted, no credential env', () => {
  assert.equal(G.evalHook({ ok: true }, {}), undefined);
  const res = { ok: true, status: 'landed', note: `token=${TOK}` };
  const e1 = G.evalHook(res, { PATH: process.env.PATH, G4A_AGENT_CREDENTIAL: 'zzcred', G4A_EVAL_HOOK: 'cat; echo "[$G4A_AGENT_CREDENTIAL]"; exit 3' });
  assert.equal(e1.advisory, true); assert.equal(e1.exit, 3);
  assert.ok(!e1.output.includes(TOK) && !e1.output.includes('zzcred')); assert.match(e1.output, /\[\]/);
  assert.equal(res.ok, true); assert.equal(res.status, 'landed'); // never mutates the result
  const e2 = G.evalHook(res, { PATH: process.env.PATH, G4A_EVAL_HOOK: 'sleep 5', G4A_EVAL_TIMEOUT_MS: '200' });
  assert.equal(e2.timed_out, true);
});
