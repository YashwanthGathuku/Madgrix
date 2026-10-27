// g4a Phase 1 authority: the local replacement for the Cloudflare Durable Object.
// State lives in SQLite (node:sqlite, WAL). All mutations run through one in-process
// mutex, so claim overlap checks and ledger appends are serialized like a DO.
// Reused Madgrix modules: src/lib/claims.ts (globsOverlap/globMatchesPath),
// src/lib/ledger.ts (ledgerEntryHash/verifyLedgerChain), src/lib/canonical.ts.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { generateKeyPairSync, createPrivateKey, createPublicKey, createHash, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import { globsOverlap, globMatchesPath } from '../../../src/lib/claims.ts';
import { ledgerEntryHash, verifyLedgerChain, LEDGER_GENESIS_PREV_HASH } from '../../../src/lib/ledger.ts';
import { canonicalJson, sha256Hex, randomHex } from '../../../src/lib/canonical.ts';
import { safeGit } from '../../../scripts/lib/safe-git.mjs';
import { witnessSignerFromKey } from '../../../scripts/lib/admission.mjs';

// node:sqlite is experimental (Node >= 22.5). Feature-check it so an older or flag-less runtime
// gets a clear error instead of a module-resolution crash. There is no non-SQLite fallback store.
export const SQLITE = await import('node:sqlite').then((m) => ({ ok: true, DatabaseSync: m.DatabaseSync }), (e) => ({ ok: false, error: String(e.message || e) }));
export function requireSqlite() {
  if (!SQLITE.ok) throw new Error(`g4a needs node:sqlite (Node >= 22.5; this is ${process.version}): ${SQLITE.error}`);
  return SQLITE.DatabaseSync;
}

export { globMatchesPath };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY, repo TEXT NOT NULL, agent TEXT NOT NULL, paths TEXT NOT NULL,
  witnesses TEXT NOT NULL, allow_overlap INTEGER NOT NULL, worktree TEXT NOT NULL, branch TEXT NOT NULL,
  baseline TEXT NOT NULL, status TEXT NOT NULL, secret_sha256 TEXT NOT NULL, claimed_at TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS claims_active ON claims(repo, agent) WHERE status = 'active';
CREATE TABLE IF NOT EXISTS ledger (
  repo TEXT NOT NULL, seq INTEGER NOT NULL, ts TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL,
  payload_hash TEXT NOT NULL, prev_hash TEXT NOT NULL, entry_hash TEXT NOT NULL, PRIMARY KEY (repo, seq));
