// Long-running authority server (opt-out: G4A_AUTHORITY_SERVER=0).
// Same commands and checks as one `authority-service.mjs` process per call (signed one-time permits,
// exact reviewed SHA, ledger chain + anchors, claim scope, agent credentials), minus the per-call
// node boot, key load and anchor re-check. Only the agent-facing commands are served; operator,
// OS-identity and init commands stay on the per-call path.
// Same-user mode: R/run/ is 0700 and the socket 0600 (only the authority uid can connect); each
// request carries a 256-bit server token (R/run/token, 0600, rotated on every start) and a fresh
// 128-bit request id (replays refused).
// System mode (runs as g4a-authority, started via the root-owned `g4a-authority <id> serve`
// wrapper): the socket PUB/<id>/run/s.sock is owned by peer-gate.py, a stdlib-only Python helper
// that reads each connection's kernel peer uid (SO_PEERCRED) and hands it to this process over a
// private pipe. That uid replaces SUDO_UID as the caller identity (uid binding + agent credential
// checks unchanged); nothing in the request can set it. No token: any local uid may connect, as any
// uid may run the sudo wrapper, and is then identified by the kernel.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { layout, run, shareAuthority, peerCtx } from './authority-service.mjs';
import { redact } from './privacy.mjs';

export const SERVE_CMDS = new Set(['pubinfo', 'claim', 'permit', 'land', 'release', 'status', 'ledger', 'audit']);
export const MAX_LINE = 1 << 20;
const ID_RE = /^[0-9a-f]{32}$/;
export const runDir = (root) => path.join(path.resolve(root), 'run');
export const sysSock = (pub) => path.join(path.resolve(pub), 'run', 's.sock');
const GATE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'peer-gate.py');

function privateRunDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${dir} is not a directory`);
  if (st.uid !== process.getuid()) throw new Error(`${dir} is owned by another user`);
  if (st.mode & 0o077) fs.chmodSync(dir, 0o700);
}

export async function serve(root, { idleMs = Number(process.env.G4A_SERVE_IDLE_MS) || 300_000, system = false, pub } = {}) {
  let L = layout(root, pub);
  const conf = JSON.parse(fs.readFileSync(L.conf, 'utf8'));
  if (!system) L = layout(root, conf.pub);
  if ((conf.mode === 'system') !== system) throw new Error(system ? 'not a system-mode authority' : 'system-mode authority: use the g4a-authority serve wrapper');
  if (system) return serveSystem(L, idleMs);
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
    bump(); inflight++;
    try { return await dispatch(L, line, { token, seen }); } finally { inflight--; bump(); }
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
  fs.writeFileSync(path.join(dir, 'pid'), String(process.pid), { mode: 0o600 });
  bump();
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { server.close(); fs.rmSync(sock, { force: true }); fs.rmSync(path.join(dir, 'pid'), { force: true }); process.exit(0); });
  return { ok: true, sock, pid: process.pid };
}

// one request line -> reply. token: same-user mode (256-bit, constant-time compare); uid: system mode
// (kernel peer uid from peer-gate.py, runs the command with it as the caller identity).
async function dispatch(L, line, { token = null, uid = null, seen }) {
  let req;
  try { req = JSON.parse(line); } catch { return { error: 'bad json' }; }
  if (!req || typeof req !== 'object' || Array.isArray(req)) return { error: 'bad request' };
  const id = typeof req.id === 'string' && ID_RE.test(req.id) ? req.id : null;
  if (token) {
    const t = typeof req.token === 'string' && /^[0-9a-f]{64}$/.test(req.token) ? Buffer.from(req.token, 'hex') : null;
    if (!t || !timingSafeEqual(t, token)) return { id, error: 'unauthorized' };
  } else if (!Number.isInteger(uid) || uid < 0) return { id, error: 'unauthorized' };
  if (!id) return { error: 'bad request id' };
  const key = token ? id : `${uid}:${id}`;
  if (seen.has(key)) return { id, error: 'replayed request id' };
  seen.add(key); if (seen.size > 200_000) seen.delete(seen.values().next().value);
  if (typeof req.cmd !== 'string' || !SERVE_CMDS.has(req.cmd)) return { id, error: 'command not served' };
  const p = req.p ?? {};
  if (typeof p !== 'object' || Array.isArray(p) || p === null) return { id, error: 'bad params' };
  const exec = () => run(L, req.cmd, { ...p });
  try { return { id, r: await (token ? exec() : peerCtx.run({ uid }, exec)) }; }
  catch (e) { return { id, r: { ok: false, error: redact(String(e.message || e)) } }; }
}

async function serveSystem(L, idleMs) {
  if (process.getuid() === 0) throw new Error('system authority server must run as the authority user, not root');
  const sock = sysSock(L.pub), dir = path.dirname(sock);
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid()) throw new Error(`${dir}: not an authority-owned directory`);
  fs.chmodSync(dir, 0o755);
  const lockDir = path.join(dir, 'serve.d');
  try { fs.mkdirSync(lockDir, { mode: 0o700 }); } catch {
    // another server holds it unless its pid is gone
    let pid = 0; try { pid = Number(fs.readFileSync(path.join(lockDir, 'pid'), 'utf8')); } catch {}
    let alive = false; try { if (pid) { process.kill(pid, 0); alive = true; } } catch {}
    if (alive) return { ok: true, already: true, sock };
    fs.rmSync(lockDir, { recursive: true, force: true }); fs.mkdirSync(lockDir, { mode: 0o700 });
  }
  fs.writeFileSync(path.join(lockDir, 'pid'), String(process.pid));
  fs.rmSync(sock, { force: true });
  shareAuthority(L);
  // the scrubbed env from the wrapper; -I -S: isolated, no site / user dirs / PYTHON* env
  const gate = spawn('/usr/bin/python3', ['-I', '-S', GATE, sock], { stdio: ['pipe', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } });
  const seen = new Set();
  let inflight = 0, idle = null, buf = '';
  const stop = () => {
    if (inflight) return bump();
    try { gate.kill(); } catch {}
    fs.rmSync(sock, { force: true }); fs.rmSync(lockDir, { recursive: true, force: true });
    process.exit(0);
  };
  const bump = () => { clearTimeout(idle); idle = setTimeout(stop, idleMs); };
  const ready = new Promise((res, rej) => { gate.on('exit', (c) => rej(new Error(`peer gate exited (${c})`))); gate.stdout.once('data', () => res()); });
  gate.stdout.setEncoding('utf8');
  gate.stdout.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const raw = buf.slice(0, i); buf = buf.slice(i + 1);
      let m; try { m = JSON.parse(raw); } catch { continue; }
      if (m.ready || !Number.isInteger(m.c)) continue;
      bump(); inflight++;
      dispatch(L, String(m.line ?? ''), { uid: m.uid, seen }).then((reply) => {
        inflight--; bump();
        gate.stdin.write(JSON.stringify({ c: m.c, reply: JSON.stringify(reply) }) + '\n');
      });
    }
  });
  gate.stdin.on('error', () => {});
  gate.on('exit', () => { fs.rmSync(lockDir, { recursive: true, force: true }); process.exit(1); });
  await ready;
  setInterval(() => { if (!fs.existsSync(L.conf)) { inflight = 0; stop(); } }, 2000).unref();
  for (const sg of ['SIGINT', 'SIGTERM']) process.on(sg, () => { inflight = 0; stop(); });
  bump();
  return { ok: true, sock, pid: process.pid, system: true };
}

// pid of the live server for this authority, or 0. Only a process whose argv is this server file
// with this exact --root is accepted (a recycled or planted pid is never signalled).
export function serverPid(root, { system = false, pub } = {}) {
  const f = system ? path.join(path.dirname(sysSock(pub)), 'serve.d', 'pid') : path.join(runDir(root), 'pid');
  let pid = 0; try { pid = Number(fs.readFileSync(f, 'utf8').trim()); } catch { return 0; }
  if (!Number.isInteger(pid) || pid <= 1) return 0;
  let argv; try { argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0'); } catch { return 0; }
  const me = fileURLToPath(import.meta.url), i = argv.indexOf('--root');
  return argv.includes(me) && i > 0 && path.resolve(argv[i + 1] ?? '') === path.resolve(root) && argv.includes('--fg') === system ? pid : 0;
}
export async function stopServer(root, opts = {}) {
  const pid = serverPid(root, opts);
  if (!pid) return { ok: true, running: false };
  try { process.kill(pid, 'SIGTERM'); } catch (e) { return { ok: false, error: `cannot stop server pid ${pid}: ${e.code}` }; }
  for (let i = 0; i < 50; i++) { try { process.kill(pid, 0); } catch { return { ok: true, stopped: pid }; } await new Promise((r) => setTimeout(r, 100)); }
  return { ok: false, error: `server pid ${pid} did not exit` };
}

// client: one request over the socket; null when no server is reachable (caller falls back)
// system: { pub } of a system-mode authority (socket PUB/<id>/run/s.sock, kernel peer uid, no token)
export function request(root, cmd, p, { timeoutMs = 900_000, system = false, pub } = {}) {
  let token, sockPath;
  try {
    if (system) {
      sockPath = sysSock(pub);
      const owner = fs.statSync(pub).uid, d = fs.lstatSync(path.dirname(sockPath)), s = fs.lstatSync(sockPath);
      // the socket must be the authority user's (an attacker-planted socket would collect permits/credentials)
      if (!d.isDirectory() || d.uid !== owner || (d.mode & 0o022) || !s.isSocket() || s.uid !== owner || owner === process.getuid()) return Promise.resolve(null);
    } else {
      const dir = runDir(root);
      const st = fs.lstatSync(dir);
      if (!st.isDirectory() || st.uid !== process.getuid() || (st.mode & 0o077)) return Promise.resolve(null);
      token = fs.readFileSync(path.join(dir, 'token'), 'utf8').trim();
      sockPath = path.join(dir, 'a.sock');
    }
  } catch { return Promise.resolve(null); }
  const id = randomBytes(16).toString('hex');
  return new Promise((resolve) => {
    const c = net.connect(sockPath);
    let buf = '', sent = false;
    const t = setTimeout(() => { c.destroy(); resolve({ ok: false, error: 'authority server timed out' }); }, timeoutMs);
    c.setEncoding('utf8');
    c.on('connect', () => { sent = true; c.write(JSON.stringify(token ? { id, token, cmd, p } : { id, cmd, p }) + '\n'); });
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
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
  const system = process.argv.includes('--system');
  const root = arg('--root'), pub = arg('--pub');
  if (process.argv.includes('--stop')) stopServer(root, { system, pub }).then((r) => { process.stdout.write(JSON.stringify(r) + '\n'); process.exit(r.ok ? 0 : 1); });
  else if (process.argv.includes('--status')) { const pid = serverPid(root, { system, pub }); process.stdout.write(JSON.stringify({ ok: true, running: !!pid, pid: pid || null }) + '\n'); }
  else if (system && !process.argv.includes('--fg')) {
    // detach from the caller's sudo session (whose monitor keeps the caller uid alive, which would
    // block that agent user's removal): re-exec in a new session, wait until the socket is up, exit
    const ch = spawn(process.execPath, ['--no-warnings', fileURLToPath(import.meta.url), ...process.argv.slice(2), '--fg'], { detached: true, stdio: 'ignore', cwd: '/' });
    ch.unref();
    const sock = sysSock(arg('--pub'));
    const t0 = Date.now();
    const wait = () => (fs.existsSync(sock) || Date.now() - t0 > 5000 ? process.exit(0) : setTimeout(wait, 50));
    wait();
  } else serve(arg('--root'), { system, pub: arg('--pub') }).then((r) => { if (r.already) process.exit(0); if (process.send) process.send(r); else process.stdout.write(JSON.stringify(r) + '\n'); },
    (e) => { process.stdout.write(JSON.stringify({ ok: false, error: redact(String(e.message || e)) }) + '\n'); process.exit(1); });
}
