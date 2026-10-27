// Operator overrides: the only way an agent context may opt out of enforcement
// (G4A_ENFORCE=0) or of the shim (G4A_RAW=1). An override is a time-limited file signed with
// a separate operator key that lives in the key dir and is created only from a human context
// (no agent marker, interactive TTY). Limit: an agent running as the same uid can read that key
// unless it is passphrase-protected (`--passphrase-file`), and even then a same-uid process
// can wait for a human to type it; see README "same-uid".
import fs from 'node:fs';
import path from 'node:path';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { canonicalJson } from '../../../src/lib/canonical.ts';
import { keyDir } from './lib.mjs';
import { ensurePrivateDir, writePrivate } from './privacy.mjs';

export const OPT_OUT_VARS = ['G4A_ENFORCE', 'G4A_RAW', 'G4A_AGENT'];
const opFile = (kd) => path.join(kd, 'operator-ed25519.pem');
const opPub = (kd) => path.join(kd, 'operator-ed25519.pub.hex');
export const overrideFile = (repo, kd = keyDir()) => path.join(kd, 'overrides', `${createHash('sha256').update(repo).digest('hex').slice(0, 32)}.json`);

export function operatorInit({ kd = keyDir(), passphrase } = {}) {
  ensurePrivateDir(kd); // refuses a symlinked or foreign-owned key dir
  if (fs.existsSync(opFile(kd))) return { ok: true, existed: true, pub: fs.readFileSync(opPub(kd), 'utf8').trim() };
  const { privateKey } = generateKeyPairSync('ed25519');
  writePrivate(opFile(kd), privateKey.export({ type: 'pkcs8', format: 'pem', ...(passphrase ? { cipher: 'aes-256-cbc', passphrase } : {}) }));
  const pub = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('hex');
  writePrivate(opPub(kd), pub + '\n', 0o644); // O_NOFOLLOW
  return { ok: true, pub };
}

export function signOverride(override, key) { return { override, signature: sign(null, Buffer.from(canonicalJson(override)), key).toString('base64') }; }
export const overrideName = (repo) => `${createHash('sha256').update(repo).digest('hex').slice(0, 32)}.json`;
export function grantOverride({ repo, minutes, reason, vars = OPT_OUT_VARS, kd = keyDir(), passphrase }) {
  const pem = fs.readFileSync(opFile(kd), 'utf8');
  const key = createPrivateKey(pem.includes('ENCRYPTED') ? { key: pem, passphrase } : pem);
  const override = { version: 'g4a-override/v1', repo, vars, until: new Date(Date.now() + minutes * 60_000).toISOString(), reason: String(reason || '') };
  const signature = sign(null, Buffer.from(canonicalJson(override)), key).toString('base64');
  const f = overrideFile(repo, kd);
  ensurePrivateDir(kd); ensurePrivateDir(path.dirname(f));
  writePrivate(f, JSON.stringify({ override, signature }, null, 2) + '\n');
  return { ok: true, file: f, override };
}

// null when there is no valid, unexpired, correctly signed override covering `v` for `repo`
// Same-user fallback reads the key-dir files; when an authority is attached the shim passes the
// authority's public dir (operator.pub.hex + overrides/), which agents cannot write in --system mode.
export function validOverride(repo, v, kd = keyDir(), now = Date.now(), { pubFile = opPub(kd), file = overrideFile(repo, kd) } = {}) {
  try {
    const { override, signature } = JSON.parse(fs.readFileSync(file, 'utf8'));
    const pub = createPublicKey({ key: Buffer.from(fs.readFileSync(pubFile, 'utf8').trim(), 'hex'), format: 'der', type: 'spki' });
    if (!verify(null, Buffer.from(canonicalJson(override)), pub, Buffer.from(signature, 'base64'))) return null;
    if (override.repo !== repo || !override.vars.includes(v) || Date.parse(override.until) < now) return null;
    return override;
  } catch { return null; }
}
