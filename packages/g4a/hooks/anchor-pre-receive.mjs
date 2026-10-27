// Anchor remote pre-receive: append-only. Only refs/g4a/* may be written, never deleted, and every
// update must fast-forward (the anchor is a signed commit chain).
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const ZERO = '0'.repeat(40);
const die = (m) => { process.stderr.write(`[g4a-anchor] refused: ${m}\n`); process.exit(1); };
const via = process.env.G4A_VIA || '';
for (const l of fs.readFileSync(0, 'utf8').split('\n').filter(Boolean)) {
  const [old, nu, ref] = l.split(' ');
  if (!ref.startsWith('refs/g4a/')) die(`only refs/g4a/* anchors are accepted, not ${ref}`);
  if (via === 'agent' && ref !== 'refs/g4a/client-ledger') die(`agents may only append to refs/g4a/client-ledger, not ${ref}`);
  if (nu === ZERO) die('anchor deletes are not allowed');
  if (old !== ZERO && spawnSync('git', ['merge-base', '--is-ancestor', old, nu], { encoding: 'utf8' }).status !== 0) die('anchor rewrite (non fast-forward) refused');
}
