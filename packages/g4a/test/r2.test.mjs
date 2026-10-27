// Regression tests for the round-2 red-team review (REDTEAM-R2.md N1-N5 and the local content
// scope checks). Each replays the report's repro and asserts it is closed. Fixtures live in tmp.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { minimiseArgv, ensurePrivateDir, writePrivate, appendPrivate } from '../src/privacy.mjs';
import { configKeys, parseConfigParameters } from '../src/lib.mjs';
import { checkClaimInputs } from '../src/authority.mjs';

const ck = (v) => configKeys({ config: [], configEnv: [] }, { GIT_CONFIG_PARAMETERS: v });
const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(PKG, 'bin', 'g4a.mjs');
const SHIM = path.join(PKG, 'src', 'shim.mjs');
const REAL = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
const ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const cleanEnv = () => { const e = { ...process.env, ...ID }; for (const k of ['NODE_TEST_CONTEXT', 'CODEX_HOME', 'G4A_RAW', 'G4A_ENFORCE', 'G4A_ACTIVE', 'G4A_AGENT', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CONFIG_PARAMETERS']) delete e[k]; return e; };
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
const shim = (home, cwd, args, extra = {}) => spawnSync(process.execPath, ['--no-warnings', SHIM, ...args], { cwd, encoding: 'utf8', env: { ...cleanEnv(), ...H(home), CLAUDECODE: '1', G4A_REAL_GIT: REAL, ...extra } });

async function setup() {
  const home = tmp('g4a-r2-home-'); const repo = tmp('g4a-r2-repo-');
  git(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n'); fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base');
  // a side branch touching out-of-claim b.txt
  git(repo, 'checkout', '-q', '-b', 'side'); fs.writeFileSync(path.join(repo, 'b.txt'), 'side\n'); git(repo, 'commit', '-qam', 'side b');
  git(repo, 'checkout', '-q', '--detach', 'main');
  const d = await startDaemon(home);
  const c = await rpc(home, 'claim', { repo, agent: 'a1', paths: ['a.txt'], witnesses: ['true'] });
  assert.equal(c.ok, true, JSON.stringify(c));
  return { home, repo, d, W: c.worktree, done: async () => { await stop(d); for (const p of [home, `${home}-keys`, repo]) fs.rmSync(p, { recursive: true, force: true }); } };
}

test('N1: GIT_CONFIG_PARAMETERS legacy and quoted forms are parsed; unparsable values fail closed', async () => {
  assert.ok(ck("'core.hooksPath=/dev/null'").includes('core.hookspath'));
  assert.ok(ck("'core.hooksPath'='/dev/null'").map((k) => k.toLowerCase()).includes('core.hookspath'));
  assert.ok(ck("'x.y=a'\\''b' 'core.hooksPath=/dev/null'").map((k) => k.toLowerCase()).includes('core.hookspath'));
  assert.equal(parseConfigParameters('core.hooksPath=/dev/null'), null);
  assert.equal(parseConfigParameters("'unterminated"), null);
  const s = await setup();
  try {
    const m0 = git(s.repo, 'rev-parse', 'main'); const side = git(s.repo, 'rev-parse', 'side');
    for (const v of ["'core.hooksPath=/dev/null'", "'core.hooksPath'='/dev/null'", 'core.hooksPath=/dev/null', "'junk"]) {
      const r = shim(s.home, s.W, ['fetch', '-q', '.', `${side}:refs/heads/main`], { GIT_CONFIG_PARAMETERS: v });
      assert.equal(r.status, 1, v + r.stderr); assert.match(r.stderr, /blocked/);
      assert.equal(git(s.repo, 'rev-parse', 'main'), m0, `main must not move (${v})`);
    }
    // a harmless parameter still works
    assert.equal(shim(s.home, s.W, ['status', '-s'], { GIT_CONFIG_PARAMETERS: "'color.ui=never'" }).status, 0);
  } finally { await s.done(); }
});

test('N2: shell (!) aliases are refused for agents in a managed repo', async () => {
  const s = await setup();
  try {
    git(s.repo, 'config', 'alias.sh', '!git commit -qm x');
    fs.writeFileSync(path.join(s.W, 'b.txt'), 'X\n'); git(s.W, 'add', 'b.txt');
    const head = git(s.W, 'rev-parse', 'HEAD');
    const r = shim(s.home, s.W, ['sh']);
    assert.equal(r.status, 1, r.stderr); assert.match(r.stderr, /shell alias/);
    assert.equal(git(s.W, 'rev-parse', 'HEAD'), head);
  } finally { await s.done(); }
});

test('N3: --trailer values are minimised', () => {
  for (const a of [['commit', '--trailer', 'Signed-off-by: Secret Person <s@x>', '-m', 'x'], ['commit', '--trailer=Token: hunter2xyz', '-m', 'x'], ['interpret-trailers', '--trailer', 'Token: hunter2xyz']]) {
    const m = JSON.stringify(minimiseArgv(a));
    assert.ok(!/Secret Person|hunter2xyz/.test(m), m);
  }
});

test('N4: mysql -pX, sshpass -p, curl -b and glued -Hname: witnesses are refused', () => {
  const pw = ['Hun', 'ter2pw'].join('');
  for (const w of [`mysql -p${pw} -e 'select 1'`, `mysql --password=${pw}`, `mysqldump -p${pw} db`, `sshpass -p ${pw} ssh h true`, `curl -b sid=${pw} https://e`, `curl --cookie-jar j https://e`, `curl -Huser:${pw} https://e`, `curl -H "X-Secret: ${pw}" https://e`])
    assert.throws(() => checkClaimInputs(['a.txt'], [w]), /credential|secret/, w);
  for (const w of ['curl -H "Accept: application/json" https://e', 'ssh -p22 h true', 'git checkout -b x', 'mkdir -p out', 'npm test'])
    assert.doesNotThrow(() => checkClaimInputs(['a.txt'], [w]), w);
});

test('N5: a symlinked parent of the key dir and hardlinked private files are refused', () => {
  const base = tmp('g4a-r2-n5-');
  try {
    const real = path.join(base, 'real'); fs.mkdirSync(real, { mode: 0o700 });
    const link = path.join(base, 'link'); fs.symlinkSync(real, link);
    assert.throws(() => ensurePrivateDir(path.join(link, 'keys')), /symlink|real directory/);
    assert.deepEqual(fs.readdirSync(real), []);
    const kd = path.join(base, 'kd'); ensurePrivateDir(kd);
    const victim = path.join(base, 'victim'); fs.writeFileSync(victim, 'original\n', { mode: 0o600 });
    fs.linkSync(victim, path.join(kd, 'k.hex')); fs.linkSync(victim, path.join(kd, 'l.jsonl'));
    assert.throws(() => writePrivate(path.join(kd, 'k.hex'), 'x'), /link/);
    assert.throws(() => appendPrivate(path.join(kd, 'l.jsonl'), 'x'), /link/);
    assert.equal(fs.readFileSync(victim, 'utf8'), 'original\n');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('local content scope: cherry-pick/merge/am/reset/rebase/pull of out-of-claim content are blocked; in-claim passes', async () => {
  const s = await setup();
  try {
    const W = s.W; const head = git(W, 'rev-parse', 'HEAD');
    const blocked = (args, re = /outside claim/) => { const r = shim(s.home, W, args); assert.equal(r.status, 1, `${args.join(' ')}: ${r.stderr}`); assert.match(r.stderr, re); assert.equal(git(W, 'rev-parse', 'HEAD'), head, args.join(' ')); };
    blocked(['cherry-pick', 'side']);
    blocked(['cherry-pick', 'main..side']);
    blocked(['merge', '-q', '--no-edit', 'side']);
    blocked(['reset', '-q', '--hard', 'side']);
    blocked(['rebase', '-q', 'side']);
    blocked(['rebase', '-q', '--onto', 'side', 'HEAD']);
    blocked(['pull', '-q', '.', 'side'], /pull cannot be scope-checked/);
    const patch = path.join(os.tmpdir(), `g4a-r2-${process.pid}.patch`);
    fs.writeFileSync(patch, git(s.repo, 'format-patch', '-1', '--stdout', 'side') + '\n');
    try { blocked(['am', patch]); } finally { fs.rmSync(patch, { force: true }); }
    // in-claim: a commit on a.txt can be cherry-picked; reset back to the claim base passes
    git(s.repo, 'checkout', '-q', '-b', 'ina', 'main'); fs.writeFileSync(path.join(s.repo, 'a.txt'), 'in\n'); git(s.repo, 'commit', '-qam', 'a'); git(s.repo, 'checkout', '-q', '--detach', 'main');
    const ok = shim(s.home, W, ['cherry-pick', 'ina']); assert.equal(ok.status, 0, ok.stderr);
    const ok2 = shim(s.home, W, ['reset', '-q', '--hard', head]); assert.equal(ok2.status, 0, ok2.stderr);
    assert.equal(shim(s.home, W, ['reset', '-q', 'a.txt']).status, 0);
  } finally { await s.done(); }
});