CREATE TABLE IF NOT EXISTS intents (
  repo TEXT NOT NULL, claim TEXT NOT NULL, agent TEXT NOT NULL, witnesses TEXT NOT NULL, frozen_at TEXT NOT NULL,
  PRIMARY KEY (repo, claim));
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, result TEXT, created_at TEXT NOT NULL);
`;

export function openDb(home, { readOnly = false } = {}) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const DatabaseSync = requireSqlite();
  const db = new DatabaseSync(path.join(home, 'g4a.db'), readOnly ? { readOnly: true } : {});
  if (!readOnly) {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;'); db.exec(SCHEMA);
    // additive migrations
    const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    if (!cols('claims').includes('witness_paths')) db.exec("ALTER TABLE claims ADD COLUMN witness_paths TEXT NOT NULL DEFAULT '[]'");
    if (!cols('intents').includes('pins')) db.exec("ALTER TABLE intents ADD COLUMN pins TEXT NOT NULL DEFAULT '{}'");
  }
  return db;
}

export function repoId(repo) {
  // the git common dir identifies the repo across all of its worktrees
  const r = safeGit(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return fs.realpathSync(r.stdout.trim());
}
export function repoTop(repo) {
  const common = repoId(repo);
  return path.basename(common) === '.git' ? path.dirname(common) : common;
}

// The signing key and the external anchor live outside $G4A_HOME (default
// $XDG_CONFIG_HOME/g4a-keys), so copying or rolling back the db does not carry the key or anchor.
export { keyDir } from './lib.mjs';
import { keyDir } from './lib.mjs';
const within = (child, parent) => { const r = path.relative(parent, child); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
export const ANCHOR_REF = 'refs/g4a/ledger-head';
// safe-git denies all transports; the anchor remote may use file:// (tests, other-uid dirs) or ssh
const ANCHOR_PROTO = ['-c', 'protocol.file.allow=always', '-c', 'protocol.ssh.allow=always'];
const ZERO = '0'.repeat(40);
const ANCHOR_ENV = { GIT_AUTHOR_NAME: 'g4a', GIT_AUTHOR_EMAIL: 'g4a@localhost', GIT_COMMITTER_NAME: 'g4a', GIT_COMMITTER_EMAIL: 'g4a@localhost', GIT_AUTHOR_DATE: '1970-01-01T00:00:00Z', GIT_COMMITTER_DATE: '1970-01-01T00:00:00Z' };

export class Authority {
  constructor(home, { keyDir: kd = keyDir() } = {}) {
    this.home = path.resolve(home);
    this.keyDir = path.resolve(kd);
    if (within(this.keyDir, this.home) || within(this.home, this.keyDir)) throw new Error(`key dir ${this.keyDir} must not be inside or contain G4A_HOME ${this.home}`);
    this.db = openDb(home);
    this.lock = Promise.resolve();
    this.keyFile = path.join(this.keyDir, 'witness-ed25519.pem');
    this.ensureKey();
    this.reanchorAll();
  }
  serial(fn) { const p = this.lock.then(fn, fn); this.lock = p.catch(() => {}); return p; }

  // Required witness key: generated locally on first start, 0600, never leaves the box.
  ensureKey() {
    fs.mkdirSync(this.keyDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.keyDir, 0o700);
    const legacy = path.join(this.home, 'witness-ed25519.pem');
    if (!fs.existsSync(this.keyFile) && fs.existsSync(legacy)) fs.renameSync(legacy, this.keyFile); // phase-1 layout
    // Optional: G4A_KEY_PASSPHRASE_FILE encrypts the key at rest (PKCS#8, AES-256-CBC). The
    // passphrase is read once at daemon start; the decrypted key lives only in daemon memory.
    const pf = process.env.G4A_KEY_PASSPHRASE_FILE;
    const passphrase = pf ? fs.readFileSync(pf, 'utf8').replace(/\r?\n$/, '') : undefined;
    if (!fs.existsSync(this.keyFile)) {
      const { privateKey } = generateKeyPairSync('ed25519');
      fs.writeFileSync(this.keyFile, privateKey.export({ type: 'pkcs8', format: 'pem', ...(passphrase ? { cipher: 'aes-256-cbc', passphrase } : {}) }), { mode: 0o600 });
    }
    const pem = fs.readFileSync(this.keyFile, 'utf8');
    this.keyEncrypted = pem.includes('ENCRYPTED');
    if (this.keyEncrypted && !passphrase) throw new Error('witness key is passphrase-protected; set G4A_KEY_PASSPHRASE_FILE');
    const pk = createPrivateKey(this.keyEncrypted ? { key: pem, passphrase } : pem);
    const spki = createPublicKey(pk).export({ type: 'spki', format: 'der' }).toString('hex');
    const pinned = this.db.prepare('SELECT v FROM meta WHERE k = ?').get('witness_pub');
    if (!pinned) this.db.prepare('INSERT INTO meta (k, v) VALUES (?, ?)').run('witness_pub', spki);
    else if (pinned.v !== spki) throw new Error('witness key does not match the pinned public key; refusing to start');
    this.privateKey = pk;
    this.publicKeySpkiHex = spki;
    fs.writeFileSync(path.join(this.keyDir, 'witness-ed25519.pub.hex'), spki + '\n', { mode: 0o644 });
  }
  sign(obj) { return cryptoSign(null, Buffer.from(canonicalJson(obj)), this.privateKey).toString('base64'); }

  // ---- ledger head anchors (outside $G4A_HOME) ----
  // 1) a signed commit chain at refs/g4a/ledger-head in the repo itself;
  // 2) a signed, monotonic file in the key dir. Both only move forward.
  anchorFile(repo) { return path.join(this.keyDir, 'anchors', `${createHash('sha256').update(repo).digest('hex').slice(0, 32)}.json`); }
  assertNotRolledBack(repo, { remote = false } = {}) {
    const head = this.db.prepare('SELECT seq, entry_hash FROM ledger WHERE repo = ? ORDER BY seq DESC LIMIT 1').get(repo);
    const at = (seq) => this.db.prepare('SELECT entry_hash FROM ledger WHERE repo = ? AND seq = ?').get(repo, seq)?.entry_hash;
    const remoteA = remote && process.env.G4A_ANCHOR_REMOTE ? readRemoteAnchor(repo, process.env.G4A_ANCHOR_REMOTE)?.anchor : null;
    for (const a of [readRefAnchor(repo)?.anchor, readFileAnchor(this.anchorFile(repo))?.anchor, remoteA]) {
      if (!a) continue;
      if (!head || a.seq > head.seq) throw new Error(`ledger rollback detected for ${repo}: anchor at seq ${a.seq}, db head ${head ? head.seq : 'empty'}; refusing to write`);
      if (at(a.seq) !== a.entry_hash) throw new Error(`ledger rewrite detected for ${repo} at seq ${a.seq}; refusing to write`);
    }
  }
  writeAnchor(repo, seq, entry_hash) {
    const anchor = { version: 'g4a-anchor/v1', repo, seq, entry_hash, counter: seq + 1, witness_pub: this.publicKeySpkiHex };
    const signature = this.sign(anchor);
    const body = JSON.stringify({ anchor, signature }, null, 2) + '\n';
    // file anchor: write-then-rename; never move backwards
    const f = this.anchorFile(repo);
    const cur = readFileAnchor(f)?.anchor;
    if (!cur || cur.counter < anchor.counter) {
      fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
      fs.writeFileSync(f + '.tmp', body, { mode: 0o600 });
      fs.renameSync(f + '.tmp', f);
    }
    // ref anchor: commit chain, CAS on the previous anchor commit
    const prev = safeGit(repo, ['rev-parse', '--verify', '--quiet', ANCHOR_REF], { allowFailure: true }).stdout.trim();
    const prevA = prev ? readRefAnchor(repo)?.anchor : null;
    if (prevA && prevA.counter >= anchor.counter) return;
    const blob = safeGit(repo, ['hash-object', '-w', '--stdin'], { input: body }).stdout.trim();
    const tree = safeGit(repo, ['mktree'], { input: `100644 blob ${blob}\thead.json\n` }).stdout.trim();
    const commit = safeGit(repo, ['commit-tree', tree, ...(prev ? ['-p', prev] : []), '-m', `g4a ledger head ${seq}`], { env: ANCHOR_ENV }).stdout.trim();
    safeGit(repo, ['update-ref', ANCHOR_REF, commit, prev || ZERO]);
    this.pushAnchorRemote(repo);
  }
  // Optional external witness: push the anchor chain to a separate remote (G4A_ANCHOR_REMOTE).
  // A fast-forward-only remote on another host/uid keeps a copy a local same-uid attacker
  // cannot roll back. Failure is recorded, never fatal (the local anchors still apply).
  pushAnchorRemote(repo) {
    const remote = process.env.G4A_ANCHOR_REMOTE;
    if (!remote) return;
    const r = safeGit(repo, [...ANCHOR_PROTO, 'push', '--quiet', remote, `${ANCHOR_REF}:${ANCHOR_REF}`], { allowFailure: true });
    this.anchorRemoteError = r.status === 0 ? null : (r.stderr.trim().split('\n')[0] || `exit ${r.status}`);
  }
  reanchorAll() {
    for (const { repo } of this.db.prepare('SELECT DISTINCT repo FROM ledger').all()) {
      if (!fs.existsSync(repo)) continue;
      this.assertNotRolledBack(repo, { remote: true });
      const h = this.db.prepare('SELECT seq, entry_hash FROM ledger WHERE repo = ? ORDER BY seq DESC LIMIT 1').get(repo);
      this.writeAnchor(repo, h.seq, h.entry_hash); // catches up after a crash between append and anchor
    }
  }
  async signer() { return witnessSignerFromKey(this.privateKey); }

  // ---- ledger (hash chain from src/lib/ledger.ts) ----
  async appendLedger(repo, kind, payload) {
    this.assertNotRolledBack(repo);
    const head = this.db.prepare('SELECT seq, entry_hash FROM ledger WHERE repo = ? ORDER BY seq DESC LIMIT 1').get(repo);
    const fields = { seq: head ? head.seq + 1 : 0, ts: new Date().toISOString(), kind, payload_hash: await sha256Hex(canonicalJson(payload)), prev_hash: head ? head.entry_hash : LEDGER_GENESIS_PREV_HASH };
    const entry_hash = await ledgerEntryHash(fields, sha256Hex);
    this.db.prepare('INSERT INTO ledger (repo, seq, ts, kind, payload, payload_hash, prev_hash, entry_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(repo, fields.seq, fields.ts, kind, canonicalJson(payload), fields.payload_hash, fields.prev_hash, entry_hash);
    this.writeAnchor(repo, fields.seq, entry_hash);
    return { ...fields, entry_hash };
  }

  activeClaims(repo) {
    return this.db.prepare("SELECT * FROM claims WHERE repo = ? AND status = 'active'").all(repo).map(rowClaim);
  }

  // ---- claims ----
  // Witness-referenced paths: explicit `witnessPaths` globs plus every token of a witness
  // command that names a file tracked on main (e.g. `node check.mjs` -> check.mjs).
  witnessPathsFor(top, witnesses, explicit = []) {
    const tracked = new Set(splitNul(safeGit(top, ['ls-tree', '-r', '--name-only', '-z', 'refs/heads/main']).stdout));
    const found = new Set(explicit);
    // only files a witness EXECUTES (script operand of an interpreter, or the command itself);
    // imports inside `node -e` code are the code under test, not the witness
    for (const cmd of witnesses) {
      const toks = cmd.trim().split(/\s+/);
      const cands = [toks[0]];
      for (let i = 0; i < toks.length; i++) if (/^(node|python3?|sh|bash|deno|bun|ruby|perl)$/.test(path.basename(toks[i]))) {
        let j = i + 1; while (j < toks.length && toks[j].startsWith('-')) { if (/^-(e|c|-eval|p)$/.test(toks[j])) { j = toks.length; break; } j++; }
        if (j < toks.length) cands.push(toks[j]);
      }
      for (const c of cands) { const t = c.replace(/^['"]|['"]$/g, '').replace(/^\.\//, ''); if (tracked.has(t)) found.add(t); }
    }
    return [...found];
  }
  // paths protected for others: frozen intents' pins (any agent but `agent`) + active claims' witness paths
  protectedPaths(repo, agent) {
    const out = [];
    for (const r of this.db.prepare('SELECT agent, pins FROM intents WHERE repo = ?').all(repo)) if (r.agent !== agent) for (const p of Object.keys(JSON.parse(r.pins))) out.push({ owner: r.agent, path: p, frozen: true });
    for (const c of this.activeClaims(repo)) if (c.agent !== agent) for (const p of c.witness_paths) out.push({ owner: c.agent, path: p, frozen: false });
    return out;
  }
  claim({ repo: repoPath, agent, paths, witnesses = [], witnessPaths = [], allowOverlap = false }) {
    return this.serial(async () => {
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(agent || '')) throw new Error('agent must match [A-Za-z0-9._-]{1,64}');
      if (!Array.isArray(paths) || paths.length === 0) throw new Error('claim needs at least one path');
      if (paths.includes('**')) throw new Error('unbounded claim "**" refused');
      const repo = repoId(repoPath), top = repoTop(repoPath);
      const active = this.activeClaims(repo);
      if (active.some((c) => c.agent === agent)) throw new Error(`agent ${agent} already holds an active claim`);
      const overlaps = [];
      for (const c of active) for (const a of paths) for (const b of c.paths) if (globsOverlap(a, b)) overlaps.push({ with: c.agent, path: a, theirs: b });
      // overlap is allowed only when BOTH sides opted in; then it is resolved at promotion
      const refused = overlaps.filter((o) => !allowOverlap || !active.find((c) => c.agent === o.with).allow_overlap);
      if (refused.length) {
        await this.appendLedger(repo, 'claim_refused', { agent, paths, overlaps: refused });
        return { ok: false, refused: 'overlap', overlaps: refused };
      }
      // a claim may not cover files another agent's witnesses depend on (and vice versa)
      const wpaths = this.witnessPathsFor(top, witnesses, witnessPaths);
      const guarded = [];
      for (const pr of this.protectedPaths(repo, agent)) for (const a of paths) if (globsOverlap(a, pr.path)) guarded.push({ with: pr.owner, path: a, witness_path: pr.path, frozen: pr.frozen });
      for (const c of active) for (const w of wpaths) for (const b of c.paths) if (globsOverlap(w, b)) guarded.push({ with: c.agent, witness_path: w, their_claim: b });
      if (guarded.length) {
        await this.appendLedger(repo, 'claim_refused', { agent, paths, reason: 'witness_paths', guarded });
        return { ok: false, refused: 'witness_paths', guarded };
      }
      const baseline = safeGit(top, ['rev-parse', '--verify', 'refs/heads/main^{commit}']).stdout.trim();
      const branch = `g4a/${agent}`;
      const worktree = path.join(top, '.g4a', 'worktrees', agent);
      excludeG4a(top);
      const exists = safeGit(top, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFailure: true }).status === 0;
      if (exists) throw new Error(`branch ${branch} already exists; release and delete it first`);
      safeGit(top, ['worktree', 'add', '--quiet', '-b', branch, worktree, baseline]);
      const id = `c_${randomHex(8)}`;
      const secret = randomHex(32);
      fs.mkdirSync(path.join(this.home, 'secrets'), { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(this.home, 'secrets', id), secret, { mode: 0o600 });
      this.db.prepare('INSERT INTO claims (id, repo, agent, paths, witnesses, allow_overlap, worktree, branch, baseline, status, secret_sha256, claimed_at, witness_paths) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, repo, agent, JSON.stringify(paths), JSON.stringify(witnesses), allowOverlap ? 1 : 0, worktree, branch, baseline, 'active', await sha256Hex(secret), new Date().toISOString(), JSON.stringify(wpaths));
      await this.appendLedger(repo, 'claim', { id, agent, paths, witnesses, witness_paths: wpaths, allowOverlap, baseline, branch, overlaps });
      return { ok: true, id, agent, paths, witness_paths: wpaths, worktree, branch, baseline, overlaps, secretFile: path.join(this.home, 'secrets', id) };
    });
  }

  release({ repo: repoPath, agent, removeWorktree = false }) {
    return this.serial(async () => {
      const repo = repoId(repoPath);
      const c = this.activeClaims(repo).find((x) => x.agent === agent);
      if (!c) return { ok: false, error: `no active claim for ${agent}` };
      this.db.prepare("UPDATE claims SET status = 'released' WHERE id = ?").run(c.id);
      if (removeWorktree) safeGit(repoTop(repoPath), ['worktree', 'remove', '--force', c.worktree], { allowFailure: true });
      await this.appendLedger(repo, 'release', { id: c.id, agent });
      return { ok: true, id: c.id };
    });
  }

  async checkSecret(claim, secret) { return typeof secret === 'string' && (await sha256Hex(secret)) === claim.secret_sha256; }

  status({ repo: repoPath }) {
    const repo = repoId(repoPath);
    const head = this.db.prepare('SELECT seq, entry_hash FROM ledger WHERE repo = ? ORDER BY seq DESC LIMIT 1').get(repo);
    const jobs = this.db.prepare('SELECT id, kind, status, attempts FROM jobs ORDER BY created_at DESC LIMIT 20').all();
    return { repo, claims: this.activeClaims(repo).map(({ secret_sha256, ...c }) => c), ledger: head ? { entries: head.seq + 1, head: head.entry_hash } : { entries: 0 }, jobs };
  }

  // The shim reports every agent opt-out attempt (G4A_RAW / G4A_ENFORCE=0), honored or not.
  optOut({ cwd, argv, vars, honored, override }) {
    return this.serial(async () => {
      let repo; try { repo = repoId(cwd); } catch { return { ok: false }; }
      await this.appendLedger(repo, 'opt_out', { cwd, argv, vars, honored: !!honored, override: override ?? null });
      return { ok: true };
    });
  }

  // Called by the shim before agent write commands inside a g4a worktree.
  check({ cwd, argv }) {
    return this.serial(async () => {
      let wtTop;
      try { wtTop = fs.realpathSync(safeGit(cwd, ['rev-parse', '--show-toplevel']).stdout.trim()); } catch { return { ok: true, managed: false }; }
      const row = this.db.prepare("SELECT * FROM claims WHERE worktree = ? AND status = 'active'").get(wtTop);
      if (!row) {
        let repo;
        try { repo = repoId(cwd); } catch { return { ok: true, managed: false }; }
        const managed = this.db.prepare('SELECT 1 FROM claims WHERE repo = ? LIMIT 1').get(repo);
        if (!managed) return { ok: true, managed: false };
        const sub0 = argv.find((x) => !x.startsWith('-'));
        if (sub0 === 'branch' && !argv.some((x) => /^-[a-zA-Z]*[fdDmMcC]|^--(force|delete|move|copy)/.test(x))) return { ok: true, managed: true, claim: null, warnings: [] };
        const warnings = [`agent write outside a claimed worktree in a g4a-managed repo (${wtTop}); claim paths with \`g4a claim\` and work in .g4a/worktrees/<agent>`];
        await this.appendLedger(repo, 'scope_warning', { claim: null, cwd: wtTop, argv, warnings });
        return { ok: false, managed: true, claim: null, warnings };
      }
      const c = rowClaim(row);
      const sub = argv.find((a) => !a.startsWith('-'));
      const warnings = [];
      if (sub === 'commit') {
        const all = argv.includes('-a') || argv.includes('--all') || argv.some((a) => /^-[a-zA-Z]*a[a-zA-Z]*$/.test(a) && !a.startsWith('--'));
        const files = new Set(splitNul(safeGit(wtTop, ['diff', '--cached', '--name-only', '-z']).stdout));
        if (all) for (const f of splitNul(safeGit(wtTop, ['diff', '--name-only', '-z']).stdout)) files.add(f);
        const out = [...files].filter((f) => !c.paths.some((g) => globMatchesPath(g, f)));
        if (out.length) warnings.push(`commit touches paths outside claim ${c.id} (${c.paths.join(', ')}): ${out.join(', ')}`);
      }
      if (sub === 'push' && argv.some((a) => /(^|:)(refs\/heads\/)?main$/.test(a))) warnings.push('pushing to main bypasses g4a promotion; use `g4a promote`');
      if (sub === 'update-ref' && argv.some((a) => a === 'main' || a === 'refs/heads/main' || a.startsWith('refs/g4a/'))) warnings.push('update-ref on main or refs/g4a/* is reserved to the g4a daemon');
      if (sub === 'branch' && argv.some((a) => /^-(f|M|D|C|-force|-delete)$/.test(a) || /^-[a-zA-Z]*[fMDC]/.test(a)) && argv.includes('main')) warnings.push('moving or deleting main is reserved to the g4a daemon');
      if (['reset', 'rebase', 'checkout', 'switch'].includes(sub) && argv.some((a) => a === 'main' || a.endsWith('/main'))) warnings.push(`${sub} onto main inside a claimed worktree`);
      if (warnings.length) await this.appendLedger(c.repo, 'scope_warning', { claim: c.id, agent: c.agent, argv, warnings });
      return { ok: warnings.length === 0, managed: true, claim: c.id, agent: c.agent, warnings };
    });
  }

  // ---- offline verification ----
  exportBundle(repo) { return bundleFromDb(this.db, repo); }
}

