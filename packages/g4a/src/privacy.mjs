// Redaction, minimisation and private-file helpers for everything g4a writes locally.
// redact(): tokens / credential URLs / auth headers / private keys / common secret assignments.
// Emails are redacted only with G4A_REDACT_EMAILS=1 (git identities are often wanted in logs).
import fs from 'node:fs';
import path from 'node:path';

const R = '[REDACTED]';
const PATTERNS = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, `-----${R} PRIVATE KEY-----`],
  [/\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi, `$1$2:${R}@`],          // scheme://user:pass@
  [/\b([a-z][a-z0-9+.-]*:\/\/)(?!git@)([^\s/@:]+)@/gi, `$1${R}@`],                 // scheme://token@ (any length; plain ssh://git@ kept)
  [/\b(authorization|proxy-authorization|x-api-key|api-key|private-token|x-auth-token|cookie)(\s*[:=]\s*)(?:(bearer|basic|token)\s+)?([^\s'",;]+)/gi, (m, h, s, k) => `${h}${s}${k ? `${k} ` : ''}${R}`],
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, `$1 ${R}`],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|npm_[A-Za-z0-9]{30,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g, R],
  [/\b([A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?|auth[_-]?token|authkey))(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s'"&;]+)/gi, `$1$2${R}`],
];
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

export function redact(s, env = process.env) {
  if (typeof s !== 'string' || !s) return s;
  let o = s;
  for (const [re, to] of PATTERNS) o = o.replace(re, to);
  if (env.G4A_REDACT_EMAILS === '1') o = o.replace(EMAIL, '[EMAIL]');
  return o;
}
export function redactDeep(v, env = process.env) {
  if (typeof v === 'string') return redact(v, env);
  if (Array.isArray(v)) return v.map((x) => redactDeep(x, env));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x, env)]));
  return v;
}

// Minimise git argv for the usage log: drop commit/tag message bodies and search content (keep
// their length), then redact. Handles separate (-m X), attached (-mX, --message=X) and combined
// short-flag (-qm X, -am X, -qmX) forms; -S/-G/--grep values are treated as content too.
// G4A_LOG_ARGV=0 stores only the subcommand.
const MSG_LONG = new Set(['--message', '--file', '--template', '--grep']);
const CFG_FLAGS = new Set(['-c', '--config-env']);
const hide = (v) => `[${String(v).length} chars]`;
const cfg = (v, env) => redact(String(v).replace(/^([^=]*(?:extraheader|token|password|cred)[^=]*=).*/is, `$1${R}`), env);
export function minimiseArgv(argv, env = process.env) {
  if (!Array.isArray(argv)) return argv;
  if (env.G4A_LOG_ARGV === '0') return argv.length ? ['[argv omitted]'] : [];
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    const long = a.match(/^(--[a-z-]+)=(.*)$/s);
    if (long && MSG_LONG.has(long[1])) { out.push(`${long[1]}=${hide(long[2])}`); continue; }
    if (long && long[1] === '--config-env') { out.push(`--config-env=${cfg(long[2], env)}`); continue; }
    if (MSG_LONG.has(a)) { if (i + 1 < argv.length) out.push(a, hide(argv[++i])); else out.push(a); continue; }
    if (CFG_FLAGS.has(a)) { if (i + 1 < argv.length) out.push(a, cfg(argv[++i], env)); else out.push(a); continue; }
    // short-flag cluster: the first m/F/S/G takes the rest of the token, or the next argument
    const sc = /^-([a-zA-Z]+)(.*)$/s.exec(a);
    if (sc && !a.startsWith('--')) {
      const letters = sc[1] + sc[2];
      let k = -1;
      for (let j = 0; j < letters.length && /[a-zA-Z]/.test(letters[j]); j++) if ('mFSG'.includes(letters[j])) { k = j; break; }
      if (k >= 0) {
        const flag = letters[k], val = letters.slice(k + 1), head = `-${letters.slice(0, k + 1)}`;
        if (val) { out.push(`${head}${hide(val)}`); continue; }
        // -S/-G may be bare (commit -S signs): only consume a following non-option value
        if (i + 1 < argv.length && ('mF'.includes(flag) || !String(argv[i + 1]).startsWith('-'))) { out.push(head, hide(argv[++i])); continue; }
        out.push(head); continue;
      }
    }
    out.push(redact(a, env));
  }
  return out;
}

// Private files: 0700 dirs, 0600 files, refuse to follow a symlink at the final path.
export function ensurePrivateDir(d) {
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  const st = fs.lstatSync(d);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`g4a: ${d} is not a real directory`);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error(`g4a: ${d} is owned by uid ${st.uid}, not ${process.getuid()}`);
  if (st.mode & 0o077) fs.chmodSync(d, 0o700);
  return d;
}
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
export function appendPrivate(f, data) {
  const fd = fs.openSync(f, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | NOFOLLOW, 0o600);
  try { const st = fs.fstatSync(fd); if (st.mode & 0o077) fs.fchmodSync(fd, 0o600); fs.writeSync(fd, data); } finally { fs.closeSync(fd); }
}
export function writePrivate(f, data, mode = 0o600) {
  const fd = fs.openSync(f, fs.constants.O_WRONLY | fs.constants.O_CREAT | NOFOLLOW, mode);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error(`g4a: ${f} is not a regular file`);
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error(`g4a: ${f} is owned by uid ${st.uid}, not ${process.getuid()}`);
    fs.ftruncateSync(fd, 0); fs.fchmodSync(fd, mode); fs.writeSync(fd, data); } finally { fs.closeSync(fd); }
}

// Retention. log.jsonl rotates at G4A_LOG_MAX_BYTES (default 5 MiB) keeping G4A_LOG_KEEP (default 2)
// old files; tee/ keeps files newer than G4A_TEE_MAX_AGE_DAYS (default 7) and at most G4A_TEE_MAX_FILES (200).
export const limits = (env = process.env) => ({
  logMaxBytes: Number(env.G4A_LOG_MAX_BYTES || 5 * 1024 * 1024), logKeep: Number(env.G4A_LOG_KEEP || 2),
  teeMaxAgeMs: Number(env.G4A_TEE_MAX_AGE_DAYS || 7) * 86_400_000, teeMaxFiles: Number(env.G4A_TEE_MAX_FILES || 200),
});
export function rotateLog(f, env = process.env) {
  const { logMaxBytes, logKeep } = limits(env);
  let size = 0; try { size = fs.statSync(f).size; } catch { return false; }
  if (size < logMaxBytes) return false;
  for (let i = logKeep; i >= 1; i--) { const src = i === 1 ? f : `${f}.${i - 1}`; try { if (i === logKeep) fs.rmSync(`${f}.${i}`, { force: true }); fs.renameSync(src, `${f}.${i}`); } catch {} }
  if (logKeep < 1) fs.rmSync(f, { force: true });
  return true;
}
export function pruneTee(dir, env = process.env, now = Date.now()) {
  const { teeMaxAgeMs, teeMaxFiles } = limits(env);
  let files; try { files = fs.readdirSync(dir).map((n) => { const p = path.join(dir, n); const st = fs.lstatSync(p); return { p, m: st.mtimeMs, f: st.isFile() }; }).filter((x) => x.f); } catch { return 0; }
  files.sort((a, b) => b.m - a.m);
  let n = 0;
  files.forEach((x, i) => { if (i >= teeMaxFiles || now - x.m > teeMaxAgeMs) { fs.rmSync(x.p, { force: true }); n++; } });
  return n;
}
