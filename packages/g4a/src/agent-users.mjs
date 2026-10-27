// `g4a agent add|remove|policy` (root part; run via sudo by bin/g4a.mjs). Gives every agent its own
// OS user so that the authority sees a distinct uid per agent (closes the same-uid credential gap):
//   user g4a-a-<name> (system user, no password, no sudo of its own, shell nologin, own group)
//   home /var/lib/g4a-agents/<name> (0700, the agent's): its own clone of authority main in
//        ~/repo (worktrees under ~/repo/.g4a/worktrees/<name>, so nothing is shared with another
//        agent or the operator), its own daemon + shim under ~/.g4a, and its credential in
//        ~/.g4a/credentials/<hash>/<name> (dir 0700, file 0600, owned by the agent user)
//   authority: name -> uid bound by root (os-bind), with an OS-agent policy (only agent users act,
//        each only under its own name; the operator uid and root are refused unless allowed)
//   launcher: /etc/sudoers.d/g4a-agents lets the operator run ONLY the root-owned g4a-agent-exec
//        wrapper as each agent user (env_reset + a short env_keep allowlist)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AGENTS_HOME, AGENTS_MAP, AGENTS_SUDOERS, AUTH_USER, REPOS, PUB, LIB, BIN, MAP } from './system-install.mjs';

export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;
const OPERATOR_RE = /^[a-z_][a-z0-9_.-]{0,31}$/;
export const userOf = (name) => `g4a-a-${name}`;
export const ENV_KEEP = ['TERM', 'COLORTERM', 'LANG', 'LC_ALL', 'NO_COLOR', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY'];
const sh = (cmd, args, o = {}) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', ...o });
const exists = (u) => spawnSync('id', ['-u', u], { stdio: 'ignore' }).status === 0;
const cleanEnv = (extra = {}) => ({ PATH: `${BIN}:${LIB}/node/bin:/usr/bin:/bin`, LANG: 'C.UTF-8', ...extra });

export function readAgentsMap() { try { const m = JSON.parse(fs.readFileSync(AGENTS_MAP, 'utf8')); return { agents: m.agents ?? {}, policy: m.policy ?? {} }; } catch { return { agents: {}, policy: {} }; } }
function writeAgentsMap(m) {
  if (!Object.keys(m.agents).length && !Object.keys(m.policy).length) { fs.rmSync(AGENTS_MAP, { force: true }); return; }
  fs.mkdirSync(path.dirname(AGENTS_MAP), { recursive: true, mode: 0o755 });
  fs.writeFileSync(`${AGENTS_MAP}.tmp`, JSON.stringify(m, null, 2) + '\n', { mode: 0o644 }); fs.renameSync(`${AGENTS_MAP}.tmp`, AGENTS_MAP);
}
export const listAgents = () => Object.entries(readAgentsMap().agents).map(([name, a]) => ({ name, ...a }));
const readMap = () => { try { return JSON.parse(fs.readFileSync(MAP, 'utf8')); } catch { return {}; } };
const writeMap = (m) => { fs.writeFileSync(`${MAP}.tmp`, JSON.stringify(m, null, 2) + '\n', { mode: 0o644 }); fs.renameSync(`${MAP}.tmp`, MAP); };

// root -> authority service as g4a-authority, bypassing the sudo wrapper (os-* are not reachable through it)
function service(id, cmd, p) {
  const b64 = Buffer.from(JSON.stringify(p)).toString('base64');
  const r = spawnSync('runuser', ['-u', AUTH_USER, '--', '/usr/bin/env', '-i', `PATH=${BIN}:/usr/bin:/bin`, `HOME=/var/lib/${AUTH_USER}`, 'LANG=C.UTF-8', `${BIN}/node`, '--no-warnings', `${LIB}/packages/g4a/src/authority-service.mjs`, '--root', `${REPOS}/${id}`, '--pub', `${PUB}/${id}`, cmd, b64], { encoding: 'utf8', cwd: '/' });
  try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return { ok: false, error: `authority ${cmd} failed (exit ${r.status})` }; }
}
// run as the agent user with a clean environment (never root's)
const asAgent = (name, args, o = {}) => spawnSync('runuser', ['-u', userOf(name), '--', '/usr/bin/env', '-i', ...Object.entries(cleanEnv({ HOME: `${AGENTS_HOME}/${name}`, USER: userOf(name), G4A_HOME: `${AGENTS_HOME}/${name}/.g4a`, ...(o.env ?? {}) })).map(([k, v]) => `${k}=${v}`), ...args], { encoding: 'utf8', cwd: `${AGENTS_HOME}/${name}`, ...(o.input !== undefined ? { input: o.input } : {}) });
const must = (r, what) => { if (r.status !== 0) throw new Error(`${what} failed: ${(r.stderr || r.stdout || '').trim().split('\n').slice(-2).join(' ')}`); return r; };