export function bundleFromDb(db, repo) {
  {
    const pub = db.prepare('SELECT v FROM meta WHERE k = ?').get('witness_pub')?.v ?? null;
    const rows = db.prepare('SELECT * FROM ledger WHERE repo = ? ORDER BY seq').all(repo);
    return { version: 'g4a-ledger-bundle/v1', repo, witness_pub: pub, entries: rows.map((r) => ({ seq: r.seq, ts: r.ts, kind: r.kind, payload: JSON.parse(r.payload), payload_hash: r.payload_hash, prev_hash: r.prev_hash, entry_hash: r.entry_hash })) };
  }
}

export function rowClaim(r) { return { ...r, paths: JSON.parse(r.paths), witnesses: JSON.parse(r.witnesses), witness_paths: JSON.parse(r.witness_paths ?? '[]'), allow_overlap: !!r.allow_overlap }; }
export function splitNul(s) { return s.split('\0').filter(Boolean); }

function excludeG4a(top) {
  const f = path.join(safeGit(top, ['rev-parse', '--path-format=absolute', '--git-common-dir']).stdout.trim(), 'info', 'exclude');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const cur = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  if (!cur.split('\n').includes('/.g4a/')) fs.appendFileSync(f, (cur && !cur.endsWith('\n') ? '\n' : '') + '/.g4a/\n');
}

