// The shim honors an agent-context opt-out (G4A_RAW=1) only with an operator override signed by
// the AUTHORITY's operator key (pub/operator.pub.hex) when an authority is attached. Cases:
// valid, tampered, wrong key (incl. a valid key-dir override), expired, other repo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { generateKeyPairSync, createPublicKey } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { signOverride, overrideName, validOverride, overrideFile } from '../src/override.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'g4a.mjs');
const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const pubHex = (k) => createPublicKey(k).export({ type: 'spki', format: 'der' }).toString('hex');
const ov = (repo, minutes, extra = {}) => ({ version: 'g4a-override/v1', repo, vars: ['G4A_RAW'], until: new Date(Date.now() + minutes * 60_000).toISOString(), reason: 't', ...extra });

function setup() {
  const base = tmp('g4a-ov-'), home = path.join(base, 'home'), kd = path.join(base, 'keys'), auth = path.join(base, 'auth'), repo = path.join(base, 'repo');
  const env = { ...process.env, G4A_HOME: home, G4A_KEY_DIR: kd, G4A_SYSTEM_MAP_TEST: path.join(base, 'nomap.json') };
  assert.equal(spawnSync(process.execPath, ['--no-warnings', CLI, 'install'], { env, encoding: 'utf8' }).status, 0);
  fs.mkdirSync(repo); execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo, env: { ...env, G4A_RAW: '1' } });
  execFileSync('git', ['config', 'g4a.authority', auth], { cwd: repo, env: { ...env, G4A_RAW: '1' } });
  const op = generateKeyPairSync('ed25519').privateKey;
  fs.mkdirSync(path.join(auth, 'pub', 'overrides'), { recursive: true });
  fs.writeFileSync(path.join(auth, 'pub', 'operator.pub.hex'), pubHex(op) + '\n');
  const id = fs.realpathSync(path.join(repo, '.git'));
  const agentEnv = { ...env, PATH: `${path.join(home, 'bin')}:${process.env.PATH}`, G4A_AGENT: '1', G4A_RAW: '1' }; delete agentEnv.G4A_ACTIVE; delete agentEnv.G4A_ENFORCE;
  const file = path.join(auth, 'pub', 'overrides', overrideName(id));
  const put = (o) => fs.writeFileSync(file, JSON.stringify(o));
  const ignored = () => /ignoring G4A_RAW/.test(spawnSync('git', ['status', '--short'], { cwd: repo, env: agentEnv, encoding: 'utf8' }).stderr);
  return { base, kd, auth, repo, id, op, file, put, ignored };
}

test('shim: authority-signed override valid / tampered / wrong key / expired / other repo', () => {
  const s = setup();
  try {
    assert.equal(s.ignored(), true, 'no override: ignored');
    s.put(signOverride(ov(s.id, 10), s.op));
    assert.equal(s.ignored(), false, 'valid authority-signed override: honored');
    const t = signOverride(ov(s.id, 10), s.op); t.override.vars = ['G4A_RAW', 'G4A_ENFORCE']; s.put(t);
    assert.equal(s.ignored(), true, 'tampered: ignored');
    const t2 = signOverride(ov(s.id, 10), s.op); t2.override.until = new Date(Date.now() + 9e9).toISOString(); s.put(t2);
    assert.equal(s.ignored(), true, 'tampered expiry: ignored');
    s.put(signOverride(ov(s.id, 10), generateKeyPairSync('ed25519').privateKey));
    assert.equal(s.ignored(), true, 'wrong key: ignored');
    s.put(signOverride(ov(s.id, -1), s.op));
    assert.equal(s.ignored(), true, 'expired: ignored');
    s.put(signOverride(ov('/elsewhere/.git', 10), s.op));
    assert.equal(s.ignored(), true, 'other repo: ignored');
    s.put(signOverride({ ...ov(s.id, 10), vars: ['G4A_ENFORCE'] }, s.op));
    assert.equal(s.ignored(), true, 'other var: ignored');
    // a correctly signed KEY-DIR override (same-user operator key) does not count once an authority is attached
    fs.rmSync(s.file);
    const kop = generateKeyPairSync('ed25519').privateKey;
    fs.mkdirSync(path.join(s.kd, 'overrides'), { recursive: true });
    fs.writeFileSync(path.join(s.kd, 'operator-ed25519.pub.hex'), pubHex(kop) + '\n');
    fs.writeFileSync(overrideFile(s.id, s.kd), JSON.stringify(signOverride(ov(s.id, 10), kop)));
    assert.ok(validOverride(s.id, 'G4A_RAW', s.kd), 'key-dir override itself is valid');
    assert.equal(s.ignored(), true, 'key-dir override ignored when authority attached');
    // garbage file / missing pub key
    fs.writeFileSync(s.file, '{not json'); assert.equal(s.ignored(), true);
    s.put(signOverride(ov(s.id, 10), s.op)); fs.rmSync(path.join(s.auth, 'pub', 'operator.pub.hex'));
    assert.equal(s.ignored(), true, 'missing authority pub key: ignored');
  } finally { fs.rmSync(s.base, { recursive: true, force: true }); }
});

test('validOverride unit: checks signature, repo, var, expiry against the given pub file', () => {
  const d = tmp('g4a-ovu-'); const k = generateKeyPairSync('ed25519').privateKey;
  const pubFile = path.join(d, 'p.hex'), file = path.join(d, 'o.json'); fs.writeFileSync(pubFile, pubHex(k));
  const chk = (o, v = 'G4A_RAW', now = Date.now()) => { fs.writeFileSync(file, JSON.stringify(o)); return validOverride('/r/.git', v, d, now, { pubFile, file }); };
  assert.ok(chk(signOverride(ov('/r/.git', 5), k)));
  assert.equal(chk(signOverride(ov('/r/.git', 5), k), 'G4A_ENFORCE'), null);
  assert.equal(chk(signOverride(ov('/r/.git', 5), k), 'G4A_RAW', Date.now() + 6 * 60_000), null);
  const t = signOverride(ov('/r/.git', 5), k); t.override.reason = 'x'; assert.equal(chk(t), null);
  assert.equal(chk(signOverride(ov('/r/.git', 5), generateKeyPairSync('ed25519').privateKey)), null);
  fs.rmSync(d, { recursive: true, force: true });
});
