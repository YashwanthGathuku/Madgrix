// Local credential proxy (system mode). Agent API keys granted with `g4a agent key` for a known
// provider are stored ONLY here, under /var/lib/g4a-cred (0700, user g4a-cred), never in the
// agent's home or environment. The agent gets a dummy key plus a base URL pointing at
//   http://127.0.0.1:<port>/g4a/<agent>/<token>/<VAR>/...
// and this proxy forwards to the provider's fixed https origin, injecting the real key. Programs
// the agent starts can use the proxy (same as the agent) but can never read or exfiltrate the key.
// The token only works on this machine and only for that agent's granted providers.
// No LLM, no telemetry: the proxy keeps a per-agent request counter and nothing else.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const CRED_USER = 'g4a-cred', CRED_HOME = '/var/lib/g4a-cred', CRED_CONF = '/etc/g4a/credproxy.json';
export const DEFAULT_PORT = 7347;
// VAR -> fixed upstream origin, how the key is injected, and the base-URL env var the CLI reads
export const PROVIDERS = {
  ANTHROPIC_API_KEY: { origin: 'https://api.anthropic.com', header: 'x-api-key', baseVar: 'ANTHROPIC_BASE_URL', suffix: '' },
  OPENAI_API_KEY: { origin: 'https://api.openai.com', header: 'authorization', bearer: true, baseVar: 'OPENAI_BASE_URL', suffix: '/v1' },
  GEMINI_API_KEY: { origin: 'https://generativelanguage.googleapis.com', header: 'x-goog-api-key', baseVar: 'GOOGLE_GEMINI_BASE_URL', suffix: '' },
};
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,23}$/;
const TOKEN_RE = /^[0-9a-f]{64}$/;
const STRIP = new Set(['host', 'authorization', 'x-api-key', 'x-goog-api-key', 'cookie', 'proxy-authorization', 'proxy-connection', 'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-real-ip']);
const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authenticate', 'set-cookie']);
const sha = (s) => createHash('sha256').update(s).digest();

// root-owned config only (port, and an origin override used by the local tests)
export function readConf(file = CRED_CONF) {
  try {
    const st = fs.statSync(file);
    if (st.uid !== 0 || (st.mode & 0o022)) return { port: DEFAULT_PORT };
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    const port = Number.isInteger(c.port) && c.port > 1024 && c.port < 65536 ? c.port : DEFAULT_PORT;
    const origins = {};
    for (const [k, v] of Object.entries(c.origins ?? {})) if (PROVIDERS[k] && /^(https:\/\/[a-z0-9.-]+(:\d+)?|http:\/\/127\.0\.0\.1:\d+)$/.test(String(v))) origins[k] = v;
    return { port, origins };
  } catch { return { port: DEFAULT_PORT }; }
}

// store layout: <store>/agents/<name>/token.sha256 and <store>/agents/<name>/<VAR> (0600)
export function resolve(store, name, token, variable) {
  if (!NAME_RE.test(name) || !TOKEN_RE.test(token) || !Object.hasOwn(PROVIDERS, variable)) return null;
  const dir = path.join(store, 'agents', name);
  let want, key;
  try { want = Buffer.from(fs.readFileSync(path.join(dir, 'token.sha256'), 'utf8').trim(), 'hex'); key = fs.readFileSync(path.join(dir, variable), 'utf8').split('\n')[0]; } catch { return null; }
  const got = sha(token);
  if (want.length !== got.length || !timingSafeEqual(want, got) || !key) return null;
  return key;
}