// Offline verify: recompute the chain (src/lib/ledger.ts), every payload hash, and every
// witness signature against the bundle's (or a pinned) Ed25519 public key.
export async function verifyBundle(bundle, { pinnedPub, anchors = [], main } = {}) {
  const errors = [], warnings = [];
  const chain = await verifyLedgerChain(bundle.entries, sha256Hex);
  if (!chain.ok) errors.push(chain.detail);
  for (const e of bundle.entries ?? []) {
    if ((await sha256Hex(canonicalJson(e.payload))) !== e.payload_hash) errors.push(`entry ${e.seq} payload does not match payload_hash`);
  }
  if (pinnedPub && pinnedPub !== bundle.witness_pub) errors.push('bundle witness key differs from the pinned key');
  const pub = createPublicKey({ key: Buffer.from(bundle.witness_pub ?? '', 'hex'), format: 'der', type: 'spki' });
  let promotions = 0;
  for (const e of bundle.entries ?? []) {
    if (e.kind !== 'promote' && e.kind !== 'promote_intent') continue;
    if (e.payload.recovered && !e.payload.witness) { errors.push(`entry ${e.seq} promote without witness`); continue; }
    if (e.kind === 'promote') promotions++;
    const w = e.payload.witness;
    const ok = w && cryptoVerify(null, Buffer.from(canonicalJson(w.report)), pub, Buffer.from(w.signature, 'base64'));
    if (!ok) errors.push(`entry ${e.seq} witness signature invalid`);
    else if (!w.report.results.every((r) => r.exit === 0)) errors.push(`entry ${e.seq} promoted with a failing witness`);
  }
  // anchors: every anchor must be correctly signed and must match the ledger at its seq;
  // an anchor beyond the bundle's last entry means truncation or rollback.
  const bySeq = new Map((bundle.entries ?? []).map((e) => [e.seq, e]));
  const last = bundle.entries?.length ? bundle.entries[bundle.entries.length - 1].seq : -1;
  const checkedAnchors = [];
  for (const { source, anchor, signature, missing } of anchors) {
    if (missing) { if (last >= 0) errors.push(`${source}: anchor missing while the ledger has ${last + 1} entries`); continue; }
    const sigOk = (() => { try { return cryptoVerify(null, Buffer.from(canonicalJson(anchor)), pub, Buffer.from(signature, 'base64')); } catch { return false; } })();
    if (!sigOk) { errors.push(`${source}: anchor signature invalid`); continue; }
    if (anchor.repo !== bundle.repo) { errors.push(`${source}: anchor is for another repo`); continue; }
    if (anchor.seq > last) errors.push(`${source}: ledger truncated or rolled back (anchored head seq ${anchor.seq}, ledger ends at ${last})`);
    else if (bySeq.get(anchor.seq)?.entry_hash !== anchor.entry_hash) errors.push(`${source}: ledger rewritten (entry ${anchor.seq} differs from the anchored hash)`);
    checkedAnchors.push({ source, seq: anchor.seq });
  }
  if (main) {
    const lastMain = [...(bundle.entries ?? [])].reverse().find((e) => e.kind === 'promote' || e.kind === 'main_external');
    const expect = lastMain && (lastMain.payload.main_after ?? lastMain.payload.actual);
    if (expect && expect !== main) warnings.push(`main is ${main} but the last recorded main is ${expect}: main moved outside the g4a daemon since then`);
  }
  return { ok: errors.length === 0, head: chain.ok ? chain.head : null, entries: bundle.entries?.length ?? 0, promotions, anchors: checkedAnchors, errors, warnings };
}

