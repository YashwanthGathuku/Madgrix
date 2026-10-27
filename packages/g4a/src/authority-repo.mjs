// Phase 2: a local bare "authority" repo. Its pre-receive hook (hooks/pre-receive.mjs) accepts
// a ref update only with a daemon-signed permit in a push option (`-o permit=<b64>`):
//   agent permit: refs/heads/agents/<agent>, the diff from the baseline must stay inside the claim paths
//   main permit:  refs/heads/main, the exact old->new values, and a one-time nonce
// Deletes, other refs, forged/expired/replayed permits are refused. The hook is server side, so
// it applies however the client git was invoked (shim, /usr/bin/git, GIT_CONFIG_PARAMETERS).
// Limits (same uid): a process can still write the bare repo's refs/objects directly or run
// `git push --receive-pack='git -c core.hooksPath=/dev/null receive-pack'`; that is detected
// by auditAuthority (refs vs the hook's accepted log), not prevented. Prevention needs the
// authority under another uid/host (ssh forced command).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { safeGit } from '../../../scripts/lib/safe-git.mjs';
import { canonicalJson } from '../../../src/lib/canonical.ts';
import { keyDir } from './lib.mjs';
import { combine, runWitnesses } from './promote.mjs';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'pre-receive.mjs');
const permKey = (kd) => path.join(kd, 'permit-ed25519.pem');
export const ZERO = '0'.repeat(40);
const g4aDir = (dir) => path.join(dir, 'g4a');

function permitKey(kd) {
  fs.mkdirSync(kd, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(permKey(kd))) {
    const { privateKey } = generateKeyPairSync('ed25519');
    fs.writeFileSync(permKey(kd), privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  }
  return createPrivateKey(fs.readFileSync(permKey(kd), 'utf8'));
}
export function permitPub(kd = keyDir()) { return createPublicKey(permitKey(kd)).export({ type: 'spki', format: 'der' }).toString('hex'); }

export function initAuthority({ dir, seedRepo, kd = keyDir() }) {
  dir = path.resolve(dir);
  if (!fs.existsSync(path.join(dir, 'HEAD'))) safeGit(os.tmpdir(), ['init', '--quiet', '--bare', '-b', 'main', dir]);
  const g = g4aDir(dir);
  for (const d of ['hooks', 'nonces']) fs.mkdirSync(path.join(g, d), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(g, 'permit.pub.hex'), permitPub(kd) + '\n');
  if (!fs.existsSync(path.join(g, 'revoked.json'))) fs.writeFileSync(path.join(g, 'revoked.json'), '[]\n');
  const hook = path.join(g, 'hooks', 'pre-receive');
  fs.writeFileSync(hook, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} --no-warnings ${JSON.stringify(HOOK)}\n`, { mode: 0o755 });
  for (const [k, v] of [['core.hooksPath', path.join(g, 'hooks')], ['receive.advertisePushOptions', 'true'], ['receive.denyDeletes', 'true'], ['receive.denyNonFastForwards', 'true']])
    safeGit(dir, ['config', k, v]);
  if (seedRepo && !safeGit(dir, ['rev-parse', '--verify', '-q', 'refs/heads/main'], { allowFailure: true }).stdout.trim()) {
    // seed: fetch (no receive hook) main once at bootstrap, (bootstrap only), recorded as accepted
    const sha = safeGit(seedRepo, ['rev-parse', 'main']).stdout.trim();
    safeGit(dir, ['-c', 'protocol.file.allow=always', 'fetch', '--quiet', path.resolve(seedRepo), `${sha}:refs/heads/main`]);
    fs.appendFileSync(path.join(g, 'accepted.jsonl'), JSON.stringify({ ref: 'refs/heads/main', old: ZERO, new: sha, kind: 'seed', at: new Date().toISOString() }) + '\n');
  }
  return { ok: true, dir, hook };
}

// Daemon-side: sign a permit. Every permit carries a fresh nonce and a short expiry.
export function signPermit(fields, { kd = keyDir(), ttlMs = 120_000 } = {}) {
  const permit = { version: 'g4a-permit/v1', ...fields, nonce: randomBytes(16).toString('hex'), exp: new Date(Date.now() + ttlMs).toISOString() };
  const signature = sign(null, Buffer.from(canonicalJson(permit)), permitKey(kd)).toString('base64');
  return Buffer.from(JSON.stringify({ permit, signature })).toString('base64');
}
export const agentPermit = ({ agent, claim, paths, baseline }, o) => signPermit({ kind: 'agent', agent, claim, ref: `refs/heads/agents/${agent}`, paths, baseline }, o);
export const mainPermit = ({ old, new: nu }, o) => signPermit({ kind: 'main', ref: 'refs/heads/main', old, new: nu }, o);

export function revokeClaim(dir, claim) {
  const f = path.join(g4aDir(dir), 'revoked.json');
  const s = new Set(JSON.parse(fs.readFileSync(f, 'utf8'))); s.add(claim);
  fs.writeFileSync(f, JSON.stringify([...s]) + '\n');
}

// push `src:ref` to the authority with a permit (any git binary; enforcement is the hook)
export function pushWithPermit(repo, dir, src, ref, permit, { gitBin = 'git' } = {}) {
  const args = ['-c', 'protocol.file.allow=always', 'push', '--porcelain', ...(permit ? ['-o', `permit=${permit}`] : []), dir, `${src}:${ref}`];
  return safeGit(repo, args, { allowFailure: true });
}

// Authority-side ladder: combine (fast-forward / merge-tree / mergiraf / union) the agent ref
// with main inside the authority, run witnesses there, then land main through the hook.
export async function landAgent({ dir, agent, witnesses = [], kd = keyDir() }) {
  const ref = `refs/heads/agents/${agent}`;
  const main = safeGit(dir, ['rev-parse', 'refs/heads/main']).stdout.trim();
  const cand = safeGit(dir, ['rev-parse', ref]).stdout.trim();
  const log = [];
  const c = combine(dir, main, cand, agent, log);
  if (!c.sha) return { ok: false, verdict: c.review ? 'REVIEW' : 'CONFLICT', capsule: c.review ?? c.conflict, log };
  const w = witnesses.length ? await runWitnesses(dir, c.sha, witnesses.map((cmd) => ({ cmd, agents: [agent] }))) : [];
  if (w.some((x) => x.exit !== 0)) return { ok: false, verdict: 'REJECT', witnesses: w, log };
  const r = pushWithPermit(dir, dir, c.sha, 'refs/heads/main', mainPermit({ old: main, new: c.sha }, { kd }));
  return { ok: r.status === 0, verdict: r.status === 0 ? 'PROMOTED' : 'PUSH_REFUSED', rung: c.rung, sha: c.sha, witnesses: w, stderr: r.stderr, log };
}

// Detect ref writes that bypassed the hook: every ref's value must be the last accepted value.
export function auditAuthority(dir) {
  const acc = new Map();
  const f = path.join(g4aDir(dir), 'accepted.jsonl');
  if (fs.existsSync(f)) for (const l of fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)) { const e = JSON.parse(l); acc.set(e.ref, e.new); }
  const refs = safeGit(dir, ['for-each-ref', '--format=%(refname) %(objectname)']).stdout.split('\n').filter(Boolean).map((l) => l.split(' '));
  const bad = [];
  for (const [r, sha] of refs) if (acc.get(r) !== sha) bad.push({ ref: r, sha, accepted: acc.get(r) ?? null });
  for (const [r, sha] of acc) if (sha !== ZERO && !refs.some(([x]) => x === r)) bad.push({ ref: r, sha: null, accepted: sha });
  return { ok: bad.length === 0, external: bad };
}
