// g4a daemon: per-user unix socket (0600 in a 0700 dir), single writer over SQLite,
// in-daemon job loop (replaces Cloudflare Queues/Workflows). Survives kill -9:
// claims/ledger/jobs are in SQLite (WAL, synchronous=FULL); running jobs are requeued at start.
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Authority, repoId, rowClaim } from './authority.mjs';
import { promote } from './promote.mjs';
import { promoteViaAuthority } from './promote-authority.mjs';
import { locate, call, clientAnchorRemote, fetchMain } from './authority-client.mjs';
import { safeGit } from '../../../scripts/lib/safe-git.mjs';
import { randomHex } from '../../../src/lib/canonical.ts';
import { g4aHome } from './lib.mjs';

export const socketPath = (home = g4aHome()) => path.join(home, 'g4a.sock');

// opts.hooks: test-only promotion hooks (see test/fixtures/crash-daemon.mjs); never set by the CLI.
export async function startDaemon(home = g4aHome(), { hooks = {}, keyDir } = {}) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.chmodSync(home, 0o700);
  // control-plane git must reach the real git, never the shim
  process.env.PATH = (process.env.PATH || '').split(':').filter((d) => path.resolve(d) !== path.resolve(home, 'bin')).join(':');
  const sock = socketPath(home);
  if (fs.existsSync(sock)) {
    const alive = await new Promise((res) => { const c = net.connect(sock, () => { c.end(); res(true); }); c.on('error', () => res(false)); });
    if (alive) throw new Error(`g4a daemon already running on ${sock}`);
    fs.rmSync(sock, { force: true }); // stale socket from a crashed daemon
  }
  const auth = new Authority(home, { ...(keyDir ? { keyDir } : {}), anchorRemote: (repo) => { const l = locate(repo); return l && clientAnchorRemote(l); } });
  const requeued = auth.db.prepare("UPDATE jobs SET status = 'queued' WHERE status = 'running'").run().changes;
  const bus = new EventEmitter();
  // Per-repo job queues: one worker per repo (promotions in a repo stay serialized so CAS and
  // frozen-intent order are deterministic); different repos run in parallel. Witnesses run in
  // a child process, so the event loop is free while one repo's witnesses execute.
  const workers = new Map(); // repo -> Promise
  const jobRepo = (job) => {
    try { const row = auth.db.prepare('SELECT repo FROM claims WHERE id = ?').get(JSON.parse(job.payload).claimId); return row?.repo ?? '?'; } catch { return '?'; }
  };
  async function runJob(job) {
    auth.db.prepare("UPDATE jobs SET status = 'running', attempts = attempts + 1 WHERE id = ?").run(job.id);
    let result;
    try {
      const { claimId } = JSON.parse(job.payload);
      const row = auth.db.prepare('SELECT * FROM claims WHERE id = ?').get(claimId);
      if (!row) result = { ok: false, status: 'refused', reason: 'claim not found' };
      else {
        const loc = locate(row.worktree);
        // default path: through the authority. Local landing is test-only (phase-1 fixtures).
        if (loc) result = await promoteViaAuthority(auth, rowClaim(row), job.id, loc);
        else if (process.env.G4A_LOCAL_LAND === '1') result = await promote(auth, rowClaim(row), job.id, hooks);
        else result = { ok: false, status: 'refused', reason: 'no_authority', hint: 'run `g4a authority init --system` (or `g4a authority init DIR`, same-user detect-only) for this repo' };
      }
    } catch (e) { result = { ok: false, status: 'error', error: String(e.message || e) }; }
    auth.db.prepare("UPDATE jobs SET status = 'done', result = ? WHERE id = ?").run(JSON.stringify(result), job.id);
    bus.emit(job.id, result);
  }
  function loop() {
    const queued = auth.db.prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at, id").all();
    for (const job of queued) {
      const repo = jobRepo(job);
      if (workers.has(repo)) continue;
      const w = (async () => {
        try {
          for (let j = job; j; ) {
            await runJob(j);
            j = auth.db.prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at, id").all().find((x) => jobRepo(x) === repo);
          }
        } finally { workers.delete(repo); }
      })();
      workers.set(repo, w);
    }
  }

  const methods = {
    ping: () => ({ ok: true, pid: process.pid, requeued }),
    claim: async (p) => {
      const loc = locate(p.repo);
      if (!loc) return auth.claim(p);
      // the authority decides first (overlap / witness-path guards on ITS claims); local mirrors
      const local = safeGit(p.repo, ['rev-parse', '--verify', '--quiet', 'refs/heads/main'], { allowFailure: true }).stdout.trim();
      const amain = fetchMain(loc, p.repo);
      if (local !== amain) return { ok: false, refused: 'main_out_of_sync', local, authority: amain };
      const a = call(loc, 'claim', { agent: p.agent, paths: p.paths, witnesses: p.witnesses, witnessPaths: p.witnessPaths, allowOverlap: p.allowOverlap });
      if (!a.ok) return { ...a, via: `authority:${loc.mode}` };
      try { const r = await auth.claim(p); if (!r.ok) call(loc, 'release', { agent: p.agent }); return { ...r, authority: { mode: loc.mode, claim: a.id } }; }
      catch (e) { call(loc, 'release', { agent: p.agent }); throw e; }
    },
    release: async (p) => {
      const r = await auth.release(p);
      const loc = locate(p.repo);
      if (loc) r.authority = call(loc, 'release', { agent: p.agent });
      return r;
    },
    status: (p) => auth.status(p),
    check: (p) => auth.check(p),
    opt_out: (p) => auth.optOut(p),
    export: (p) => auth.exportBundle(repoId(p.repo)),
    job: (p) => { const j = auth.db.prepare('SELECT id, status, attempts, result FROM jobs WHERE id = ?').get(p.id); return j ? { ...j, result: j.result && JSON.parse(j.result) } : null; },
    promote: async (p) => {
      const repo = repoId(p.repo);
      const row = auth.db.prepare("SELECT * FROM claims WHERE repo = ? AND agent = ? AND status = 'active'").get(repo, p.agent);
      if (!row) return { ok: false, status: 'refused', reason: `no active claim for ${p.agent}` };
      if (!(await auth.checkSecret(row, p.secret))) return { ok: false, status: 'refused', reason: 'agent secret does not match the claim' };
      const id = p.jobId || `j_${Date.now().toString(36)}_${randomHex(4)}`;
      auth.db.prepare('INSERT INTO jobs (id, kind, payload, status, created_at) VALUES (?, ?, ?, ?, ?)').run(id, 'promote', JSON.stringify({ claimId: row.id }), 'queued', new Date().toISOString());
      const done = new Promise((res) => bus.once(id, res));
      setImmediate(loop);
      return p.wait === false ? { ok: true, status: 'queued', job: id } : { job: id, ...(await done) };
    },
    shutdown: () => { setImmediate(() => { server.close(); fs.rmSync(sock, { force: true }); process.exit(0); }); return { ok: true }; },
  };

  const server = net.createServer((conn) => {
    let buf = '';
    conn.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let req;
        try { req = JSON.parse(line); } catch { conn.write(JSON.stringify({ error: 'bad json' }) + '\n'); continue; }
        Promise.resolve().then(() => {
          const m = methods[req.method];
          if (!m) throw new Error(`unknown method ${req.method}`);
          return m(req.params || {});
        }).then((result) => conn.write(JSON.stringify({ id: req.id, result }) + '\n'), (e) => conn.write(JSON.stringify({ id: req.id, error: String(e.message || e) }) + '\n'))
          .catch(() => {});
      }
    });
    conn.on('error', () => {});
  });
  const old = process.umask(0o177);
  await new Promise((res, rej) => server.listen(sock, res).on('error', rej));
  process.umask(old);
  fs.chmodSync(sock, 0o600);
  fs.writeFileSync(path.join(home, 'g4a.pid'), String(process.pid));
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { server.close(); fs.rmSync(sock, { force: true }); process.exit(0); });
  setImmediate(loop); // resume requeued jobs
  return { server, auth, sock, requeued };
}

export function rpc(method, params = {}, { home = g4aHome(), timeoutMs = 600_000 } = {}) {
  return new Promise((resolve, reject) => {
    const c = net.connect(socketPath(home));
    let buf = '';
    const t = setTimeout(() => { c.destroy(); reject(new Error('g4a daemon timed out')); }, timeoutMs);
    c.on('connect', () => c.write(JSON.stringify({ id: 1, method, params }) + '\n'));
    c.on('data', (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      clearTimeout(t); c.end();
      const r = JSON.parse(buf.slice(0, i));
      r.error ? reject(new Error(r.error)) : resolve(r.result);
    });
    c.on('error', (e) => { clearTimeout(t); reject(e); });
    c.on('close', () => { clearTimeout(t); reject(new Error('g4a daemon closed the connection')); }); // no-op if already settled
  });
}
