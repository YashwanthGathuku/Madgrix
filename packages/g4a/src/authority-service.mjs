// Phase 2 authority service. Owns the authoritative repo, claims, ledger, witness/permit/operator
// keys and anchors for ONE client repo. Every command runs here (authority side):
//   --system:   as the `g4a-authority` OS user, reached only through root-owned sudo wrappers
//               (/usr/local/lib/g4a/bin/*); agents' uid cannot read keys or write refs (PREVENTED)
//   same-user:  `--root DIR`, run directly by the client uid. Fallback, DETECT-ONLY: the client
//               uid can still edit DIR; audit/verify notice, nothing prevents it.
// Layout of a root R: repo/ (non-bare, detached HEAD; core.hooksPath=R/hooks), anchors.git/
// (append-only), keys/ (0700), state/ (Authority DB), nonces/, accepted.jsonl, authority.json;
// public dir P (readable by clients): permit/witness/operator *.pub.hex, overrides/, seed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, createHash, timingSafeEqual } from 'node:crypto';
import { safeGit } from '../../../scripts/lib/safe-git.mjs';
import { canonicalJson } from '../../../src/lib/canonical.ts';
import { Authority, rowClaim, bundleFromDb, repoId } from './authority.mjs';
import { promote } from './promote.mjs';
import { signOverride, overrideName, OPT_OUT_VARS } from './override.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOKS = path.join(HERE, '..', 'hooks');
export const ZERO = '0'.repeat(40);
export const AUTH_ANCHOR_REF = 'refs/g4a/authority-ledger';
export const CLIENT_ANCHOR_REF = 'refs/g4a/client-ledger';
const FILE_PROTO = ['-c', 'protocol.file.allow=always'];

export function layout(root, pub) {
  root = path.resolve(root);
  return { root, pub: path.resolve(pub ?? path.join(root, 'pub')), repo: path.join(root, 'repo'), anchors: path.join(root, 'anchors.git'), keys: path.join(root, 'keys'), state: path.join(root, 'state'), nonces: path.join(root, 'nonces'), hooks: path.join(root, 'hooks'), anchorHooks: path.join(root, 'anchor-hooks'), accepted: path.join(root, 'accepted.jsonl'), conf: path.join(root, 'authority.json') };
}
const readConf = (L) => JSON.parse(fs.readFileSync(L.conf, 'utf8'));
const permitKeyFile = (L) => path.join(L.keys, 'permit-ed25519.pem');
const operatorKeyFile = (L) => path.join(L.keys, 'operator-ed25519.pem');
const pubHex = (k) => createPublicKey(k).export({ type: 'spki', format: 'der' }).toString('hex');

