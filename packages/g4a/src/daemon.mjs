// g4a daemon: per-user unix socket (0600 in a 0700 dir), single writer over SQLite,
// in-daemon job loop (replaces Cloudflare Queues/Workflows). Survives kill -9:
// claims/ledger/jobs are in SQLite (WAL, synchronous=FULL); running jobs are requeued at start.
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Authority, repoId, rowClaim } from './authority.mjs';
import { promote } from './promote.mjs';
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
  const auth = new Authority(home, keyDir ? { keyDir } : {});
  const requeued = auth.db.prepare("UPDATE jobs SET status = 'queued' WHERE status = 'running'").run().changes;
  const bus = new EventEmitter();
  let busy = false;

  async function loop() {
    if (busy) return;
    busy = true;
    try {
      for (;;) {
        const job = auth.db.prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at, id LIMIT 1").get();
        if (!job) break;
        auth.db.prepare("UPDATE jobs SET status = 'running', attempts = attempts + 1 WHERE id = ?").run(job.id);
        let result;
        try {
          const { claimId } = JSON.parse(job.payload);
          const row = auth.db.prepare('SELECT * FROM claims WHERE id = ?').get(claimId);
          result = row ? await promote(auth, rowClaim(row), job.id, hooks) : { ok: false, status: 'refused', reason: 'claim not found' };
        } catch (e) { result = { ok: false, status: 'error', error: String(e.message || e) }; }
        auth.db.prepare("UPDATE jobs SET status = 'done', result = ? WHERE id = ?").run(JSON.stringify(result), job.id);
        bus.emit(job.id, result);
      }
    } finally { busy = false; }
  }

  const methods = {
    ping: () => ({ ok: true, pid: process.pid, requeued }),
    claim: (p) => auth.claim(p),
    release: (p) => auth.release(p),
    status: (p) => auth.status(p),
    check: (p) => auth.check(p),
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
