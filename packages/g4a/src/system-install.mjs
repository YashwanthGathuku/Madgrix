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
const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const sh = (cmd, args, o = {}) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...o });
const which = (n) => { const r = spawnSync('sh', ['-c', `command -v ${n}`], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; };

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'g4a-seed-')); fs.chmodSync(tmp, 0o755);
  const bundle = path.join(tmp, 'seed.bundle');
  sh('git', ['-c', 'safe.directory=*', '-C', seedRepo, 'bundle', 'create', '--quiet', bundle, 'refs/heads/main']); fs.chmodSync(bundle, 0o644);
  const b64 = Buffer.from(JSON.stringify({ seed: bundle, clientRepo: repoId, mode: 'system' })).toString('base64');
  const env = { ...process.env }; delete env.SUDO_USER; delete env.SUDO_UID; delete env.SUDO_GID; delete env.SUDO_COMMAND;
  const r = spawnSync('runuser', ['-u', USER, '--', `${BIN}/g4a-authority`, id, 'init-root', b64], { encoding: 'utf8', env, cwd: '/' });
  fs.rmSync(tmp, { recursive: true, force: true });
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
export function uninstall({ repoId, purge = false }) {
  if (process.getuid() !== 0) throw new Error('system uninstall must run as root');
  let map = {}; try { map = JSON.parse(fs.readFileSync(MAP, 'utf8')); } catch {}
  const removed = [];
  const ids = purge ? Object.keys(map) : [repoId];
  for (const r of ids) {
    const e = map[r]; if (!e) continue;
    if (!/^[0-9a-f]{16}$/.test(e.id)) throw new Error('corrupt map entry');
    fs.rmSync(`${REPOS}/${e.id}`, { recursive: true, force: true }); fs.rmSync(`${PUB}/${e.id}`, { recursive: true, force: true });
    delete map[r]; removed.push(r);
  }
  const left = Object.keys(map).length;
  if (left) { fs.writeFileSync(`${MAP}.tmp`, JSON.stringify(map, null, 2) + '\n', { mode: 0o644 }); fs.renameSync(`${MAP}.tmp`, MAP); return { ok: true, removed, remaining: left }; }
  for (const f of [SUDOERS, LIB, path.dirname(MAP), HOME, PUB]) fs.rmSync(f, { recursive: true, force: true });
  if (spawnSync('id', ['-u', USER]).status === 0) spawnSync('userdel', [USER]);
  return { ok: true, removed, remaining: 0, purged: true };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--uninstall' || process.argv[2] === '--purge') {
    try { process.stdout.write(JSON.stringify(uninstall({ repoId: process.argv[3], purge: process.argv[2] === '--purge' })) + '\n'); }
    catch (e) { process.stdout.write(JSON.stringify({ ok: false, error: e.message }) + '\n'); process.exitCode = 1; }
    process.exit();
  }
  const [repoId, seedRepo, mergiraf] = process.argv.slice(2);
  try { process.stdout.write(JSON.stringify(install({ repoId, seedRepo, mergiraf: mergiraf || which('mergiraf') })) + '\n'); }
  catch (e) { process.stdout.write(JSON.stringify({ ok: false, error: e.message }) + '\n'); process.exitCode = 1; }
}