function writeSudoers(m) {
  const lines = [];
  for (const [name, a] of Object.entries(m.agents)) lines.push(`${a.operator} ALL=(${userOf(name)}) NOPASSWD: ${BIN}/g4a-agent-exec`);
  if (!lines.length) { fs.rmSync(AGENTS_SUDOERS, { force: true }); return; }
  const body = `# g4a: the operator may run ONLY the root-owned launcher as each agent user (g4a run --agent <name>)\nDefaults!${BIN}/g4a-agent-exec env_reset, env_keep = "${ENV_KEEP.join(' ')}"\n${lines.join('\n')}\n`;
  fs.writeFileSync(`${AGENTS_SUDOERS}.tmp`, body, { mode: 0o440 });
  if (spawnSync('visudo', ['-cf', `${AGENTS_SUDOERS}.tmp`], { stdio: 'ignore' }).status !== 0) { fs.rmSync(`${AGENTS_SUDOERS}.tmp`); throw new Error('agent sudoers rule failed visudo -c'); }
  fs.renameSync(`${AGENTS_SUDOERS}.tmp`, AGENTS_SUDOERS);
}

export function addAgent({ name, repoId, operator }) {
  if (process.getuid() !== 0) throw new Error('g4a agent add must run as root (via sudo)');
  if (!NAME_RE.test(String(name ?? ''))) throw new Error('bad agent name: use 1-24 of [a-z0-9-], starting with a letter or digit');
  if (!OPERATOR_RE.test(String(operator ?? '')) || operator === 'root' || !exists(operator)) throw new Error('the operator must be an existing non-root user (run g4a agent add via sudo from your own account)');
  const user = userOf(name), home = `${AGENTS_HOME}/${name}`;
  const map = readMap(); const e = map[repoId];
  if (!e || e.agent) throw new Error('no system authority for this repo (g4a authority init --system first)');
  const m = readAgentsMap();
  if (m.agents[name]) throw new Error(`agent ${name} already exists`);
  if (exists(user)) throw new Error(`user ${user} already exists and is not a g4a agent; refusing to reuse it`);
  fs.mkdirSync(AGENTS_HOME, { recursive: true, mode: 0o755 }); fs.chownSync(AGENTS_HOME, 0, 0); fs.chmodSync(AGENTS_HOME, 0o755);
  sh('useradd', ['--system', '--create-home', '--home-dir', home, '--shell', '/usr/sbin/nologin', '--user-group', '--comment', `g4a agent ${name}`, user]);
  try {
    fs.chmodSync(home, 0o700);
    const uid = Number(sh('id', ['-u', user]).trim());
    // the agent's own clone of authority main, fetched through the upload-pack wrapper as the agent
    const up = `--upload-pack=sudo -n -u ${AUTH_USER} ${BIN}/g4a-upload-pack`, url = `${REPOS}/${e.id}/repo`;
    const repo = `${home}/repo`;
    must(asAgent(name, ['git', 'init', '-q', '-b', 'main', repo]), 'git init');
    must(asAgent(name, ['git', '-C', repo, '-c', 'protocol.file.allow=always', 'fetch', '-q', '--no-tags', up, url, '+refs/heads/main:refs/g4a/authority-main']), 'fetch authority main');
    must(asAgent(name, ['sh', '-c', `cd ${repo} && git update-ref refs/heads/main refs/g4a/authority-main && git checkout -q --detach main && git config user.name ${user} && git config user.email ${user}@g4a.invalid && git config remote.origin.url ${url} && git config remote.origin.uploadpack "sudo -n -u ${AUTH_USER} ${BIN}/g4a-upload-pack" && git config remote.origin.fetch +refs/heads/main:refs/remotes/origin/main`]), 'configure clone');
    const cloneId = fs.realpathSync(`${repo}/.git`);
    map[cloneId] = { id: e.id, root: e.root, pub: e.pub, agent: name }; writeMap(map);
    // shim + ref guard in the agent's own G4A_HOME/clone
    must(asAgent(name, [`${BIN}/g4a`, 'install']), 'g4a install (agent shim)');
    must(asAgent(name, [`${BIN}/node`, '--no-warnings', '--input-type=module', '-e', `import(${JSON.stringify(`${LIB}/packages/g4a/src/refguard.mjs`)}).then((m) => m.installRefGuard(${JSON.stringify(repo)}))`]), 'ref guard');
    // bind name -> uid at the authority; the credential goes straight into a file owned by the agent
    const b = service(e.id, 'os-bind', { agent: name, uid });
    if (!b.ok) throw new Error(`authority os-bind: ${b.error}`);
    const hash = (sh(`${BIN}/node`, ['-e', `process.stdout.write(require('node:crypto').createHash('sha256').update(${JSON.stringify(cloneId)}).digest('hex').slice(0,16))`])).trim();
    const credFile = `${home}/.g4a/credentials/${hash}/${name}`;
    must(asAgent(name, ['sh', '-c', `umask 077 && mkdir -p ${home}/.g4a/credentials/${hash} && chmod 700 ${home}/.g4a ${home}/.g4a/credentials ${home}/.g4a/credentials/${hash} && cat > ${credFile}.tmp && chmod 600 ${credFile}.tmp && mv ${credFile}.tmp ${credFile}`], { input: b.credential + '\n' }), 'write credential');
    m.agents[name] = { user, uid, home, clone: repo, cloneId, repo: repoId, authorityId: e.id, operator, created: new Date().toISOString() };
    writeAgentsMap(m); writeSudoers(m);
    return { ok: true, agent: name, user, uid, home, clone: repo, credential_file: credFile, sudoers: AGENTS_SUDOERS, launcher: `g4a run --agent ${name} -- <command>` };
  } catch (err) {
    try { removeAgent({ name, force: true }); } catch {}
    throw err;
  }
}

