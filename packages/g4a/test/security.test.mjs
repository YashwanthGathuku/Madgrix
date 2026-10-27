// Security/privacy: redaction, argv minimisation, private modes, symlink refusal, rotation/retention,
// claim input validation, hook-wrapper quoting, privacy/purge commands. Fake secrets are assembled at
// runtime so the source never contains a token-shaped literal.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { redact, redactDeep, minimiseArgv, ensurePrivateDir, appendPrivate, writePrivate, rotateLog, pruneTee } from '../src/privacy.mjs';
import { appendLog } from '../src/lib.mjs';
import { checkClaimInputs } from '../src/authority.mjs';
import { hookWrapper } from '../src/authority-service.mjs';
import { seedBundle } from '../src/system-install.mjs';

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'g4a.mjs');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'g4a-sec-'));
const mode = (p) => fs.statSync(p).mode & 0o777;
const A = (n, c = 'A') => c.repeat(n);
const FAKE = {
  gh: 'ghp_' + A(36, 'x'), pat: 'github_pat_' + A(40, 'y'), sk: 'sk-' + A(40, 'z'), aws: 'AKIA' + A(16, 'Q'),
  slack: 'xoxb-' + A(20, '1'), jwt: 'eyJ' + A(20, 'a') + '.' + A(20, 'b') + '.' + A(20, 'c'), gcp: 'AIza' + A(35, 'k'),
};

test('redact removes tokens, credential URLs, auth headers, key=value secrets and PEM blocks', () => {
  for (const [k, v] of Object.entries(FAKE)) { const r = redact(`x ${v} y`); assert.ok(!r.includes(v), k); assert.match(r, /\[REDACTED\]/); }
  assert.equal(redact('https://bob:hunter2pass@example.com/r.git'), 'https://bob:[REDACTED]@example.com/r.git');
  assert.ok(!redact(`https://${FAKE.gh}@github.com/o/r`).includes(FAKE.gh));
  assert.ok(!redact('http.extraHeader=Authorization: Bearer abcdefghijklmnopqrstuvwxyz').includes('abcdefghijklmnop'));
  assert.ok(!redact('DB_PASSWORD=s3cr3t-value ok').includes('s3cr3t'));
  const pem = '-----BEGIN ' + 'PRIVATE KEY-----\nMIIabc\n-----END ' + 'PRIVATE KEY-----';
  assert.ok(!redact(pem).includes('MIIabc'));
  // benign text survives
  for (const s of ['git status --short', 'git log --author=alice -5', 'tokens_saved: 120', 'src/auth/login.ts']) assert.equal(redact(s), s);
  // emails only on request
  assert.equal(redact('a@b.co'), 'a@b.co');
  assert.equal(redact('a@b.co', { G4A_REDACT_EMAILS: '1' }), '[EMAIL]');
  assert.deepEqual(redactDeep({ a: [`t ${FAKE.sk}`], n: 3 }), { a: ['t [REDACTED]'], n: 3 });
});

test('minimiseArgv drops commit messages and -c secrets; G4A_LOG_ARGV=0 drops argv', () => {
  assert.deepEqual(minimiseArgv(['commit', '-m', 'secret plan']), ['commit', '-m', '[11 chars]']);
  assert.deepEqual(minimiseArgv(['commit', '--message=hello']), ['commit', '--message=[5 chars]']);
  assert.deepEqual(minimiseArgv(['commit', '-mhi']), ['commit', '-m[2 chars]']);
  const c = minimiseArgv(['-c', 'http.extraHeader=AUTHORIZATION: basic Zm9vOmJhcmJhemJhcg==', 'push']);
  assert.ok(!c.join(' ').includes('Zm9v'));
  assert.ok(!minimiseArgv(['push', `https://${FAKE.gh}@github.com/o/r`]).join(' ').includes(FAKE.gh));
  assert.deepEqual(minimiseArgv(['push', 'origin'], { G4A_LOG_ARGV: '0' }), ['[argv omitted]']);
});