export function startProxy({ store, port = DEFAULT_PORT, origins = {}, host = '127.0.0.1' }) {
  const counts = new Map();
  const server = http.createServer((req, res) => {
    try { return handle(req, res); } catch { try { res.writeHead(500); res.end(); } catch { res.destroy(); } }
  });
  const handle = (req, res) => {
    const deny = (code, msg) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: msg })); };
    const m = /^\/g4a\/([^/]+)\/([^/]+)\/([^/]+)(\/[^?#]*)?(\?[^#]*)?$/.exec(req.url || '');
    if (!m) return deny(404, 'not a g4a proxy path');
    const [, name, token, variable, rest = '/', query = ''] = m;
    const key = resolve(store, name, token, variable);
    if (!key) return deny(401, 'unknown agent, token or provider');
    const p = PROVIDERS[variable];
    const origin = origins[variable] ?? p.origin;
    let target, decoded;
    // a malformed escape must not throw out of the handler (that would let any agent crash the proxy)
    try { target = new URL(rest + query, origin); decoded = decodeURIComponent(rest); } catch { return deny(400, 'bad path'); }
    if (target.origin !== new URL(origin).origin || /(^|[\/\\])\.\.?([\/\\]|$)/.test(decoded) || decoded.includes('\0')) return deny(400, 'bad path');
    target.searchParams.delete('key'); // gemini-style ?key= never reaches upstream from the agent
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!STRIP.has(k.toLowerCase())) headers[k] = v;
    headers[p.header] = p.bearer ? `Bearer ${key}` : key;
    counts.set(name, (counts.get(name) ?? 0) + 1);
    const lib = target.protocol === 'https:' ? https : http;
    const up = lib.request(target, { method: req.method, headers, timeout: 600000 }, (ur) => {
      const h = {};
      for (const [k, v] of Object.entries(ur.headers)) if (!HOP.has(k.toLowerCase())) h[k] = v;
      res.writeHead(ur.statusCode ?? 502, h);
      ur.pipe(res);
    });
    up.on('timeout', () => up.destroy(new Error('upstream timeout')));
    up.on('error', () => { if (!res.headersSent) deny(502, 'upstream unreachable'); else res.destroy(); });
    req.pipe(up);
  };
  server.headersTimeout = 30000;
  return new Promise((ok, bad) => { server.once('error', bad); server.listen(port, host, () => ok({ server, port: server.address().port, counts })); });
}

// Is 127.0.0.1:<port> listened on by <uid>? (guards against an agent squatting the port first)
export function listenerUid(port) {
  const hex = `0100007F:${port.toString(16).toUpperCase().padStart(4, '0')}`;
  try {
    for (const l of fs.readFileSync('/proc/net/tcp', 'utf8').split('\n').slice(1)) {
      const f = l.trim().split(/\s+/);
      if (f[1] === hex && f[3] === '0A') return Number(f[7]);
    }
  } catch {}
  return null;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2];
  const conf = readConf();
  if (cmd === 'serve') {
    startProxy({ store: CRED_HOME, port: conf.port, origins: conf.origins })
      .then(() => fs.writeFileSync(path.join(CRED_HOME, 'proxy.pid'), String(process.pid)))
      .catch((e) => { process.stderr.write(`g4a credproxy: ${e.code || e.message}\n`); process.exit(1); });
  } else if (cmd === 'ensure') {
    // started by the agent launcher via sudo -u g4a-cred; idempotent
    if (listenerUid(conf.port) === process.getuid()) process.exit(0);
    const c = spawn(process.execPath, ['--no-warnings', fileURLToPath(import.meta.url), 'serve'], { detached: true, stdio: 'ignore', cwd: '/' });
    c.unref();
    const t0 = Date.now();
    const wait = () => { if (listenerUid(conf.port) === process.getuid()) process.exit(0); if (Date.now() - t0 > 5000) process.exit(1); setTimeout(wait, 50); };
    wait();
  } else if (cmd === 'check') {
    // used by the launcher (as the agent): exit 0 only if the proxy user owns the listening port
    const want = Number(process.argv[3]);
    process.exit(listenerUid(conf.port) === want && Number.isInteger(want) ? 0 : 1);
  } else if (cmd === 'port') {
    process.stdout.write(`${conf.port}\n`);
  } else { process.stderr.write('usage: cred-proxy.mjs serve|ensure|check UID|port\n'); process.exit(2); }
}
