// `g4a authority init --system` (root part; run via sudo by bin/g4a.mjs). Creates the
// g4a-authority system user, installs a root-owned copy of the code + node + mergiraf under
// /usr/local/lib/g4a, three root-owned wrappers, a sudoers rule that lets any user run ONLY
// those wrappers as g4a-authority, seeds the authority repo for one client repo, and records the
// mapping in root-owned /etc/g4a/authority.json. Secrets (permit/witness keys, DB) live in
// /var/lib/g4a-authority/repos/<id> (0700, g4a-authority); the agent uid cannot read or write it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const USER = 'g4a-authority', HOME = '/var/lib/g4a-authority', REPOS = `${HOME}/repos`, PUB = '/var/lib/g4a-authority-pub';
const LIB = '/usr/local/lib/g4a', BIN = `${LIB}/bin`, MAP = '/etc/g4a/authority.json', SUDOERS = '/etc/sudoers.d/g4a-authority';
export const AGENTS_HOME = '/var/lib/g4a-agents', AGENTS_MAP = '/etc/g4a/agents.json', AGENTS_SUDOERS = '/etc/sudoers.d/g4a-agents';
export { USER as AUTH_USER, REPOS, PUB, LIB, BIN, MAP };
const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const sh = (cmd, args, o = {}) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...o });
const which = (n) => { const r = spawnSync('sh', ['-c', `command -v ${n}`], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; };

// Seed bundle of main for the authority user: a fresh mkdtemp dir (0700) and bundle (0600), both
// chowned to the authority uid only (never world-readable), removed by cleanup() and on exit/signal.
export function seedBundle(seedRepo, { uid = process.getuid(), gid = process.getgid(), tmpdir = os.tmpdir() } = {}) {
  const dir = fs.mkdtempSync(path.join(tmpdir, 'g4a-seed-'));
  fs.chmodSync(dir, 0o700);
  const bundle = path.join(dir, 'seed.bundle');
  let done = false;
  const cleanup = () => { if (done) return; done = true; fs.rmSync(dir, { recursive: true, force: true }); process.off('exit', cleanup); for (const s of SIGS) process.off(s, onSig); };
  const onSig = (s) => { cleanup(); process.kill(process.pid, s); };
  const SIGS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  process.on('exit', cleanup); for (const s of SIGS) process.once(s, onSig);
  try {
    const old = process.umask(0o077);
    try { sh('git', ['-c', 'safe.directory=*', '-C', seedRepo, 'bundle', 'create', '--quiet', bundle, 'refs/heads/main']); } finally { process.umask(old); }
    fs.chmodSync(bundle, 0o600);
    if (uid !== process.getuid() || gid !== process.getgid()) { fs.chownSync(bundle, uid, gid); fs.chownSync(dir, uid, gid); }
  } catch (e) { cleanup(); throw e; }
  return { dir, bundle, cleanup };
}

export function install({ repoId, seedRepo, mergiraf }) {
  if (process.getuid() !== 0) throw new Error('system install must run as root');
  if (spawnSync('id', ['-u', USER]).status !== 0) sh('useradd', ['--system', '--home-dir', HOME, '--shell', '/usr/sbin/nologin', '--user-group', USER]);
  for (const [d, m] of [[HOME, 0o700], [REPOS, 0o700], [PUB, 0o755]]) { fs.mkdirSync(d, { recursive: true }); sh('chown', [`${USER}:${USER}`, d]); fs.chmodSync(d, m); }
  // root-owned code copy (agents cannot swap the code the authority runs)
  fs.rmSync(`${LIB}.new`, { recursive: true, force: true });
  for (const rel of ['src', 'scripts', 'package.json', 'packages/g4a/src', 'packages/g4a/hooks', 'packages/g4a/bin', 'packages/g4a/package.json']) {
    const from = path.join(SRC_ROOT, rel);
    if (!fs.existsSync(from)) continue;
    fs.mkdirSync(path.dirname(path.join(`${LIB}.new`, rel)), { recursive: true });
    fs.cpSync(from, path.join(`${LIB}.new`, rel), { recursive: true, filter: (s) => !s.includes('node_modules') });
  }
  fs.mkdirSync(`${LIB}.new/bin`, { recursive: true });
  fs.copyFileSync(fs.realpathSync(process.execPath), `${LIB}.new/bin/node`);
  // node + npm for witnesses run authority-side (`npm test` etc.)
  const prefix = path.dirname(path.dirname(fs.realpathSync(process.execPath)));
  fs.mkdirSync(`${LIB}.new/node/bin`, { recursive: true });
  fs.copyFileSync(fs.realpathSync(process.execPath), `${LIB}.new/node/bin/node`);
  for (const pm of ['npm', 'npx']) if (fs.existsSync(path.join(prefix, 'lib', 'node_modules', 'npm'))) fs.symlinkSync(`../lib/node_modules/npm/bin/${pm}-cli.js`, `${LIB}.new/node/bin/${pm}`);
  if (fs.existsSync(path.join(prefix, 'lib', 'node_modules', 'npm'))) fs.cpSync(path.join(prefix, 'lib', 'node_modules', 'npm'), `${LIB}.new/node/lib/node_modules/npm`, { recursive: true });
  if (mergiraf && fs.existsSync(mergiraf)) fs.copyFileSync(fs.realpathSync(mergiraf), `${LIB}.new/bin/mergiraf`);
  const ENV = `env -i PATH=${BIN}:${LIB}/node/bin:/usr/bin:/bin HOME=${HOME} LANG=C.UTF-8`;
  const w = {
    'g4a-authority': `#!/bin/sh
# root-owned: run one authority service command for repo <id> as ${USER}
set -eu
# caller identity: sudo sets SUDO_UID itself (env_reset drops any caller-supplied value)
caller="\${SUDO_UID:-\$(id -u)}"
case "$caller" in *[!0-9]*|'') echo "g4a: bad caller uid" >&2; exit 2;; esac
id="$1"; cmd="$2"; arg="\${3:-}"
case "$id" in *[!0-9a-f]*|'') echo '{"ok":false,"error":"bad id"}'; exit 2;; esac
[ \${#id} -eq 16 ] || { echo '{"ok":false,"error":"bad id"}'; exit 2; }
case "$cmd" in claim|permit|land|release|status|ledger|audit|pubinfo|operator-init|override) ;;
  init-root) [ -z "\${SUDO_USER:-}" ] || { echo '{"ok":false,"error":"init-root is root-only"}'; exit 2; } ;;
  *) echo '{"ok":false,"error":"bad command"}'; exit 2;; esac
case "$arg" in *[!A-Za-z0-9+/=]*) echo '{"ok":false,"error":"bad arg"}'; exit 2;; esac
exec ${ENV} G4A_CALLER_UID="$caller" ${BIN}/node --no-warnings ${LIB}/packages/g4a/src/authority-service.mjs --root ${REPOS}/"$id" --pub ${PUB}/"$id" "$cmd" $arg
`,
    'g4a-receive-pack': `#!/bin/sh
# root-owned: git-receive-pack into an authority repo or its append-only anchor remote
set -eu
# caller identity: sudo sets SUDO_UID itself (env_reset drops any caller-supplied value)
caller="\${SUDO_UID:-\$(id -u)}"
case "$caller" in *[!0-9]*|'') echo "g4a: bad caller uid" >&2; exit 2;; esac
p="$1"
case "$p" in ${REPOS}/????????????????/repo|${REPOS}/????????????????/anchors.git) ;; *) echo "g4a: refused path" >&2; exit 2;; esac
case "$p" in *..*) exit 2;; esac
exec ${ENV} G4A_CALLER_UID="$caller" G4A_VIA=agent git receive-pack "$p"
`,
    'g4a-upload-pack': `#!/bin/sh
set -eu
p="$1"
case "$p" in ${REPOS}/????????????????/repo|${REPOS}/????????????????/anchors.git) ;; *) echo "g4a: refused path" >&2; exit 2;; esac
case "$p" in *..*) exit 2;; esac
exec ${ENV} git upload-pack "$p"
`,
    // the g4a CLI from the root-owned copy (agent users run this one, never the operator's tree)
    'g4a': `#!/bin/sh
exec ${BIN}/node --no-warnings ${LIB}/packages/g4a/bin/g4a.mjs "$@"
`,
    // launcher: run ONLY as an agent user (g4a-a-<name>) through /etc/sudoers.d/g4a-agents. The
    // user is taken from the uid, never from arguments; the command is exec'd as given (no shell).
    'g4a-agent-exec': `#!/bin/sh
set -eu
umask 077
me=$(id -un); uid=$(id -u)
[ "$uid" -ne 0 ] || { echo "g4a: refused: agents never run as root" >&2; exit 2; }
case "$me" in g4a-a-*) ;; *) echo "g4a: refused: g4a-agent-exec runs only as a g4a agent user (g4a run --agent <name>)" >&2; exit 2;; esac
name=\${me#g4a-a-}
case "$name" in *[!a-z0-9-]*|''|-*) echo "g4a: bad agent user" >&2; exit 2;; esac
h=${AGENTS_HOME}/"$name"
[ -d "$h/repo" ] || { echo "g4a: agent $name has no clone (g4a agent add)" >&2; exit 2; }
[ "$#" -gt 0 ] || { echo "usage: g4a run --agent <name> -- <command> [args]" >&2; exit 2; }
export HOME="$h" USER="$me" LOGNAME="$me" G4A_HOME="$h/.g4a" G4A_AGENT=1 G4A_AGENT_NAME="$name"
export PATH="$h/.g4a/bin:${BIN}:${LIB}/node/bin:/usr/local/bin:/usr/bin:/bin"
cd "$h/repo"
${BIN}/g4a daemon --detach >/dev/null 2>&1 || true
${BIN}/g4a authority sync --repo "$h/repo" >/dev/null 2>&1 || true
exec "$@"
`,
  };
  for (const [n, body] of Object.entries(w)) fs.writeFileSync(`${LIB}.new/bin/${n}`, body);
  sh('chown', ['-R', 'root:root', `${LIB}.new`]); sh('chmod', ['-R', 'go-w,a+rX', `${LIB}.new`]); for (const n of [...Object.keys(w), 'node', 'mergiraf']) if (fs.existsSync(`${LIB}.new/bin/${n}`)) fs.chmodSync(`${LIB}.new/bin/${n}`, 0o755);
  fs.chmodSync(`${LIB}.new/node/bin/node`, 0o755);
  fs.rmSync(LIB, { recursive: true, force: true }); fs.renameSync(`${LIB}.new`, LIB);
  const rule = `# g4a: any user may run ONLY these root-owned wrappers as ${USER}\nDefaults!${BIN}/g4a-authority,${BIN}/g4a-receive-pack,${BIN}/g4a-upload-pack env_reset\nALL ALL=(${USER}) NOPASSWD: ${BIN}/g4a-authority, ${BIN}/g4a-receive-pack, ${BIN}/g4a-upload-pack\n`;
  fs.writeFileSync(`${SUDOERS}.tmp`, rule, { mode: 0o440 });
  if (spawnSync('visudo', ['-cf', `${SUDOERS}.tmp`]).status !== 0) { fs.rmSync(`${SUDOERS}.tmp`); throw new Error('sudoers rule failed visudo -c'); }
  fs.renameSync(`${SUDOERS}.tmp`, SUDOERS);
  // seed: a bundle of main, readable by the authority user, cloned authority-side
  const id = createHash('sha256').update(repoId).digest('hex').slice(0, 16);
  const uid = Number(sh('id', ['-u', USER]).trim()), gid = Number(sh('id', ['-g', USER]).trim());
  const seed = seedBundle(seedRepo, { uid, gid });
  let r;
  try {
    const b64 = Buffer.from(JSON.stringify({ seed: seed.bundle, clientRepo: repoId, mode: 'system' })).toString('base64');
    const env = { ...process.env }; delete env.SUDO_USER; delete env.SUDO_UID; delete env.SUDO_GID; delete env.SUDO_COMMAND;
    r = spawnSync('runuser', ['-u', USER, '--', `${BIN}/g4a-authority`, id, 'init-root', b64], { encoding: 'utf8', env, cwd: '/' });
  } finally { seed.cleanup(); }
  let res; try { res = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { throw new Error(`authority init-root failed: ${r.stderr || r.stdout}`); }
  if (!res.ok) throw new Error(`authority init-root failed: ${res.error}`);
  fs.mkdirSync(path.dirname(MAP), { recursive: true, mode: 0o755 });
  let map = {}; try { map = JSON.parse(fs.readFileSync(MAP, 'utf8')); } catch {}
  map[repoId] = { id, root: `${REPOS}/${id}`, pub: `${PUB}/${id}` };
  fs.writeFileSync(`${MAP}.tmp`, JSON.stringify(map, null, 2) + '\n', { mode: 0o644 }); fs.renameSync(`${MAP}.tmp`, MAP); sh('chown', ['root:root', MAP]);
  return { ok: true, mode: 'system', user: USER, id, root: `${REPOS}/${id}`, pub: `${PUB}/${id}`, seed: res.seed, sudoers: SUDOERS, map: MAP };
}

// Remove one repo's authority (root dir, pub dir, map entry). When no mapped repo remains (or
// purge), also remove the code copy, wrappers, sudoers rule, /etc/g4a and the g4a-authority user.
export async function uninstall({ repoId, purge = false }) {
  if (process.getuid() !== 0) throw new Error('system uninstall must run as root');
  let map = {}; try { map = JSON.parse(fs.readFileSync(MAP, 'utf8')); } catch {}
  const removed = [];
  const ids = purge ? Object.keys(map) : [repoId];
  // agent users of the removed authorities go first (users, homes, bindings, sudoers, map entries)
  const gone = new Set(ids.map((r) => map[r]?.id).filter(Boolean));
  const { listAgents, removeAgent } = await import('./agent-users.mjs');
  for (const a of listAgents()) if (gone.has(a.authorityId)) removeAgent({ name: a.name });
  try { map = JSON.parse(fs.readFileSync(MAP, 'utf8')); } catch {}
  for (const r of Object.keys(map)) if (map[r].agent && gone.has(map[r].id)) delete map[r];
  for (const r of ids) {
    const e = map[r]; if (!e) continue;
    if (!/^[0-9a-f]{16}$/.test(e.id)) throw new Error('corrupt map entry');
    fs.rmSync(`${REPOS}/${e.id}`, { recursive: true, force: true }); fs.rmSync(`${PUB}/${e.id}`, { recursive: true, force: true });
    delete map[r]; removed.push(r);
  }
  const left = Object.keys(map).length;
  if (left) { fs.writeFileSync(`${MAP}.tmp`, JSON.stringify(map, null, 2) + '\n', { mode: 0o644 }); fs.renameSync(`${MAP}.tmp`, MAP); return { ok: true, removed, remaining: left }; }
  for (const f of [SUDOERS, AGENTS_SUDOERS, AGENTS_HOME, LIB, path.dirname(MAP), HOME, PUB]) fs.rmSync(f, { recursive: true, force: true });
  if (spawnSync('id', ['-u', USER]).status === 0) spawnSync('userdel', [USER]);
  return { ok: true, removed, remaining: 0, purged: true };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--uninstall' || process.argv[2] === '--purge') {
    uninstall({ repoId: process.argv[3], purge: process.argv[2] === '--purge' }).then((r) => process.stdout.write(JSON.stringify(r) + '\n'), (e) => { process.stdout.write(JSON.stringify({ ok: false, error: e.message }) + '\n'); process.exitCode = 1; });
  } else {
    const [repoId, seedRepo, mergiraf] = process.argv.slice(2);
    try { process.stdout.write(JSON.stringify(install({ repoId, seedRepo, mergiraf: mergiraf || which('mergiraf') })) + '\n'); }
    catch (e) { process.stdout.write(JSON.stringify({ ok: false, error: e.message }) + '\n'); process.exitCode = 1; }
  }
}
