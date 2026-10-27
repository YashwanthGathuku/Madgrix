// g4a Phase 1 authority: the local replacement for the Cloudflare Durable Object.
// State lives in SQLite (node:sqlite, WAL). All mutations run through one in-process
// mutex, so claim overlap checks and ledger appends are serialized like a DO.
// Reused Madgrix modules: src/lib/claims.ts (globsOverlap/globMatchesPath),
// src/lib/ledger.ts (ledgerEntryHash/verifyLedgerChain), src/lib/canonical.ts.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { generateKeyPairSync, createPrivateKey, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { globsOverlap, globMatchesPath } from '../../../src/lib/claims.ts';
import { ledgerEntryHash, verifyLedgerChain, LEDGER_GENESIS_PREV_HASH } from '../../../src/lib/ledger.ts';
import { canonicalJson, sha256Hex, randomHex } from '../../../src/lib/canonical.ts';
import { safeGit } from '../../../scripts/lib/safe-git.mjs';
import { witnessSignerFromKey } from '../../../scripts/lib/admission.mjs';

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
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, result TEXT, created_at TEXT NOT NULL);
`;

export function openDb(home, { readOnly = false } = {}) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(home, 'g4a.db'), readOnly ? { readOnly: true } : {});
  if (!readOnly) { db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;'); db.exec(SCHEMA); }
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

export class Authority {
  constructor(home) {
    this.home = home;
    this.db = openDb(home);
    this.lock = Promise.resolve();
    this.keyFile = path.join(home, 'witness-ed25519.pem');
    this.ensureKey();
  }
  serial(fn) { const p = this.lock.then(fn, fn); this.lock = p.catch(() => {}); return p; }

  // Required witness key: generated locally on first start, 0600, never leaves the box.
  ensureKey() {
    if (!fs.existsSync(this.keyFile)) {
      const { privateKey } = generateKeyPairSync('ed25519');
      fs.writeFileSync(this.keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    }
    const pk = createPrivateKey(fs.readFileSync(this.keyFile));
    const spki = createPublicKey(pk).export({ type: 'spki', format: 'der' }).toString('hex');
    const pinned = this.db.prepare('SELECT v FROM meta WHERE k = ?').get('witness_pub');
    if (!pinned) this.db.prepare('INSERT INTO meta (k, v) VALUES (?, ?)').run('witness_pub', spki);
    else if (pinned.v !== spki) throw new Error('witness key does not match the pinned public key; refusing to start');
    this.privateKey = pk;
    this.publicKeySpkiHex = spki;
  }
  async signer() { return witnessSignerFromKey(this.privateKey); }

  // ---- ledger (hash chain from src/lib/ledger.ts) ----
  async appendLedger(repo, kind, payload) {
    const head = this.db.prepare('SELECT seq, entry_hash FROM ledger WHERE repo = ? ORDER BY seq DESC LIMIT 1').get(repo);
    const fields = { seq: head ? head.seq + 1 : 0, ts: new Date().toISOString(), kind, payload_hash: await sha256Hex(canonicalJson(payload)), prev_hash: head ? head.entry_hash : LEDGER_GENESIS_PREV_HASH };
    const entry_hash = await ledgerEntryHash(fields, sha256Hex);
    this.db.prepare('INSERT INTO ledger (repo, seq, ts, kind, payload, payload_hash, prev_hash, entry_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(repo, fields.seq, fields.ts, kind, canonicalJson(payload), fields.payload_hash, fields.prev_hash, entry_hash);
    return { ...fields, entry_hash };
  }

  activeClaims(repo) {
    return this.db.prepare("SELECT * FROM claims WHERE repo = ? AND status = 'active'").all(repo).map(rowClaim);
  }

  // ---- claims ----
  claim({ repo: repoPath, agent, paths, witnesses = [], allowOverlap = false }) {
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
      this.db.prepare('INSERT INTO claims (id, repo, agent, paths, witnesses, allow_overlap, worktree, branch, baseline, status, secret_sha256, claimed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, repo, agent, JSON.stringify(paths), JSON.stringify(witnesses), allowOverlap ? 1 : 0, worktree, branch, baseline, 'active', await sha256Hex(secret), new Date().toISOString());
      await this.appendLedger(repo, 'claim', { id, agent, paths, witnesses, allowOverlap, baseline, branch, overlaps });
      return { ok: true, id, agent, paths, worktree, branch, baseline, overlaps, secretFile: path.join(this.home, 'secrets', id) };
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

  // Called by the shim before agent write commands inside a g4a worktree.
  check({ cwd, argv }) {
    return this.serial(async () => {
      let wtTop;
      try { wtTop = fs.realpathSync(safeGit(cwd, ['rev-parse', '--show-toplevel']).stdout.trim()); } catch { return { ok: true, managed: false }; }
      const row = this.db.prepare("SELECT * FROM claims WHERE worktree = ? AND status = 'active'").get(wtTop);
      if (!row) return { ok: true, managed: false };
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

export function rowClaim(r) { return { ...r, paths: JSON.parse(r.paths), witnesses: JSON.parse(r.witnesses), allow_overlap: !!r.allow_overlap }; }
export function splitNul(s) { return s.split('\0').filter(Boolean); }

function excludeG4a(top) {
  const f = path.join(safeGit(top, ['rev-parse', '--path-format=absolute', '--git-common-dir']).stdout.trim(), 'info', 'exclude');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const cur = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  if (!cur.split('\n').includes('/.g4a/')) fs.appendFileSync(f, (cur && !cur.endsWith('\n') ? '\n' : '') + '/.g4a/\n');
}

// Offline verify: recompute the chain (src/lib/ledger.ts), every payload hash, and every
// witness signature against the bundle's (or a pinned) Ed25519 public key.
export async function verifyBundle(bundle, { pinnedPub } = {}) {
  const errors = [];
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
    if (e.kind === 'promote') promotions++;
    const w = e.payload.witness;
    const ok = w && cryptoVerify(null, Buffer.from(canonicalJson(w.report)), pub, Buffer.from(w.signature, 'base64'));
    if (!ok) errors.push(`entry ${e.seq} witness signature invalid`);
    else if (!w.report.results.every((r) => r.exit === 0)) errors.push(`entry ${e.seq} promoted with a failing witness`);
  }
  return { ok: errors.length === 0, head: chain.ok ? chain.head : null, entries: bundle.entries?.length ?? 0, promotions, errors };
}
