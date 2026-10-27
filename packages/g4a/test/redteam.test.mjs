// Regression tests for the red-team review of PR #15 (REDTEAM.md F1-F9). Each test replays the
// report's repro command and asserts it is now closed. Fake secrets are assembled at runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { redact, minimiseArgv } from '../src/privacy.mjs';
import { parseGit, isWrite } from '../src/lib.mjs';
import { checkClaimInputs, claimOverlap, commitPathspecs } from '../src/authority.mjs';
import { callTool, publicError } from '../src/mcp.mjs';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(PKG, 'bin', 'g4a.mjs');
const SHIM = path.join(PKG, 'src', 'shim.mjs');
const REAL = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
const ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const cleanEnv = () => { const e = { ...process.env, ...ID }; for (const k of ['NODE_TEST_CONTEXT', 'CODEX_HOME', 'G4A_RAW', 'G4A_ENFORCE', 'G4A_ACTIVE', 'G4A_AGENT', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete e[k]; return e; };
const git = (cwd, ...a) => execFileSync(REAL, a, { cwd, encoding: 'utf8', env: cleanEnv() }).trim();
const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const H = (home) => ({ G4A_HOME: home, G4A_KEY_DIR: `${home}-keys` });
function startDaemon(home) {
  const c = spawn(process.execPath, ['--no-warnings', CLI, 'daemon'], { env: { ...cleanEnv(), ...H(home) }, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; c.stderr.on('data', (d) => { err += d; });
  return new Promise((res, rej) => {
    const t = setInterval(() => { if (err.includes('g4a daemon pid')) { clearInterval(t); res(c); } }, 20);
    c.on('exit', (code) => { clearInterval(t); rej(new Error(`daemon exited ${code}: ${err}`)); });
  });
}
const stop = (c) => new Promise((r) => { if (c.exitCode !== null || c.signalCode) return r(); c.once('exit', r); c.kill('SIGTERM'); });
async function rpc(home, method, params) { const { rpc } = await import('../src/daemon.mjs'); return rpc(method, params, { home }); }
// exactly the report's driver: CLAUDECODE=1 G4A_REAL_GIT=<git> node src/shim.mjs ...
const shim = (home, cwd, args, extra = {}) => spawnSync(process.execPath, ['--no-warnings', SHIM, ...args], { cwd, encoding: 'utf8', env: { ...cleanEnv(), ...H(home), CLAUDECODE: '1', G4A_REAL_GIT: REAL, ...extra } });

test('F1: global options, -C from outside, aliases and extra write subcommands cannot skip shim scope enforcement', async () => {
  const home = tmp('g4a-rt-home-'); const repo = tmp('g4a-rt-repo-');
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n'); fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base'); git(repo, 'checkout', '-q', '--detach');
  const d = await startDaemon(home);
  try {
    const c = await rpc(home, 'claim', { repo, agent: 'a1', paths: ['a.txt'], witnesses: ['true'] });
    assert.equal(c.ok, true, JSON.stringify(c));
    const W = c.worktree;
    fs.writeFileSync(path.join(W, 'b.txt'), 'changed\n'); git(W, 'add', 'b.txt');
    const head = git(W, 'rev-parse', 'HEAD');
    const blocked = (r, re = /blocked/) => { assert.equal(r.status, 1, r.stdout + r.stderr); assert.match(r.stderr, re); assert.equal(git(W, 'rev-parse', 'HEAD'), head, 'no commit may be created'); };
    blocked(shim(home, W, ['commit', '-qm', 'control']), /outside claim/);
    blocked(shim(home, W, ['-c', 'x.y=z', 'commit', '-qm', 'cflag']), /outside claim/);
    blocked(shim(home, W, ['--paginate', 'commit', '-qm', 'paginate']), /outside claim/);
    blocked(shim(home, W, ['-p', 'commit', '-qm', 'p']), /outside claim/);
    blocked(shim(home, W, ['--exec-path=/usr/lib/git-core', 'commit', '-qm', 'e']), /exec-path/);
    blocked(shim(home, W, ['-C', '.', 'commit', '-qm', 'dashC']), /outside claim/);
    blocked(shim(home, os.tmpdir(), ['-C', W, 'commit', '-qm', 'outside']), /outside claim/);
    blocked(shim(home, os.tmpdir(), ['--git-dir', path.join(repo, '.git', 'worktrees', 'a1'), '--work-tree', W, 'commit', '-qm', 'gd']), /git-dir/);
    blocked(shim(home, W, ['commit', '-qm', 'envdir'], { GIT_DIR: git(W, 'rev-parse', '--absolute-git-dir') }), /GIT_DIR/);
    blocked(shim(home, W, ['--no-advice', '--glob-pathspecs', 'commit', '-qm', 'g']), /outside claim/);
    blocked(shim(home, W, ['--bogus-global', 'commit', '-qm', 'u']), /fails closed/);
    // aliases: -c alias.* refused; config aliases resolved and checked
    blocked(shim(home, W, ['-c', 'alias.ci=commit', 'ci', '-qm', 'alias']), /alias\.ci/);
    git(repo, 'config', 'alias.ci', 'commit -q');
    blocked(shim(home, W, ['ci', '-m', 'cfgalias']), /outside claim/);
    // commit with a pathspec commits unstaged out-of-claim files
    git(W, 'reset', '-q');
    blocked(shim(home, W, ['commit', '-qm', 'spec', 'b.txt']), /outside claim/);
    blocked(shim(home, W, ['commit', '-mdom', 'b.txt']), /outside claim/);
    // F2: core.hooksPath / logAllRefUpdates overrides refused (per command, env and persistent)
    blocked(shim(home, W, ['-c', 'core.hooksPath=/dev/null', 'update-ref', 'refs/heads/main', 'HEAD']), /core\.hookspath/);
    blocked(shim(home, W, ['-c', 'core.logAllRefUpdates=false', 'status']), /core\.logallrefupdates/);
    blocked(shim(home, W, ['update-ref', 'refs/heads/main', 'HEAD'], { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null' }), /core\.hookspath/);
    blocked(shim(home, W, ['--config-env=core.hooksPath=HOME', 'status']), /core\.hookspath/);
    blocked(shim(home, W, ['config', 'core.hooksPath', '/dev/null']), /core\.hooksPath/);
    blocked(shim(home, W, ['update-ref', '--stdin']), /reserved/);
    blocked(shim(home, W, ['symbolic-ref', 'HEAD', 'refs/heads/main']), /reserved/);
    blocked(shim(home, W, ['replace', 'HEAD', 'HEAD~0']), /replace/);
    blocked(shim(home, W, ['reflog', 'expire', '--all']), /reflog/);
    // the main checkout: newly covered write subcommands are blocked outside a claimed worktree
    for (const a of [['tag', 'v1'], ['stash'], ['notes', 'add', '-m', 'n'], ['rm', '-q', '--cached', 'a.txt'], ['mv', 'a.txt', 'z.txt'], ['restore', 'a.txt'], ['worktree', 'add', '../x'], ['commit-tree', 'HEAD^{tree}', '-m', 'x']]) {
      const r = shim(home, repo, a); assert.equal(r.status, 1, `${a.join(' ')}: ${r.stderr}`); assert.match(r.stderr, /outside a claimed worktree/);
    }
    // reads still work, in and out of the worktree
    assert.equal(shim(home, W, ['-p', 'log', '--oneline', '-1']).status, 0);
    assert.equal(shim(home, repo, ['tag', '-l']).status, 0);
    assert.equal(shim(home, repo, ['stash', 'list']).status, 0);
    assert.equal(shim(home, repo, ['config', 'user.email']).status, 0);
    // in-scope commit still passes, through every global-option form
    fs.writeFileSync(path.join(W, 'a.txt'), 'a2\n'); git(W, 'add', 'a.txt');
    const ok = shim(home, os.tmpdir(), ['-C', W, '-c', 'x.y=z', '--paginate', 'commit', '-qm', 'in scope']);
    assert.equal(ok.status, 0, ok.stderr);
    // the ledger recorded the attempts
    const ex = await rpc(home, 'export', { repo });
    assert.ok(ex.entries.filter((e) => e.kind === 'scope_warning').length >= 6);
  } finally { await stop(d); for (const p of [home, `${home}-keys`, repo]) fs.rmSync(p, { recursive: true, force: true }); }
});

test('F1: parseGit knows every git global option; isWrite / commitPathspecs; authority no longer uses argv.find', () => {
  assert.deepEqual(parseGit(['-c', 'x.y=z', 'commit', '-qm', 'm']).sub, 'commit');
  assert.deepEqual(parseGit(['-C', '.', '-C', 'sub', 'commit']).C, ['.', 'sub']);
  for (const g of ['-p', '--paginate', '-P', '--no-pager', '--no-advice', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs', '--literal-pathspecs', '--no-lazy-fetch', '--no-optional-locks', '--bare', '--no-replace-objects', '--exec-path=/x', '--git-dir=/x', '--work-tree=/x', '--namespace=n', '--attr-source=HEAD', '--config-env=a.b=HOME'])
    assert.equal(parseGit([g, 'commit'])?.sub, 'commit', g);
  assert.equal(parseGit(['--bogus', 'commit']), null);
  assert.equal(parseGit(['-c']), null);
  assert.equal(parseGit(['--exec-path=/usr/lib/git-core', 'commit']).execPath, '/usr/lib/git-core');
  assert.equal(isWrite('tag', ['-l']), false); assert.equal(isWrite('tag', ['v1']), true);
  assert.equal(isWrite('stash', []), true); assert.equal(isWrite('stash', ['list']), false);
  assert.equal(isWrite('worktree', ['list']), false); assert.equal(isWrite('branch', ['-a']), false); assert.equal(isWrite('branch', ['x']), true);
  assert.deepEqual(commitPathspecs(['-qm', 'msg', 'b.txt']).specs, ['b.txt']);
  assert.deepEqual(commitPathspecs(['-mdom', 'b.txt']).specs, ['b.txt']);
  assert.deepEqual(commitPathspecs(['-m', 'x', '--', 'c']).specs, ['c']);
  const src = fs.readFileSync(path.join(PKG, 'src', 'authority.mjs'), 'utf8');
  assert.ok(!/argv\.find\(/.test(src), 'authority must not derive the subcommand with argv.find');
});

test('F3: combined short flags, attached values and search content never reach the log', () => {
  const m = (a) => JSON.stringify(minimiseArgv(a));
  assert.ok(!m(['commit', '--author=Alice <alice@corp.example>', '-qm', 'secret body']).includes('secret body'));
  assert.ok(!m(['commit', '-am', 'secret body']).includes('secret body'));
  assert.ok(!m(['commit', '-qmsecretbody']).includes('secretbody'));
  assert.ok(!m(['commit', '--message=secret']).includes('secret'));
  assert.ok(!m(['commit', '-Fnotes.txt']).includes('notes.txt'));
  assert.ok(!m(['log', '--grep=pass hunter2']).includes('hunter2'));
  assert.ok(!m(['log', '--grep', 'pass hunter2']).includes('hunter2'));
  assert.ok(!m(['log', '-S', 'hunter2']).includes('hunter2'));
  assert.ok(!m(['log', '-Ghunter2']).includes('hunter2'));
  assert.deepEqual(minimiseArgv(['commit', '-S', '-m', 'x']), ['commit', '-S', '-m', '[1 chars]']);
  assert.deepEqual(minimiseArgv(['log', '-n5', '--oneline']), ['log', '-n5', '--oneline']);
});

test('F4: scheme://user:tok@ and scheme://tok@ credentials of any length are redacted, including insteadOf', () => {
  assert.equal(redact('https://shorttok99@127.0.0.1:1/x'), 'https://[REDACTED]@127.0.0.1:1/x');
  assert.equal(redact('https://t@h/x'), 'https://[REDACTED]@h/x');
  assert.equal(redact('https://u:p@h/x'), 'https://u:[REDACTED]@h/x');
  assert.ok(!JSON.stringify(minimiseArgv(['-c', 'url.https://abcd1234tok@github.com/.insteadOf=https://github.com/', 'status'])).includes('abcd1234tok'));
  assert.ok(!JSON.stringify(minimiseArgv(['ls-remote', 'https://shorttok99@127.0.0.1:1/x'])).includes('shorttok99'));
  assert.equal(redact('ssh://git@github.com/o/r'), 'ssh://git@github.com/o/r');
});

test('F5: witness commands carrying credentials or auth headers are refused at claim time', () => {
  const UP = ['admin', ['hun', 'ter2'].join('')].join(':');
  for (const w of ['curl -H "X-Tok: s3cr3tvalue" -u ' + UP + ' https://e', 'curl -u ' + UP + ' https://e', 'curl --user=' + UP + ' https://e', "curl -H 'X-Tok: v' https://e",
    'curl --header "X-Api-Key: v" https://e', 'curl --oauth2-bearer abc https://e', 'curl --cookie session=abc https://e'])
    assert.throws(() => checkClaimInputs(['a.txt'], [w]), /credentials|secret/, w);
  for (const w of ['npm test', 'curl -H "Content-Type: application/json" https://e', 'node test/a.test.mjs -u']) assert.doesNotThrow(() => checkClaimInputs(['a.txt'], [w]), w);
});

test('F6: a symlink planted in the key dir is not followed; a symlinked G4A_KEY_DIR is refused', async () => {
  const base = tmp('g4a-rt-keys-');
  const kd = path.join(base, 'k'); fs.mkdirSync(kd, { mode: 0o700 });
  const victim = path.join(base, 'victim'); fs.writeFileSync(victim, 'original\n');
  fs.symlinkSync(victim, path.join(kd, 'witness-ed25519.pub.hex'));
  const home = path.join(base, 'home');
  const env = { ...cleanEnv(), G4A_HOME: home, G4A_KEY_DIR: kd };
  const r = spawnSync(process.execPath, ['--no-warnings', CLI, 'daemon'], { env, encoding: 'utf8', timeout: 20000 });
  assert.notEqual(r.status, 0);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'original\n', 'victim must not be overwritten');
  // symlinked key dir
  const real = path.join(base, 'realkeys'); fs.mkdirSync(real, { mode: 0o700 });
  const link = path.join(base, 'linkkeys'); fs.symlinkSync(real, link);
  const r2 = spawnSync(process.execPath, ['--no-warnings', CLI, 'daemon'], { env: { ...env, G4A_HOME: path.join(base, 'home2'), G4A_KEY_DIR: link }, encoding: 'utf8', timeout: 20000 });
  assert.notEqual(r2.status, 0); assert.match(r2.stderr, /not a real directory/);
  assert.deepEqual(fs.readdirSync(real), []);
  // override.mjs writers: operatorInit / grantOverride
  const { operatorInit, grantOverride } = await import('../src/override.mjs');
  const kd2 = path.join(base, 'k2'); fs.mkdirSync(kd2, { mode: 0o700 });
  fs.symlinkSync(victim, path.join(kd2, 'operator-ed25519.pub.hex'));
  assert.throws(() => operatorInit({ kd: kd2 }));
  assert.equal(fs.readFileSync(victim, 'utf8'), 'original\n');
  assert.throws(() => operatorInit({ kd: link }), /not a real directory/);
  const kd3 = path.join(base, 'k3'); operatorInit({ kd: kd3 });
  const { overrideFile } = await import('../src/override.mjs');
  fs.mkdirSync(path.dirname(overrideFile('/r', kd3)), { mode: 0o700 });
  fs.symlinkSync(victim, overrideFile('/r', kd3));
  assert.throws(() => grantOverride({ repo: '/r', minutes: 1, reason: 'x', kd: kd3 }));
  assert.equal(fs.readFileSync(victim, 'utf8'), 'original\n');
  fs.rmSync(base, { recursive: true, force: true });
});

test('F7: claim paths with control chars, pathspec magic, lookalikes, .git/.g4a are refused; overlap is case-insensitive', () => {
  for (const p of ['a.txt\n--allow-overlap', '\uFF0E\uFF0E/x', ':(top)../x', ':(top)x', '.git/hooks/*', '.g4a/**', 'src/.git/config', '.GIT/x', 'a\tb', 'caf\u00e9.txt'])
    assert.throws(() => checkClaimInputs([p], []), undefined, JSON.stringify(p));
  for (const p of ['a.txt', 'src/**', 'docs/*.md', '.github/workflows/ci.yml']) assert.doesNotThrow(() => checkClaimInputs([p], []), p);
  assert.equal(claimOverlap('A.TXT', 'a.txt'), true);
  assert.equal(claimOverlap('Src/**', 'src/x.js'), true);
  assert.equal(claimOverlap('a.txt', 'b.txt'), false);
});

test('F9: NUL and control characters in MCP arguments get a clean validation error; Node internals are not leaked', async () => {
  for (const args of [{ agent: 'a', paths: ['a\0b'], witnesses: ['true'] }, { agent: 'a', paths: ['a.txt'], witnesses: ['true'], repo: '/tmp/x\0y' }, { agent: 'a', paths: ['a\nb'], witnesses: ['true'] }]) {
    await assert.rejects(callTool('g4a_claim', args), (e) => { assert.equal(e.code, -32602); assert.match(e.message, /control characters/); assert.doesNotMatch(e.message, /args\[\d+\]|null bytes/); return true; });
  }
  const internal = Object.assign(new Error("The argument 'args[6]' must be a string without null bytes"), { code: 'ERR_INVALID_ARG_VALUE' });
  assert.doesNotMatch(publicError(internal), /args\[6\]|null bytes/);
  assert.equal(publicError(Object.assign(new Error('missing agent'), { code: -32602 })), 'missing agent');
});
