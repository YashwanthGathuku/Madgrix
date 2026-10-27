// Local out-of-band ref guard (limit 3). Two layers, and they are NOT equal:
//  - PREVENTION (git CLI only): a reference-transaction hook refuses, in the "prepared" phase, any
//    transaction touching refs/heads/main or refs/g4a/*, whichever git binary path is used
//    (/usr/bin/git, absolute paths, aliases) because hooks are run by git itself. g4a's own
//    control-plane git runs with core.hooksPath=/dev/null and is not affected. Anything that skips
//    hooks (libgit2, isomorphic-git, JGit, `git -c core.hooksPath=...`, writing .git/refs or
//    packed-refs directly) is NOT prevented here.
//  - DETECTION (everything): `g4a verify` compares local main to the authority main, scans the
//    main reflog since install for entries g4a did not write, and reports hook refusals. The
//    authority itself never accepts an unpermitted push, so a local main change can never reach
//    the authority's main; it only makes the local checkout lie, which verify flags.
import fs from 'node:fs';
import path from 'node:path';
import { safeGit } from '../../../scripts/lib/safe-git.mjs';

const MARK = '# g4a reference-transaction guard v1';
const HOOK = `#!/bin/sh
${MARK}
# refuses (prepared phase) any ref transaction that touches refs/heads/main or refs/g4a/*;
# only g4a's control plane (which runs git with core.hooksPath=/dev/null) may move them.
dir=$(dirname "$0")
in=$(cat)
if [ -x "$dir/reference-transaction.g4a-prev" ]; then
  printf '%s\\n' "$in" | "$dir/reference-transaction.g4a-prev" "$@" || exit $?
fi
[ "$1" = prepared ] || exit 0
hit=$(printf '%s\\n' "$in" | awk '$1 != $2 && ($3 == "refs/heads/main" || index($3, "refs/g4a/") == 1) { print $3 }')
[ -z "$hit" ] && exit 0
log="$(git rev-parse --git-common-dir 2>/dev/null || echo .git)/g4a-ref-events.log"
printf '%s refused %s pid=%s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(echo $hit | tr '\\n' ' ')" "$PPID" >> "$log" 2>/dev/null
echo "g4a: refused: refs/heads/main and refs/g4a/* move only through g4a promote (authority-landed)" >&2
exit 1
`;

const reflog = (top) => safeGit(top, ['reflog', 'show', '--format=%H%x09%gs', 'refs/heads/main'], { allowFailure: true }).stdout.split('\n').filter(Boolean).map((l) => l.split('\t'));

export function hooksDir(top) {
  const hp = safeGit(top, ['config', '--get', 'core.hooksPath'], { allowFailure: true }).stdout.trim();
  if (hp && hp !== '/dev/null') return path.resolve(top, hp);
  return path.join(path.resolve(top, safeGit(top, ['rev-parse', '--git-common-dir']).stdout.trim()), 'hooks');
}

export function installRefGuard(top) {
  const dir = hooksDir(top);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, 'reference-transaction');
  if (fs.existsSync(f) && !fs.readFileSync(f, 'utf8').includes(MARK)) fs.renameSync(f, `${f}.g4a-prev`); // chain the user's hook
  fs.writeFileSync(f, HOOK, { mode: 0o755 }); fs.chmodSync(f, 0o755);
  // baseline: how many main reflog entries existed at install (older ones are not judged)
  if (!safeGit(top, ['config', '--get', 'g4a.refguardBase'], { allowFailure: true }).stdout.trim()) safeGit(top, ['config', 'g4a.refguardBase', String(reflog(top).length)]);
  return { ok: true, hook: f, chained: fs.existsSync(`${f}.g4a-prev`) };
}

// detection: problems found in the local repo (strings), empty when clean
export function refGuardFindings(top) {
  const out = [];
  const b = safeGit(top, ['config', '--get', 'g4a.refguardBase'], { allowFailure: true }).stdout.trim();
  if (b === '') return out;
  const f = path.join(hooksDir(top), 'reference-transaction');
  if (!fs.existsSync(f) || !fs.readFileSync(f, 'utf8').includes(MARK)) out.push(`reference-transaction guard missing or replaced (${f})`);
  const cd = path.resolve(top, safeGit(top, ['rev-parse', '--git-common-dir']).stdout.trim());
  const log = path.join(cd, 'g4a-ref-events.log');
  if (fs.existsSync(log)) for (const l of fs.readFileSync(log, 'utf8').split('\n').filter(Boolean)) out.push(`hook refused an out-of-band ref change: ${l}`);
  const rl = reflog(top); // newest first
  for (const [sha, msg] of rl.slice(0, Math.max(0, rl.length - Number(b)))) {
    if (!/^g4a promote /.test(msg || '')) out.push(`main reflog: ${sha.slice(0, 12)} "${msg}" was not written by g4a`);
  }
  return out;
}
