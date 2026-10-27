// Authority pre-receive hook (cwd = bare authority repo). See src/authority-repo.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createPublicKey, verify } from 'node:crypto';
import { canonicalJson } from '../../../src/lib/canonical.ts';
import { globMatchesPath } from '../../../src/lib/claims.ts';

const ZERO = '0'.repeat(40);
const dir = process.cwd();
const g = path.join(dir, 'g4a');
const die = (m) => { process.stderr.write(`[g4a-authority] refused: ${m}\n`); process.exit(1); };
const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });

const updates = fs.readFileSync(0, 'utf8').split('\n').filter(Boolean).map((l) => { const [old, nu, ref] = l.split(' '); return { old, new: nu, ref }; });
const opts = Array.from({ length: Number(process.env.GIT_PUSH_OPTION_COUNT || 0) }, (_, i) => process.env[`GIT_PUSH_OPTION_${i}`]);
const raw = opts.find((o) => o?.startsWith('permit='));
if (!raw) die('no permit (push with -o permit=<daemon-signed permit>)');
let env;
try { env = JSON.parse(Buffer.from(raw.slice(7), 'base64').toString('utf8')); } catch { die('malformed permit'); }
const { permit, signature } = env ?? {};
const pub = createPublicKey({ key: Buffer.from(fs.readFileSync(path.join(g, 'permit.pub.hex'), 'utf8').trim(), 'hex'), format: 'der', type: 'spki' });
let okSig = false;
try { okSig = !!permit && verify(null, Buffer.from(canonicalJson(permit)), pub, Buffer.from(String(signature), 'base64')); } catch {}
if (!okSig) die('permit signature invalid');
if (permit.version !== 'g4a-permit/v1' || !/^[0-9a-f]{32}$/.test(permit.nonce || '')) die('permit malformed');
if (!(Date.parse(permit.exp) > Date.now())) die('permit expired');
if (updates.length !== 1) die('exactly one ref update per permit');
const u = updates[0];
if (u.new === ZERO) die('ref deletes are not allowed');
if (u.ref !== permit.ref) die(`permit is for ${permit.ref}, not ${u.ref}`);
if (permit.kind === 'main') {
  if (u.ref !== 'refs/heads/main' || u.old !== permit.old || u.new !== permit.new) die('main permit does not match old/new');
} else if (permit.kind === 'agent') {
  if (!/^[A-Za-z0-9._-]+$/.test(permit.agent) || u.ref !== `refs/heads/agents/${permit.agent}`) die('agent ref mismatch');
  if (JSON.parse(fs.readFileSync(path.join(g, 'revoked.json'), 'utf8')).includes(permit.claim)) die('claim revoked');
  if (git('merge-base', '--is-ancestor', permit.baseline, u.new).status !== 0) die('push does not descend from the claim baseline');
  const files = git('diff', '--name-only', '-z', permit.baseline, u.new).stdout.split('\0').filter(Boolean);
  const out = files.filter((f) => !permit.paths.some((p) => globMatchesPath(p, f)));
  if (out.length) die(`out-of-claim paths: ${out.slice(0, 5).join(', ')}`);
} else die('unknown permit kind');
// one-time nonce (replay protection), consumed atomically
try { fs.writeFileSync(path.join(g, 'nonces', permit.nonce), u.new, { flag: 'wx' }); } catch { die('permit already used (replay)'); }
fs.appendFileSync(path.join(g, 'accepted.jsonl'), JSON.stringify({ ref: u.ref, old: u.old, new: u.new, kind: permit.kind, agent: permit.agent ?? null, nonce: permit.nonce, at: new Date().toISOString() }) + '\n');