export function removeAgent({ name, force = false }) {
  if (process.getuid() !== 0) throw new Error('g4a agent remove must run as root (via sudo)');
  if (!NAME_RE.test(String(name ?? ''))) throw new Error('bad agent name');
  const user = userOf(name), m = readAgentsMap(), a = m.agents[name];
  if (!a && !force) throw new Error(`no agent ${name}`);
  const done = [];
  const uid = exists(user) ? Number(sh('id', ['-u', user]).trim()) : a?.uid;
  if (exists(user)) {
    for (let i = 0; i < 50 && spawnSync('pgrep', ['-u', user], { stdio: 'ignore' }).status === 0; i++) { spawnSync('pkill', ['-KILL', '-u', user]); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100); }
    done.push('processes');
  }
  const map = readMap();
  const authId = a?.authorityId ?? Object.values(map).find((x) => x.agent === name)?.id;
  if (authId && fs.existsSync(`${REPOS}/${authId}`)) { const r = service(authId, 'os-unbind', { agent: name }); if (r.ok) done.push('authority binding'); }
  for (const k of Object.keys(map)) if (map[k].agent === name) { delete map[k]; done.push('map entry'); }
  if (fs.existsSync(MAP)) writeMap(map);
  delete m.agents[name]; writeAgentsMap(m); writeSudoers(m); done.push('sudoers', 'agents.json');
  if (exists(user)) { spawnSync('crontab', ['-r', '-u', user], { stdio: 'ignore' }); sh('userdel', ['-r', user], { stdio: 'ignore' }); done.push('user'); }
  if (spawnSync('getent', ['group', user], { stdio: 'ignore' }).status === 0) spawnSync('groupdel', [user]);
  fs.rmSync(`${AGENTS_HOME}/${name}`, { recursive: true, force: true });
  if (Number.isInteger(uid) && uid > 0) for (const d of ['/tmp', '/var/tmp', '/dev/shm']) spawnSync('find', [d, '-xdev', '-uid', String(uid), '-depth', '-delete'], { stdio: 'ignore' });
  try { fs.rmdirSync(AGENTS_HOME); } catch {}
  return { ok: true, agent: name, removed: [...new Set(done)] };
}

export function setPolicy({ repoId, allowOperator }) {
  if (process.getuid() !== 0) throw new Error('g4a agent policy must run as root (via sudo)');
  const e = readMap()[repoId];
  if (!e || e.agent) throw new Error('no system authority for this repo');
  const r = service(e.id, 'os-policy', { allowOperator: !!allowOperator });
  if (!r.ok) throw new Error(r.error);
  const m = readAgentsMap();
  if (allowOperator) m.policy[repoId] = { allowOperator: true }; else delete m.policy[repoId];
  writeAgentsMap(m);
  return { ok: true, repo: repoId, allowOperator: !!allowOperator };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, a1, a2, a3] = process.argv.slice(2);
  let r;
  try {
    if (cmd === 'add') r = addAgent({ name: a1, repoId: a2, operator: a3 });
    else if (cmd === 'remove') r = removeAgent({ name: a1 });
    else if (cmd === 'policy') r = setPolicy({ repoId: a1, allowOperator: a2 === 'on' });
    else r = { ok: false, error: 'usage: agent-users.mjs add NAME REPOID OPERATOR | remove NAME | policy REPOID on|off' };
  } catch (e) { r = { ok: false, error: e.message }; }
  process.stdout.write(JSON.stringify(r) + '\n'); if (r.ok === false) process.exitCode = 1;
}