function hookWrapper(file, script, L) {
  fs.writeFileSync(file, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} --no-warnings ${JSON.stringify(path.join(HOOKS, script))} ${JSON.stringify(L.root)} ${JSON.stringify(L.pub)}\n`, { mode: 0o755 });
}

// Create (or repair) an authority root. `seed` is a path or bundle readable by this uid; `clientRepo`
// is the client's repo id (git common dir realpath) this authority serves.
export function initRoot({ root, pub, seed, clientRepo, mode }) {
  const L = layout(root, pub);
  fs.mkdirSync(L.root, { recursive: true, mode: 0o700 }); fs.chmodSync(L.root, 0o700);
  for (const d of [L.keys, L.state, L.nonces, L.hooks, L.anchorHooks]) fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(L.pub, 'overrides'), { recursive: true, mode: 0o755 }); fs.chmodSync(L.pub, 0o755);
  if (!fs.existsSync(path.join(L.repo, '.git'))) {
    safeGit(os.tmpdir(), [...FILE_PROTO, 'clone', '--quiet', '--no-checkout', '--branch', 'main', seed, L.repo]);
    safeGit(L.repo, ['remote', 'remove', 'origin']);
    safeGit(L.repo, ['checkout', '--quiet', '--detach', 'main']);
  }
  for (const [k, v] of [['core.hooksPath', L.hooks], ['receive.advertisePushOptions', 'true'], ['receive.denyDeletes', 'true'], ['receive.denyNonFastForwards', 'true'], ['user.name', 'g4a-authority'], ['user.email', 'g4a-authority@localhost']]) safeGit(L.repo, ['config', k, v]);
  hookWrapper(path.join(L.hooks, 'pre-receive'), 'pre-receive.mjs', L);
  hookWrapper(path.join(L.hooks, 'post-receive'), 'post-receive.mjs', L);
  if (!fs.existsSync(path.join(L.anchors, 'HEAD'))) safeGit(os.tmpdir(), ['init', '--quiet', '--bare', L.anchors]);
  for (const [k, v] of [['core.hooksPath', L.anchorHooks], ['receive.denyDeletes', 'true'], ['receive.denyNonFastForwards', 'true']]) safeGit(L.anchors, ['config', k, v]);
  hookWrapper(path.join(L.anchorHooks, 'pre-receive'), 'anchor-pre-receive.mjs', L);
  if (!fs.existsSync(permitKeyFile(L))) fs.writeFileSync(permitKeyFile(L), generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  fs.writeFileSync(path.join(L.pub, 'permit.pub.hex'), pubHex(createPrivateKey(fs.readFileSync(permitKeyFile(L), 'utf8'))) + '\n', { mode: 0o644 });
  const auth = new Authority(L.state, { keyDir: L.keys });
  fs.writeFileSync(path.join(L.pub, 'witness.pub.hex'), auth.publicKeySpkiHex + '\n', { mode: 0o644 });
  auth.db.close();
  const seedSha = safeGit(L.repo, ['rev-parse', 'refs/heads/main']).stdout.trim();
  const prev = fs.existsSync(L.conf) ? readConf(L) : {};
  const conf = { version: 'g4a-authority/v1', mode, clientRepo: prev.clientRepo ?? clientRepo, seed: prev.seed ?? seedSha, root: L.root, pub: L.pub, repo: L.repo, anchors: L.anchors };
  fs.writeFileSync(L.conf, JSON.stringify(conf, null, 2) + '\n', { mode: 0o600 });
  fs.writeFileSync(path.join(L.pub, 'authority.json'), JSON.stringify({ mode, clientRepo: conf.clientRepo, seed: conf.seed }, null, 2) + '\n', { mode: 0o644 });
  return { ok: true, mode, root: L.root, pub: L.pub, seed: conf.seed };
}

// ---- service commands ----
function withLock(L, fn) {
  const lock = path.join(L.root, 'lock.d');
  const t0 = Date.now();
  for (;;) {
    try { fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'pid'), String(process.pid)); break; } catch {
      let pid = 0; try { pid = Number(fs.readFileSync(path.join(lock, 'pid'), 'utf8')); } catch {}
      let alive = false; try { if (pid) { process.kill(pid, 0); alive = true; } } catch {}
      if (pid && !alive) { fs.rmSync(lock, { recursive: true, force: true }); continue; }
      if (Date.now() - t0 > 900_000) throw new Error('authority lock timeout');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  const release = () => fs.rmSync(lock, { recursive: true, force: true });
  return Promise.resolve().then(fn).finally(release);
}
export const callerUid = () => { const v = process.env.G4A_CALLER_UID; return /^[0-9]+$/.test(v ?? '') ? Number(v) : process.getuid(); };
// state/agents.json: { "<agent>": <uid> }. Bound on first claim; root (uid 0) may act for any agent.
// state/agents.json: { "<agent>": { uid, cred } }. cred = sha256 of a per-agent credential the
// authority issues on the binding claim (returned ONCE, never stored in clear authority-side).
// claim/permit/land/release need the caller uid to match AND the credential (root skips the uid
// check only). Legacy bindings ({agent: uid} or cred null) get a credential on their next claim.
const credHash = (c) => createHash('sha256').update(String(c)).digest();
const agentsFile = (L) => path.join(L.state, 'agents.json');
const readAgents = (L) => { try { return JSON.parse(fs.readFileSync(agentsFile(L), 'utf8')); } catch { return {}; } };
const writeAgents = (L, m) => { fs.writeFileSync(agentsFile(L) + '.tmp', JSON.stringify(m, null, 2), { mode: 0o600 }); fs.renameSync(agentsFile(L) + '.tmp', agentsFile(L)); };
// operator actions carry an Ed25519 signature by the operator key over the canonical record
const identityLog = (L, e, key) => { const r = { ...e, at: new Date().toISOString() }; if (key) r.operator_sig = sign(null, Buffer.from(canonicalJson(r)), key).toString('hex'); fs.appendFileSync(path.join(L.state, 'identity.jsonl'), JSON.stringify(r) + '\n', { mode: 0o600 }); };
export const AGENT_RE = /^[A-Za-z0-9._-]{1,64}$/;
export function bindAgent(L, agent, uid, mayBind, credential) {
  if (!AGENT_RE.test(String(agent ?? ''))) return { ok: false, error: 'bad agent name' };
  const m = readAgents(L);
  let e = m[agent];
  if (typeof e === 'number') e = { uid: e, cred: null };
  const issue = () => { const c = randomBytes(32).toString('base64url'); m[agent] = { uid: e?.uid ?? uid, cred: credHash(c).toString('hex') }; writeAgents(L, m); identityLog(L, { event: e ? 'credential_issued' : 'bound', agent, uid: m[agent].uid }); return c; };
  if (e) {
    if (e.uid !== uid && uid !== 0) return { ok: false, error: `agent ${agent} is bound to uid ${e.uid}, caller is uid ${uid}` };
    if (e.cred) {
      const given = credential ? credHash(credential) : null;
      if (!given || !timingSafeEqual(given, Buffer.from(e.cred, 'hex'))) { identityLog(L, { event: 'credential_refused', agent, uid }); return { ok: false, error: `agent ${agent} credential missing or wrong` }; }
      return { ok: true };
    }
    return mayBind ? { ok: true, credential: issue() } : { ok: true, legacy: true };
  }
  if (!mayBind) return { ok: false, error: `agent ${agent} has no identity binding (claim first)` };
  return { ok: true, bound: true, credential: issue() };
}
// operator-only (passphrase on /dev/tty): move a name to another uid with a fresh credential, or free it
export function rebindAgent(L, agent, uid, key) {
  if (!AGENT_RE.test(String(agent ?? ''))) return { ok: false, error: 'bad agent name' };
  if (!Number.isInteger(uid) || uid < 0) return { ok: false, error: 'uid must be a non-negative integer' };
  const m = readAgents(L); const before = m[agent] ?? null;
  const c = randomBytes(32).toString('base64url');
  m[agent] = { uid, cred: credHash(c).toString('hex') }; writeAgents(L, m);
  identityLog(L, { event: 'rebind', agent, uid, before_uid: typeof before === 'number' ? before : before?.uid ?? null }, key);
  return { ok: true, agent, uid, credential: c };
}
export function unbindAgent(L, agent, key) {
  const m = readAgents(L); const had = agent in m; delete m[agent]; writeAgents(L, m);
  identityLog(L, { event: 'unbind', agent, removed: had }, key);
  return { ok: true, agent, removed: had };
}
const claimRow = (auth, repo, agent) => { const r = auth.db.prepare("SELECT * FROM claims WHERE repo = ? AND agent = ? AND status = 'active'").get(repo, agent); return r && rowClaim(r); };
const strip = ({ secret_sha256, secretFile, ...c }) => c;

function signPermit(L, fields, ttlMs = 120_000) {
  const permit = { version: 'g4a-permit/v1', ...fields, nonce: randomBytes(16).toString('hex'), exp: new Date(Date.now() + ttlMs).toISOString() };
  const signature = sign(null, Buffer.from(canonicalJson(permit)), createPrivateKey(fs.readFileSync(permitKeyFile(L), 'utf8'))).toString('base64');
  return Buffer.from(JSON.stringify({ permit, signature })).toString('base64');
}

function readTtyLine(prompt) {
  let fd;
  try { fd = fs.openSync('/dev/tty', 'r+'); } catch { throw new Error('this action needs the operator passphrase typed on a terminal (/dev/tty unavailable)'); }
  try {
    fs.writeSync(fd, prompt);
    let s = ''; const b = Buffer.alloc(1);
    while (fs.readSync(fd, b, 0, 1, null) === 1 && b[0] !== 10) if (b[0] !== 13) s += String.fromCharCode(b[0]);
    fs.writeSync(fd, '\n');
    return s;
  } finally { fs.closeSync(fd); }
}

export async function run(L, cmd, p = {}) {
  const conf = readConf(L);
  // witnesses (agent code) run authority-side: hide every authority secret/state dir from the sandbox
  const roots = conf.mode === 'system' ? fs.readdirSync(path.dirname(L.root)).map((d) => path.join(path.dirname(L.root), d)) : [L.root];
  process.env.G4A_SANDBOX_HIDE = roots.flatMap((r) => ['keys', 'state', 'nonces'].map((d) => path.join(r, d))).join(':');
  if (cmd === 'pubinfo') return { ok: true, mode: conf.mode, clientRepo: conf.clientRepo, pub: L.pub };
  if (cmd === 'operator-init') {
    if (fs.existsSync(operatorKeyFile(L))) return { ok: true, existed: true };
    const a = readTtyLine('g4a operator: new passphrase (min 10 chars): '), b = readTtyLine('g4a operator: repeat passphrase: ');
    if (a !== b) return { ok: false, error: 'passphrases differ' };
    if (a.length < 10) return { ok: false, error: 'passphrase too short' };
    const { privateKey } = generateKeyPairSync('ed25519');
    fs.writeFileSync(operatorKeyFile(L), privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: a }), { mode: 0o600 });
    fs.writeFileSync(path.join(L.pub, 'operator.pub.hex'), pubHex(privateKey) + '\n', { mode: 0o644 });
    return { ok: true, pub: path.join(L.pub, 'operator.pub.hex') };
  }
  if (cmd === 'override') {
    const minutes = Number(p.minutes);
    if (!(minutes > 0 && minutes <= 1440)) return { ok: false, error: 'minutes must be 1..1440' };
    const vars = (p.vars?.length ? p.vars : OPT_OUT_VARS).filter((v) => OPT_OUT_VARS.includes(v));
    let key;
    try { key = createPrivateKey({ key: fs.readFileSync(operatorKeyFile(L), 'utf8'), passphrase: readTtyLine('g4a operator passphrase: ') }); } catch (e) { return { ok: false, error: /tty/.test(e.message) ? e.message : 'operator key unavailable or wrong passphrase' }; }
    const override = { version: 'g4a-override/v1', repo: conf.clientRepo, vars, until: new Date(Date.now() + minutes * 60_000).toISOString(), reason: String(p.reason || '') };
    const f = path.join(L.pub, 'overrides', overrideName(conf.clientRepo));
    fs.writeFileSync(f + '.tmp', JSON.stringify(signOverride(override, key), null, 2) + '\n', { mode: 0o644 }); fs.renameSync(f + '.tmp', f);
    return { ok: true, file: f, override };
  }
  if (cmd === 'rebind' || cmd === 'unbind') {
    let key;
    try { key = createPrivateKey({ key: fs.readFileSync(operatorKeyFile(L), 'utf8'), passphrase: readTtyLine('g4a operator passphrase: ') }); } catch (e) { return { ok: false, error: /tty/.test(e.message) ? e.message : 'operator key unavailable or wrong passphrase' }; }
    return withLock(L, () => (cmd === 'rebind' ? rebindAgent(L, p.agent, p.uid ?? callerUid(), key) : unbindAgent(L, p.agent, key)));
  }
  return withLock(L, async () => {
    const auth = new Authority(L.state, { keyDir: L.keys, anchorRemote: { url: L.anchors, ref: AUTH_ANCHOR_REF } });
    const repo = repoId(L.repo);
    try {
      // Agent identity: an agent name is bound to the OS uid that first claimed it (system mode:
      // the uid sudo reports via the wrapper; same-user mode: always the one uid, so detect-only).
      if (['claim', 'permit', 'land', 'release'].includes(cmd)) {
        var id = bindAgent(L, p.agent, callerUid(), cmd === 'claim', p.credential);
        if (!id.ok) return { ok: false, status: 'refused', reason: 'agent_identity', error: id.error };
      }
      switch (cmd) {
        case 'claim': {
          const r = await auth.claim({ repo: L.repo, agent: p.agent, paths: p.paths, witnesses: p.witnesses ?? [], witnessPaths: p.witnessPaths ?? [], allowOverlap: !!p.allowOverlap, packageScripts: true });
          if (r.secretFile) fs.rmSync(r.secretFile, { force: true });
          return r.ok ? { ...strip(r), ...(id.credential ? { agent_credential: id.credential } : {}) } : r;
        }
        case 'permit': {
          const c = claimRow(auth, repo, p.agent);
          if (!c) return { ok: false, error: `no active authority claim for ${p.agent}` };
          return { ok: true, claim: c.id, permit: signPermit(L, { kind: 'agent', uid: callerUid(), agent: c.agent, claim: c.id, ref: `refs/heads/agents/${c.agent}`, paths: c.paths, baseline: c.baseline }) };
        }
        case 'land': {
          const c = claimRow(auth, repo, p.agent);
          if (!c) return { ok: false, status: 'refused', reason: `no active authority claim for ${p.agent}` };
          const ref = safeGit(L.repo, ['rev-parse', '--verify', '--quiet', `refs/heads/agents/${c.agent}`], { allowFailure: true }).stdout.trim();
          if (!ref) return { ok: false, status: 'refused', reason: 'nothing pushed to the authority for this claim' };
          if (p.candidate && p.candidate !== ref) return { ok: false, status: 'refused', reason: 'authority agent ref differs from the client branch', authority: ref, client: p.candidate };
          safeGit(L.repo, ['update-ref', `refs/heads/${c.branch}`, ref]);
          const job = p.job || `j_${randomBytes(6).toString('hex')}`;
          const r = await promote(auth, c, job);
          const head = auth.db.prepare('SELECT seq, entry_hash FROM ledger WHERE repo = ? ORDER BY seq DESC LIMIT 1').get(repo);
          return { ...r, authority_entry: head, job };
        }
        case 'release': {
          const c = claimRow(auth, repo, p.agent);
          const r = await auth.release({ repo: L.repo, agent: p.agent, removeWorktree: true });
          if (c) {
            safeGit(L.repo, ['branch', '-D', c.branch], { allowFailure: true });
            const old = safeGit(L.repo, ['rev-parse', '--verify', '--quiet', `refs/heads/agents/${c.agent}`], { allowFailure: true }).stdout.trim();
            if (old) { safeGit(L.repo, ['update-ref', '-d', `refs/heads/agents/${c.agent}`, old]); fs.appendFileSync(L.accepted, JSON.stringify({ ref: `refs/heads/agents/${c.agent}`, old, new: ZERO, kind: 'release', at: new Date().toISOString() }) + '\n'); }
          }
          return r;
        }
        case 'status': return { ok: true, mode: conf.mode, main: safeGit(L.repo, ['rev-parse', 'refs/heads/main']).stdout.trim(), ...auth.status({ repo: L.repo }) };
        case 'ledger': return { ok: true, mode: conf.mode, bundle: bundleFromDb(auth.db, repo), witness_pub: auth.publicKeySpkiHex, main: safeGit(L.repo, ['rev-parse', 'refs/heads/main']).stdout.trim() };
        case 'audit': return audit(L, auth, repo, conf);
        default: return { ok: false, error: `unknown authority command ${cmd}` };
      }
    } finally { auth.db.close(); }
  });
}

// refs that moved without the hook / ladder: main must equal the last ledger promote (or seed);
// agents/* must equal the last post-receive-confirmed value (or release)
export function audit(L, auth, repo, conf = readConf(L)) {
  const bad = [];
  const last = auth.db.prepare("SELECT payload FROM ledger WHERE repo = ? AND kind = 'promote' ORDER BY seq DESC LIMIT 1").get(repo);
  const expectMain = last ? JSON.parse(last.payload).main_after : conf.seed;
  const main = safeGit(L.repo, ['rev-parse', 'refs/heads/main']).stdout.trim();
  if (main !== expectMain) bad.push({ ref: 'refs/heads/main', sha: main, expected: expectMain });
  const acc = new Map();
  if (fs.existsSync(L.accepted)) for (const l of fs.readFileSync(L.accepted, 'utf8').split('\n').filter(Boolean)) { const e = JSON.parse(l); acc.set(e.ref, e.new); }
  const refs = safeGit(L.repo, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/agents/']).stdout.split('\n').filter(Boolean).map((l) => l.split(' '));
  for (const [r, sha] of refs) if (acc.get(r) !== sha) bad.push({ ref: r, sha, expected: acc.get(r) ?? null });
  for (const [r, sha] of acc) if (sha !== ZERO && !refs.some(([x]) => x === r)) bad.push({ ref: r, sha: null, expected: sha });
  return { ok: bad.length === 0, mode: conf.mode, external: bad };
}

// CLI: node authority-service.mjs --root R [--pub P] <cmd> [b64json]   (system wrapper passes --root)
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const a = process.argv.slice(2);
  const opt = (k) => { const i = a.indexOf(k); if (i < 0) return undefined; const v = a[i + 1]; a.splice(i, 2); return v; };
  const root = opt('--root'), pub = opt('--pub');
  const [cmd, b64] = a;
  const p = b64 ? JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) : {};
  // the agent credential never rides in argv (visible in ps to every user); it comes on stdin
  if (p.credential_stdin) { delete p.credential_stdin; const c = fs.readFileSync(0, 'utf8').trim(); if (c) p.credential = c; }
  let L = layout(root, pub);
  if (!pub && fs.existsSync(L.conf)) L = layout(root, readConf(L).pub);
  const work = cmd === 'init-root' ? Promise.resolve(initRoot({ root, pub, seed: p.seed, clientRepo: p.clientRepo, mode: p.mode || 'user' })) : run(L, cmd, p);
  work.then((r) => { process.stdout.write(JSON.stringify(r) + '\n'); process.exitCode = r && r.ok === false ? 1 : 0; },
    (e) => { process.stdout.write(JSON.stringify({ ok: false, error: String(e.message || e) }) + '\n'); process.exitCode = 1; });
}