export function readRefAnchor(repo) {
  const r = safeGit(repo, ['cat-file', 'blob', `${ANCHOR_REF}:head.json`], { allowFailure: true });
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}
// every anchor commit on the chain (newest first); counters must strictly decrease
export function readRefAnchorChain(repo) {
  const r = safeGit(repo, ['rev-list', '--first-parent', ANCHOR_REF], { allowFailure: true });
  if (r.status !== 0) return [];
  return r.stdout.trim().split('\n').filter(Boolean).map((c) => {
    const b = safeGit(repo, ['cat-file', 'blob', `${c}:head.json`], { allowFailure: true });
    try { return { commit: c, ...JSON.parse(b.stdout) }; } catch { return { commit: c, anchor: null }; }
  });
}
// Fetch the anchor chain head of an external anchor remote into a scratch bare repo (nothing
// is written into `repo`). null when the remote has no anchor or is unreachable.
export function readRemoteAnchor(repo, remote) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'g4a-anchor-'));
  try {
    safeGit(tmp, ['init', '--quiet', '--bare']);
    const url = /^[a-z][a-z0-9+.-]*:/i.test(remote) || remote.includes('@') ? remote : path.resolve(repo, remote);
    if (safeGit(tmp, [...ANCHOR_PROTO, 'fetch', '--quiet', url, `${ANCHOR_REF}:${ANCHOR_REF}`], { allowFailure: true }).status !== 0) return null;
    return readRefAnchor(tmp);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
export function readFileAnchor(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }

// Collect anchors for offline verification of the ledger of `repo` (a git common dir).
export function collectAnchors(repo, kd = keyDir(), { remote } = {}) {
  const out = [];
  if (remote) { const ra = readRemoteAnchor(repo, remote); out.push(ra ? { source: `remote anchor ${remote}`, ...ra } : { source: `remote anchor ${remote}`, missing: true }); }
  const chain = fs.existsSync(repo) ? readRefAnchorChain(repo) : [];
  if (!chain.length) out.push({ source: `repo ${ANCHOR_REF}`, missing: true });
  let prev = Infinity;
  for (const c of chain) {
    if (!c.anchor || !(c.anchor.counter < prev)) { out.push({ source: `repo ${ANCHOR_REF}@${c.commit.slice(0, 12)}`, anchor: c.anchor ?? {}, signature: '' }); break; }
    prev = c.anchor.counter;
    out.push({ source: `repo ${ANCHOR_REF}@${c.commit.slice(0, 12)}`, anchor: c.anchor, signature: c.signature });
  }
  const f = path.join(kd, 'anchors', `${createHash('sha256').update(repo).digest('hex').slice(0, 32)}.json`);
  const fa = readFileAnchor(f);
  out.push(fa ? { source: `key-dir anchor ${f}`, ...fa } : { source: `key-dir anchor ${f}`, missing: true });
  return out;
}