test('private files are 0600 in 0700 dirs even under umask 000, and symlinks are refused', () => {
  const d = tmp(); const old = process.umask(0);
  try {
    const h = ensurePrivateDir(path.join(d, 'home'));
    assert.equal(mode(h), 0o700);
    appendPrivate(path.join(h, 'a'), 'x'); writePrivate(path.join(h, 'b'), 'y');
    assert.equal(mode(path.join(h, 'a')), 0o600); assert.equal(mode(path.join(h, 'b')), 0o600);
    fs.chmodSync(path.join(h, 'a'), 0o644); appendPrivate(path.join(h, 'a'), 'x'); assert.equal(mode(path.join(h, 'a')), 0o600);
    fs.chmodSync(h, 0o755); ensurePrivateDir(h); assert.equal(mode(h), 0o700);
    // symlinked file target: O_NOFOLLOW refuses, victim untouched
    fs.writeFileSync(path.join(d, 'victim'), 'orig'); fs.symlinkSync(path.join(d, 'victim'), path.join(h, 'link'));
    assert.throws(() => appendPrivate(path.join(h, 'link'), 'evil'));
    assert.throws(() => writePrivate(path.join(h, 'link'), 'evil'));
    assert.equal(fs.readFileSync(path.join(d, 'victim'), 'utf8'), 'orig');
    // symlinked home dir refused
    fs.mkdirSync(path.join(d, 'real')); fs.symlinkSync(path.join(d, 'real'), path.join(d, 'lhome'));
    assert.throws(() => ensurePrivateDir(path.join(d, 'lhome')), /not a real directory/);
  } finally { process.umask(old); fs.rmSync(d, { recursive: true, force: true }); }
});

