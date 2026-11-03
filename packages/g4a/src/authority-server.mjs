// Long-running same-user authority server (opt-out: G4A_AUTHORITY_SERVER=0).
// Same commands and checks as one `authority-service.mjs` process per call (signed one-time permits,
// exact reviewed SHA, ledger chain + anchors, claim scope, agent credentials), minus the per-call
// node boot, key load and anchor re-check. Access: R/run/ is 0700 and the socket 0600 (only the
// authority uid can connect); each request carries a 256-bit server token (R/run/token, 0600,
// rotated on every start) and a fresh 128-bit request id (replays refused). Only the agent-facing
// commands are served; operator, OS-identity and init commands stay on the per-call path.
// System mode is refused: Node has no SO_PEERCRED, so the server could not learn the caller uid
// that identity binding needs; the sudo wrappers keep that path.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { layout, run, shareAuthority } from './authority-service.mjs';
import { redact } from './privacy.mjs';

export const SERVE_CMDS = new Set(['pubinfo', 'claim', 'permit', 'land', 'release', 'status', 'ledger', 'audit']);
export const MAX_LINE = 1 << 20;
const ID_RE = /^[0-9a-f]{32}$/;
export const runDir = (root) => path.join(path.resolve(root), 'run');

function privateRunDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${dir} is not a directory`);
  if (st.uid !== process.getuid()) throw new Error(`${dir} is owned by another user`);
  if (st.mode & 0o077) fs.chmodSync(dir, 0o700);
}

export async function serve(root, { idleMs = Number(process.env.G4A_SERVE_IDLE_MS) || 300_000 } = {}) {
  let L = layout(root);
  const conf = JSON.parse(fs.readFileSync(L.conf, 'utf8'));
  L = layout(root, conf.pub);
  if (conf.mode === 'system') throw new Error('authority server is same-user only (system mode keeps the sudo path: no peer credentials in Node)');
  const dir = runDir(L.root), sock = path.join(dir, 'a.sock'), tokFile = path.join(dir, 'token');
  privateRunDir(dir);
  if (fs.existsSync(sock)) {
    const alive = await new Promise((res) => { const c = net.connect(sock); c.on('connect', () => { c.destroy(); res(true); }); c.on('error', () => res(false)); });
    if (alive) return { ok: true, already: true, sock };
    fs.rmSync(sock, { force: true });
  }
  shareAuthority(L);
  const token = randomBytes(32);
  const tmp = `${tokFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, token.toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, tokFile);
  const seen = new Set();
  let idle = null;
  const bump = () => { clearTimeout(idle); idle = setTimeout(stop, idleMs); idle.unref?.(); };
  let inflight = 0;
  const server = net.createServer((conn) => {
    let buf = '';
    conn.setEncoding('utf8');
    conn.on('data', (d) => {
      buf += d;
      if (buf.length > MAX_LINE) { conn.end(JSON.stringify({ error: 'request too large' }) + '\n'); buf = ''; return; }
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        handle(line).then((reply) => { if (!conn.destroyed) conn.write(JSON.stringify(reply) + '\n'); });
      }
    });
    conn.on('error', () => {});
  });
  async function handle(line) {
    bump();
    let req;
    try { req = JSON.parse(line); } catch { return { error: 'bad json' }; }
    if (!req || typeof req !== 'object' || Array.isArray(req)) return { error: 'bad request' };
    const id = typeof req.id === 'string' && ID_RE.test(req.id) ? req.id : null;
    const t = typeof req.token === 'string' && /^[0-9a-f]{64}$/.test(req.token) ? Buffer.from(req.token, 'hex') : null;
    if (!t || !timingSafeEqual(t, token)) return { id, error: 'unauthorized' };
    if (!id) return { error: 'bad request id' };
    if (seen.has(id)) return { id, error: 'replayed request id' };
    seen.add(id); if (seen.size > 200_000) seen.delete(seen.values().next().value);
    if (typeof req.cmd !== 'string' || !SERVE_CMDS.has(req.cmd)) return { id, error: 'command not served' };
    const p = req.p ?? {};
    if (typeof p !== 'object' || Array.isArray(p) || p === null) return { id, error: 'bad params' };
    inflight++;
    try { return { id, r: await run(L, req.cmd, { ...p }) }; }
    catch (e) { return { id, r: { ok: false, error: redact(String(e.message || e)) } }; }
    finally { inflight--; bump(); }
  }
  function stop() {
    if (inflight) return bump();
    server.close();
    try { if (fs.readFileSync(tokFile, 'utf8').trim() === token.toString('hex')) fs.rmSync(tokFile, { force: true }); } catch {}
    fs.rmSync(sock, { force: true });
    process.exit(0);
  }
  // exit when the authority root goes away (temp roots in tests/bench)
  setInterval(() => { if (!fs.existsSync(L.conf)) stop(); }, 2000).unref();
  const old = process.umask(0o177);
  try { await new Promise((res, rej) => server.listen(sock, res).on('error', rej)); } finally { process.umask(old); }
  fs.chmodSync(sock, 0o600);
  bump();
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { server.close(); fs.rmSync(sock, { force: true }); process.exit(0); });
  return { ok: true, sock, pid: process.pid };
}

// client: one request over the socket; null when no server is reachable (caller falls back)
export function request(root, cmd, p, { timeoutMs = 900_000 } = {}) {
  const dir = runDir(root);
  let token;
  try {
    const st = fs.lstatSync(dir);
    if (!st.isDirectory() || st.uid !== process.getuid() || (st.mode & 0o077)) return Promise.resolve(null);
    token = fs.readFileSync(path.join(dir, 'token'), 'utf8').trim();
  } catch { return Promise.resolve(null); }
  const id = randomBytes(16).toString('hex');
  return new Promise((resolve) => {
    const c = net.connect(path.join(dir, 'a.sock'));
    let buf = '', sent = false;
    const t = setTimeout(() => { c.destroy(); resolve({ ok: false, error: 'authority server timed out' }); }, timeoutMs);
    c.setEncoding('utf8');
    c.on('connect', () => { sent = true; c.write(JSON.stringify({ id, token, cmd, p }) + '\n'); });
    c.on('data', (d) => {
      buf += d; const i = buf.indexOf('\n'); if (i < 0) return;
      clearTimeout(t); c.end();
      let m; try { m = JSON.parse(buf.slice(0, i)); } catch { return resolve({ ok: false, error: 'bad authority server reply' }); }
      if (m.id !== id) return resolve({ ok: false, error: 'authority server reply id mismatch' });
      resolve(m.error ? (m.error === 'unauthorized' ? null : { ok: false, error: m.error }) : m.r);
    });
    c.on('error', () => { clearTimeout(t); resolve(sent ? { ok: false, error: 'authority server connection failed' } : null); });
    c.on('close', () => { clearTimeout(t); resolve(sent ? { ok: false, error: 'authority server closed the connection' } : null); });
  });
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--root');
  serve(process.argv[i + 1]).then((r) => { if (r.already) process.exit(0); if (process.send) process.send(r); else process.stdout.write(JSON.stringify(r) + '\n'); },
    (e) => { process.stdout.write(JSON.stringify({ ok: false, error: redact(String(e.message || e)) }) + '\n'); process.exit(1); });
}
