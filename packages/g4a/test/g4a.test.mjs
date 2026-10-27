// phase-1 fixtures exercise the test-only local landing path (production promotes via the authority)
process.env.G4A_LOCAL_LAND = '1';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { classify, compactors, stats } from '../src/lib.mjs';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(PKG, 'bin', 'g4a.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'g4a-test-'));
const HOME = path.join(tmp, 'home');
const REPO = path.join(tmp, 'repo');
const baseEnv = { PATH: process.env.PATH, HOME: tmp, G4A_HOME: HOME, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', LC_ALL: 'C' };
const REAL = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
const SHIM = path.join(HOME, 'bin', 'git');
const shimEnv = { ...baseEnv, PATH: `${path.join(HOME, 'bin')}:${process.env.PATH}` };
const agentEnv = { ...shimEnv, G4A_AGENT: '1' };

const run = (cmd, args, env, opts = {}) => spawnSync(cmd, args, { cwd: REPO, env, ...opts });
const real = (args, opts) => run(REAL, args, baseEnv, opts);
const shim = (args, env = agentEnv, opts) => run(SHIM, args, env, opts);
const logRecs = () => fs.existsSync(path.join(HOME, 'log.jsonl')) ? fs.readFileSync(path.join(HOME, 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
const same = (args, opts) => {
  const a = real(args, opts), b = shim(args, agentEnv, opts);
  assert.equal(b.status, a.status, `exit ${args.join(' ')}`);
  assert.ok(Buffer.compare(a.stdout, b.stdout) === 0, `stdout ${args.join(' ')}`);
  assert.ok(Buffer.compare(a.stderr, b.stderr) === 0, `stderr ${args.join(' ')}`);
};

// fixture repo: text + binary files, 60 commits, branches, a dirty tree
fs.mkdirSync(REPO, { recursive: true });
const g = (...a) => execFileSync(REAL, a, { cwd: REPO, env: baseEnv });
g('init', '-q', '-b', 'main');
for (let i = 0; i < 60; i++) { fs.writeFileSync(path.join(REPO, `f${i % 7}.txt`), `line ${i}\n`.repeat(i + 1)); g('add', '.'); g('commit', '-qm', `commit number ${i}`); }
fs.writeFileSync(path.join(REPO, 'bin.dat'), Buffer.from([0, 1, 2, 255, 0, 10, 13]));
g('add', '.'); g('commit', '-qm', 'binary');
fs.writeFileSync(path.join(REPO, 'bin.dat'), Buffer.from([9, 0, 255, 254, 0]));
for (let i = 0; i < 5; i++) g('branch', `feature/${i}`);
fs.writeFileSync(path.join(REPO, 'f1.txt'), 'changed\n');
fs.writeFileSync(path.join(REPO, 'new file.txt'), 'x\n');

test('install writes shim resolving real git (not itself)', () => {
  const r = spawnSync(process.execPath, [CLI, 'install'], { env: shimEnv, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const s = fs.readFileSync(SHIM, 'utf8');
  assert.match(s, /G4A_SHIM_MARKER/);
  assert.equal(s.match(/^G4A_REAL_GIT='(.*)'$/m)[1], fs.realpathSync(REAL));
  // reinstall with shim first on PATH must still resolve the real git (recursion guard)
  spawnSync(process.execPath, [CLI, 'install'], { env: shimEnv });
  assert.equal(fs.readFileSync(SHIM, 'utf8').match(/^G4A_REAL_GIT='(.*)'$/m)[1], fs.realpathSync(REAL));
  const d = spawnSync(process.execPath, [CLI, 'doctor'], { env: shimEnv, encoding: 'utf8' });
  assert.equal(d.status, 0, d.stdout);
});

test('classify: only safe read commands are compactable', () => {
  const t = { status: ['status'], log: ['log'], stat: ['diff', '--stat'], branch: ['branch', '-a'], netnoise: ['fetch'] };
  for (const [k, a] of Object.entries(t)) assert.equal(classify(a), k, a.join(' '));
  assert.equal(classify(['log', '-n', '5']), 'log');
  for (const a of [['status', '--porcelain'], ['status', '-z'], ['status', '-s'], ['status', '--short'], ['log', '--format=%H'], ['log', '--pretty=oneline'], ['log', '-p'], ['log', '-z'], ['diff'], ['diff', '--stat', '--numstat'], ['show'], ['branch', 'x'], ['branch', '-D', 'x'], ['branch', '--format=%(refname)'], ['rev-parse', 'HEAD'], ['ls-files', '-z'], ['cat-file', '-p', 'HEAD'], ['for-each-ref'], ['push', '--porcelain'], ['commit', '-m', 'x'], ['-x'], []])
    assert.equal(classify(a), null, a.join(' '));
});

test('pass-through: porcelain, -z, --format, plumbing are byte-identical', () => {
  same(['status', '--porcelain']); same(['status', '--porcelain=v2', '-z']); same(['status', '-s']);
  same(['ls-files', '-z']); same(['log', '--format=%H %s']); same(['log', '-z', '--pretty=raw']);
  same(['for-each-ref']); same(['cat-file', '-p', 'HEAD']); same(['rev-parse', 'HEAD']);
  same(['branch', '--format=%(refname)']); same(['diff', '--numstat']);
});

test('pass-through: binary diffs identical', () => {
  same(['diff', '--binary']); same(['diff']); same(['show', 'HEAD', '--binary']);
});

test('pass-through: exit codes and stderr exact', () => {
  same(['rev-parse', '--verify', 'does-not-exist']);
  same(['diff', '--exit-code']);
  same(['not-a-command']);
  same(['log', 'no-such-ref']); // compactable kind, but failure => raw
  same(['checkout', 'no-such-branch']);
});

test('pass-through: stdin reaches git', () => {
  const opts = { input: 'hello g4a\n' };
  same(['hash-object', '--stdin'], opts);
});

test('signals: SIGTERM to the wrapper terminates git and reports the signal', () => {
  const fake = path.join(tmp, 'fakegit.sh');
  fs.writeFileSync(fake, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
  const r = spawnSync(process.execPath, [path.join(PKG, 'src', 'shim.mjs'), 'gc'], { env: { ...agentEnv, G4A_REAL_GIT: fake }, timeout: 1000, killSignal: 'SIGTERM' });
  assert.equal(r.signal, 'SIGTERM');
});

test('exit code of real git is preserved exactly (fake git exit 42)', () => {
  const fake = path.join(tmp, 'fake42.sh');
  fs.writeFileSync(fake, '#!/bin/sh\necho out; echo err >&2; exit 42\n', { mode: 0o755 });
  for (const a of [['gc'], ['status']]) {
    const r = spawnSync(process.execPath, [path.join(PKG, 'src', 'shim.mjs'), ...a], { env: { ...agentEnv, G4A_REAL_GIT: fake }, encoding: 'utf8' });
    assert.equal(r.status, 42); assert.equal(r.stdout, 'out\n'); assert.equal(r.stderr, 'err\n');
  }
});

test('no recursion: git calling git through the shim terminates', () => {
  const r = shim(['-c', 'alias.st=!git status --porcelain', 'st'], agentEnv, { timeout: 10000 });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.toString(), real(['status', '--porcelain']).stdout.toString());
});

test('humans untouched: no agent marker => exact output even when piped', () => {
  const a = real(['status']), b = shim(['status'], shimEnv);
  assert.equal(Buffer.compare(a.stdout, b.stdout), 0);
});

test('TTY: agent marker + terminal => still routed through the node shim (enforced), but output is not compacted', { skip: !fs.existsSync('/usr/bin/script') }, () => {
  const before = logRecs().length;
  const r = spawnSync('script', ['-qec', `${SHIM} status`, '/dev/null'], { cwd: REPO, env: agentEnv, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /On branch main/);
  const recs = logRecs().slice(before);
  assert.equal(recs.length, 1); assert.equal(recs[0].mode, 'passthrough'); // a TTY is no longer a bypass for agents
});

test('G4A_RAW=1: honored for humans, IGNORED (and logged) for agents without an operator override', () => {
  const a = real(['status']);
  const human = shim(['status'], { ...shimEnv, G4A_RAW: '1' });
  assert.equal(Buffer.compare(a.stdout, human.stdout), 0);
  const before = logRecs().length;
  const ag = shim(['status'], { ...agentEnv, G4A_RAW: '1' });
  assert.match(ag.stderr.toString(), /ignoring G4A_RAW in an agent context/);
  assert.equal(ag.stdout.toString(), real(['status', '--porcelain=v1', '-b']).stdout.toString()); // still compacted
  assert.ok(logRecs().slice(before).some((r) => r.event === 'opt_out' && r.vars.includes('G4A_RAW') && r.honored === false));
  // the old G4A_ACTIVE recursion guard is no longer an escape hatch either
  const act = shim(['status'], { ...agentEnv, G4A_ACTIVE: '1' });
  assert.equal(act.stdout.toString(), real(['status', '--porcelain=v1', '-b']).stdout.toString());
});

test('compaction: status == porcelain v1 -b, log capped with tee, stat bars dropped', () => {
  const s = shim(['status']);
  assert.equal(s.status, 0);
  assert.equal(s.stdout.toString(), real(['status', '--porcelain=v1', '-b']).stdout.toString());
  const l = shim(['log']).stdout.toString().trim().split('\n');
  assert.equal(l.length, 51);
  const tee = l[50].match(/full output: (\S+)/)[1];
  assert.equal(fs.readFileSync(tee, 'utf8'), real(['log']).stdout.toString());
  assert.match(l[0], /^[0-9a-f]{7,} binary \(t, /);
  assert.equal(shim(['log', '-n', '3']).stdout.toString().trim().split('\n').length, 3);
  const st = shim(['diff', '--stat']).stdout.toString();
  assert.doesNotMatch(st, /\| +\d+ [+-]/);
  assert.match(st, /f1\.txt \| \d+/);
  assert.match(st, /files? changed/);
  const recs = logRecs().filter((r) => r.mode === 'compact');
  assert.ok(recs.length >= 3);
  for (const r of recs) assert.ok(r.bytesAfter < r.bytesBefore && r.tokensBefore === Math.ceil(r.bytesBefore / 4));
});

test('compactors unit: netnoise strips progress lines only', () => {
  const r = compactors.netnoise({ raw: { stdout: '', stderr: 'Enumerating objects: 5, done.\nremote: Resolving deltas: 100% (1/1)\nTo github.com:x/y\n   abc..def  main -> main\n' } });
  assert.equal(r.stderr, 'To github.com:x/y\n   abc..def  main -> main\n');
});

test('stats aggregates the log', () => {
  const r = spawnSync(process.execPath, [CLI, 'stats'], { env: shimEnv, encoding: 'utf8' });
  assert.equal(r.status, 0); assert.match(r.stdout, /TOTAL/);
  const s = stats([{ event: 'git', sub: 'status', mode: 'compact', bytesBefore: 100, bytesAfter: 20 }, { event: 'git', sub: 'status', mode: 'passthrough' }]);
  assert.deepEqual(s.by.status, { calls: 2, compacted: 1, bytesBefore: 100, bytesAfter: 20 });
});

test('hooks: generated configs and hook is silent (exit 0, no stdout)', () => {
  for (const a of ['claude', 'codex', 'gemini']) {
    const r = spawnSync(process.execPath, [CLI, 'hooks', a], { encoding: 'utf8', env: shimEnv });
    assert.equal(r.status, 0); JSON.parse(r.stdout);
  }
  const h = spawnSync(process.execPath, [CLI, 'hook', 'claude'], { env: shimEnv, input: JSON.stringify({ session_id: 's1', tool_name: 'Bash', tool_input: { command: 'git status' } }), encoding: 'utf8' });
  assert.equal(h.status, 0); assert.equal(h.stdout, '');
  assert.ok(logRecs().some((r) => r.event === 'hook' && r.session === 's1'));
});

test('uninstall restores rc files byte-for-byte and removes the shim', () => {
  for (const orig of ['export A=1\n', 'no-trailing-newline', '']) {
    const rc = path.join(tmp, 'rc');
    fs.writeFileSync(rc, orig);
    assert.equal(spawnSync(process.execPath, [CLI, 'install', '--rc', rc], { env: shimEnv }).status, 0);
    assert.match(fs.readFileSync(rc, 'utf8'), /g4a >>>/);
    assert.equal(spawnSync(process.execPath, [CLI, 'uninstall', '--rc', rc], { env: shimEnv }).status, 0);
    assert.equal(fs.readFileSync(rc, 'utf8'), orig);
    assert.equal(fs.existsSync(SHIM), false);
  }
});