test('appendLog writes a redacted, minimised, 0600 log and rotates at the size cap', () => {
  const d = tmp();
  try {
    const env = { G4A_HOME: path.join(d, 'h'), G4A_LOG_MAX_BYTES: '300', G4A_LOG_KEEP: '2' };
    appendLog({ event: 'git', argv: ['commit', '-m', 'top secret roadmap'], cwd: '/x', note: `leak ${FAKE.gh}` }, env);
    const f = path.join(env.G4A_HOME, 'log.jsonl'); const txt = fs.readFileSync(f, 'utf8');
    assert.ok(!txt.includes('top secret') && !txt.includes(FAKE.gh));
    assert.equal(mode(f), 0o600); assert.equal(mode(env.G4A_HOME), 0o700);
    for (let i = 0; i < 20; i++) appendLog({ event: 'git', argv: ['status'], pad: 'p'.repeat(50) }, env);
    assert.ok(fs.existsSync(`${f}.1`)); assert.ok(!fs.existsSync(`${f}.3`));
    assert.ok(fs.statSync(f).size < 600);
    assert.equal(rotateLog(path.join(d, 'nope')), false);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('pruneTee enforces age and count limits', () => {
  const d = tmp();
  try {
    const now = Date.now();
    for (let i = 0; i < 6; i++) { const p = path.join(d, `${i}.txt`); fs.writeFileSync(p, 'x'); const t = (now - i * 3_600_000) / 1000; fs.utimesSync(p, t, t); }
    const old = path.join(d, 'old.txt'); fs.writeFileSync(old, 'x'); const t = (now - 10 * 86_400_000) / 1000; fs.utimesSync(old, t, t);
    assert.equal(pruneTee(d, { G4A_TEE_MAX_FILES: '4' }, now), 3);
    assert.deepEqual(fs.readdirSync(d).sort(), ['0.txt', '1.txt', '2.txt', '3.txt']);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('claim inputs: traversal/absolute paths and secret-bearing witnesses are refused', () => {
  for (const p of ['../etc', 'a/../../b', '/etc/passwd', '~/x', 'C:\\x', 'a\0b', '']) assert.throws(() => checkClaimInputs([p]), undefined, JSON.stringify(p));
  assert.throws(() => checkClaimInputs(['src/**'], [], ['../w']));
  assert.throws(() => checkClaimInputs(['src/**'], [`curl -H "Authorization: Bearer ${A(30, 'q')}" x`]), /secret/);
  assert.throws(() => checkClaimInputs(['src/**'], [`git clone https://${FAKE.gh}@github.com/o/r`]), /secret/);
  assert.doesNotThrow(() => checkClaimInputs(['src/**', 'docs/a.md'], ['npm test', 'node --test test/x.test.mjs'], ['package.json']));
});

test('hook wrapper single-quotes paths so $() and backticks in a root path do not run', () => {
  const d = tmp();
  try {
    const marker = path.join(d, 'pwned');
    const root = path.join(d, `r$(touch ${marker})\`touch ${marker}\`'q`);
    const f = path.join(d, 'hook');
    hookWrapper(f, 'nonexistent-hook.mjs', { root, pub: path.join(root, 'pub') });
    spawnSync('sh', [f], { encoding: 'utf8' });
    assert.ok(!fs.existsSync(marker), 'shell metacharacters in the path were executed');
    assert.ok(fs.readFileSync(f, 'utf8').includes(`'\\''q`));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('g4a privacy lists stored data with modes; g4a purge removes telemetry only', () => {
  const d = tmp();
  try {
    const env = { ...process.env, G4A_HOME: path.join(d, 'h') }; delete env.CODEX_HOME; delete env.NODE_TEST_CONTEXT;
    appendLog({ event: 'git', argv: ['status'] }, env);
    fs.mkdirSync(path.join(env.G4A_HOME, 'tee'), { mode: 0o700 }); fs.writeFileSync(path.join(env.G4A_HOME, 'tee', '1.txt'), 'x', { mode: 0o600 });
    fs.writeFileSync(path.join(env.G4A_HOME, 'g4a.db'), '', { mode: 0o600 });
    const run = (...a) => spawnSync(process.execPath, ['--no-warnings', BIN, ...a], { env, encoding: 'utf8' });
    const pv = run('privacy'); if (!pv.stdout) throw new Error('privacy: ' + pv.status + ' ' + pv.stderr);
    const p = JSON.parse(pv.stdout);
    assert.ok(p.items.some((i) => i.kind === 'logs' && i.mode === '600'));
    assert.deepEqual(p.warnings, []);
    assert.equal(run('purge').status, 2);
    const pr = run('purge', '--all'); if (!pr.stdout) throw new Error('purge: ' + pr.status + ' ' + pr.stderr);
    const r = JSON.parse(pr.stdout);
    assert.equal(r.removed.length, 2);
    assert.ok(!fs.existsSync(path.join(env.G4A_HOME, 'log.jsonl')) && !fs.existsSync(path.join(env.G4A_HOME, 'tee')));
    assert.ok(fs.existsSync(path.join(env.G4A_HOME, 'g4a.db')), 'purge must keep the daemon db / ledger');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('CLI errors are redacted and carry no stack trace by default', () => {
  const env = { ...process.env, G4A_HOME: tmp() }; delete env.CODEX_HOME; delete env.NODE_TEST_CONTEXT;
  try {
    const r = spawnSync(process.execPath, ['--no-warnings', BIN, 'claim', '--agent', 'a', '--paths', '../x', '--witness', 'true', '--repo', `/nonexistent/${FAKE.gh}`], { env, encoding: 'utf8' });
    assert.ok(!(r.stdout + r.stderr).includes(FAKE.gh));
    assert.ok(!/\n\s+at /.test(r.stderr));
  } finally { fs.rmSync(env.G4A_HOME, { recursive: true, force: true }); }
});

test('system-install seed bundle: 0700 dir, 0600 bundle, removed by cleanup, on error and on exit', () => {
  const d = tmp();
  try {
    const repo = path.join(d, 'r'); fs.mkdirSync(repo);
    const g = (...a) => spawnSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
    g('init', '-q', '-b', 'main'); g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'i');
    const old = process.umask(0);
    let s; try { s = seedBundle(repo, { tmpdir: d }); } finally { process.umask(old); }
    assert.equal(mode(s.dir), 0o700); assert.equal(mode(s.bundle), 0o600);
    assert.equal(fs.statSync(s.bundle).uid, process.getuid());
    assert.equal(spawnSync('git', ['bundle', 'verify', s.bundle], { cwd: repo }).status, 0);
    s.cleanup(); assert.ok(!fs.existsSync(s.dir)); s.cleanup();
    // failure while bundling: nothing left behind
    const before = fs.readdirSync(d).filter((n) => n.startsWith('g4a-seed-')).length;
    assert.throws(() => seedBundle(path.join(d, 'not-a-repo'), { tmpdir: d }));
    assert.equal(fs.readdirSync(d).filter((n) => n.startsWith('g4a-seed-')).length, before);
    // process exit without cleanup(): exit handler removes it
    const mod = new URL('../src/system-install.mjs', import.meta.url).href;
    const r = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', `import { seedBundle } from ${JSON.stringify(mod)}; const s = seedBundle(${JSON.stringify(repo)}, { tmpdir: ${JSON.stringify(d)} }); console.log(s.dir); process.exit(0);`], { encoding: 'utf8' });
    const dir = r.stdout.trim(); assert.ok(dir.startsWith(d), r.stderr); assert.ok(!fs.existsSync(dir), 'seed dir survived process exit');
    // SIGTERM without cleanup(): signal handler removes it
    const r2 = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', `import { seedBundle } from ${JSON.stringify(mod)}; const s = seedBundle(${JSON.stringify(repo)}, { tmpdir: ${JSON.stringify(d)} }); console.log(s.dir); process.kill(process.pid, 'SIGTERM'); setTimeout(() => {}, 5000);`], { encoding: 'utf8' });
    const dir2 = r2.stdout.trim(); assert.equal(r2.signal, 'SIGTERM'); assert.ok(dir2.startsWith(d)); assert.ok(!fs.existsSync(dir2), 'seed dir survived SIGTERM');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
