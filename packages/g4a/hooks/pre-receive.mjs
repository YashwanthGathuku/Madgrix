// Authority repo pre-receive (args: root pub). Accepts exactly one update of
// refs/heads/agents/<agent> per push, carrying `-o permit=<b64>`: an authority-signed, one-time,
// short-lived permit for an ACTIVE authority claim, descending from the claim baseline, with every
// changed path inside the claim globs. Everything else (main, deletes, other refs) is refused:
// main only moves through the authority-side ladder (`land`).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createPublicKey, verify } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { canonicalJson } from '../../../src/lib/canonical.ts';
import { globMatchesPath } from '../../../src/lib/claims.ts';

const [root, pub] = process.argv.slice(2);
const ZERO = '0'.repeat(40);
const die = (m) => { process.stderr.write(`[g4a-authority] refused: ${m}\n`); process.exit(1); };
const git = (...a) => spawnSync('git', a, { cwd: path.join(root, 'repo'), encoding: 'utf8', env: { PATH: process.env.PATH, GIT_DIR: path.join(root, 'repo', '.git'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...(process.env.GIT_QUARANTINE_PATH ? { GIT_OBJECT_DIRECTORY: process.env.GIT_OBJECT_DIRECTORY, GIT_ALTERNATE_OBJECT_DIRECTORIES: process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES } : {}) } });

const updates = fs.readFileSync(0, 'utf8').split('\n').filter(Boolean).map((l) => { const [old, nu, ref] = l.split(' '); return { old, new: nu, ref }; });
const opts = Array.from({ length: Number(process.env.GIT_PUSH_OPTION_COUNT || 0) }, (_, i) => process.env[`GIT_PUSH_OPTION_${i}`]);
const raw = opts.find((o) => o?.startsWith('permit='));
if (updates.some((u) => u.ref === 'refs/heads/main')) die('main only moves through the authority ladder (g4a promote)');
if (!raw) die('no permit (push with -o permit=<authority-signed permit>)');
let env;
try { env = JSON.parse(Buffer.from(raw.slice(7), 'base64').toString('utf8')); } catch { die('malformed permit'); }
const { permit, signature } = env ?? {};
const key = createPublicKey({ key: Buffer.from(fs.readFileSync(path.join(pub, 'permit.pub.hex'), 'utf8').trim(), 'hex'), format: 'der', type: 'spki' });
let okSig = false;
try { okSig = !!permit && verify(null, Buffer.from(canonicalJson(permit)), key, Buffer.from(String(signature), 'base64')); } catch {}
if (!okSig) die('permit signature invalid');
if (permit.version !== 'g4a-permit/v1' || permit.kind !== 'agent' || !/^[0-9a-f]{32}$/.test(permit.nonce || '')) die('permit malformed');
if (!(Date.parse(permit.exp) > Date.now())) die('permit expired');
if (updates.length !== 1) die('exactly one ref update per permit');
const u = updates[0];
if (u.new === ZERO) die('ref deletes are not allowed');
if (u.ref !== permit.ref) die(`permit is for ${permit.ref}, not ${u.ref}`);
if (!/^[A-Za-z0-9._-]+$/.test(permit.agent) || u.ref !== `refs/heads/agents/${permit.agent}`) die('agent ref mismatch');
const db = new DatabaseSync(path.join(root, 'state', 'g4a.db'), { readOnly: true });
const row = db.prepare('SELECT status, agent FROM claims WHERE id = ?').get(permit.claim);
db.close();
if (!row || row.status !== 'active' || row.agent !== permit.agent) die('claim is not active on the authority');
if (git('merge-base', '--is-ancestor', permit.baseline, u.new).status !== 0) die('push does not descend from the claim baseline');
const files = git('diff', '--name-only', '-z', permit.baseline, u.new).stdout.split('\0').filter(Boolean);
const out = files.filter((f) => !permit.paths.some((p) => globMatchesPath(p, f)));
if (out.length) die(`out-of-claim paths: ${out.slice(0, 5).join(', ')}`);
try { fs.writeFileSync(path.join(root, 'nonces', permit.nonce), u.new, { flag: 'wx' }); } catch { die('permit already used (replay)'); }
