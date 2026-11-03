// Claim-scope ref guard (run by the reference-transaction hook, "prepared" phase).
// Refuses moving refs/heads/g4a/<agent> to a commit whose diff from the claim baseline touches
// paths outside the agent's active claim. Hooks run for EVERY git CLI binary, so this blocks
// out-of-claim local commits made with /usr/bin/git, login shells that drop the shim, `env -i`,
// editor/IDE git (GIT_DIR/GIT_WORK_TREE) and GitPython's CLI calls. It cannot see libgit2,
// isomorphic-git, JGit or GitPython's pure-Python index.commit (they skip hooks); those are
// still refused at promote/push time and flagged by verify/audit.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { globMatchesPath } from '../../../src/lib/claims.ts';

export const scopeDir = (common) => path.join(common, 'g4a-scope');
export function writeScope(common, agent, { baseline, paths }) {
  fs.mkdirSync(scopeDir(common), { recursive: true });
  fs.writeFileSync(path.join(scopeDir(common), `${agent}.json`), JSON.stringify({ baseline, paths }));
}
export function clearScope(common, agent) { fs.rmSync(path.join(scopeDir(common), `${agent}.json`), { force: true }); }

const ZERO = /^0+$/;
export function checkTransaction(common, input) {
  const refused = [];
  for (const line of input.split('\n').filter(Boolean)) {
    const [oldv, newv, ref] = line.split(' ');
    const m = /^refs\/heads\/g4a\/([^/]+)$/.exec(ref || '');
    if (!m || oldv === newv || ZERO.test(newv)) continue;
    const f = path.join(scopeDir(common), `${m[1]}.json`);
    if (!fs.existsSync(f)) continue;
    const { baseline, paths } = JSON.parse(fs.readFileSync(f, 'utf8'));
    const r = spawnSync('git', ['--git-dir', common, '-c', 'core.hooksPath=/dev/null', 'diff', '--no-renames', '--name-only', '-z', baseline, newv], { encoding: 'utf8' });
    if (r.status !== 0) { refused.push({ ref, why: 'cannot diff against claim baseline' }); continue; }
    const out = r.stdout.split('\0').filter(Boolean).filter((p) => !paths.some((g) => globMatchesPath(g, p)));
    if (out.length) refused.push({ ref, why: `paths outside claim (${paths.join(', ')}): ${out.join(', ')}` });
  }
  return refused;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const common = process.argv[2];
  const refused = checkTransaction(common, fs.readFileSync(0, 'utf8'));
  if (refused.length) {
    const msg = refused.map((x) => `${x.ref} ${x.why}`).join('; ');
    try { fs.appendFileSync(path.join(common, 'g4a-ref-events.log'), `${new Date().toISOString()} refused ${msg} pid=${process.ppid}\n`); } catch {}
    process.stderr.write(`g4a: refused: ${msg}\n`);
    process.exit(1);
  }
}
