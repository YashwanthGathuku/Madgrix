// Gap 6: opt-in, local-only session capture, search, static review and an advisory eval hook.
// All off by default. Nothing here is pushed anywhere, nothing here gates landing.
//  - capture: G4A_CAPTURE=1. Redacted JSONL under $G4A_HOME/sessions/<repo-hash>/<agent>.jsonl
//    (0600 in a 0700 dir, outside the repo, so git can never pick it up).
//  - search:  local substring search over captured sessions and main's commit messages.
//  - review:  static, script-free HTML (every value escaped, CSP default-src 'none').
//  - eval:    G4A_EVAL_HOOK="cmd" runs after a promote with the result JSON on stdin; its output is
//             recorded as advisory_eval and can never change ok/status.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { redact, redactDeep, ensurePrivateDir, appendPrivate, writePrivate } from './privacy.mjs';
import { g4aHome } from './lib.mjs';

const rid = (repo) => createHash('sha256').update(path.resolve(repo || '.')).digest('hex').slice(0, 16);
const AGENT = /^[A-Za-z0-9._-]{1,64}$/;
export const captureOn = (env = process.env) => env.G4A_CAPTURE === '1';
const sdir = (repo, home = g4aHome()) => path.join(home, 'sessions', rid(repo));

export function capture(repo, agent, event, data, env = process.env, home = g4aHome()) {
  if (!captureOn(env) || !AGENT.test(String(agent || ''))) return false;
  ensurePrivateDir(path.join(home, 'sessions')); const d = ensurePrivateDir(sdir(repo, home));
  const rec = redactDeep({ ts: new Date().toISOString(), agent, event, ...data }, env);
  delete rec.secret; delete rec.credential; delete rec.agent_credential;
  appendPrivate(path.join(d, `${agent}.jsonl`), JSON.stringify(rec) + '\n');
  return true;
}
export function sessions(repo, home = g4aHome()) {
  const d = sdir(repo, home); const out = [];
  let names = []; try { names = fs.readdirSync(d).filter((f) => f.endsWith('.jsonl')); } catch { return out; }
  for (const f of names) for (const l of fs.readFileSync(path.join(d, f), 'utf8').split('\n')) { if (!l) continue; try { out.push(JSON.parse(l)); } catch {} }
  return out.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
}
const git = (repo, args) => { try { return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 64 << 20 }); } catch { return ''; } };
export function commits(repo, ref = 'main', n = 200) {
  const raw = git(repo, ['log', '-n', String(n), '--format=%x1e%H%x1f%an%x1f%aI%x1f%s%x1f%b', '--name-only', ref, '--']);
  return raw.split('\x1e').filter(Boolean).map((c) => { const [head, ...files] = c.split('\n'); const [sha, author, date, subject, body] = head.split('\x1f'); return { sha, author, date, subject: redact(subject), body: redact(body || ''), files: files.filter(Boolean) }; });
}
export function search(repo, q, home = g4aHome()) {
  const needle = String(q || '').toLowerCase(); if (!needle) return { ok: false, error: 'empty query' };
  const hit = (o) => JSON.stringify(o).toLowerCase().includes(needle);
  return { ok: true, query: q, sessions: sessions(repo, home).filter(hit), commits: commits(repo).filter(hit) };
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function reviewHtml(repo, home = g4aHome()) {
  const cs = commits(repo), ss = sessions(repo, home);
  const rows = cs.map((c) => `<tr><td><code>${esc(c.sha.slice(0, 12))}</code></td><td>${esc(c.date)}</td><td>${esc(c.author)}</td><td>${esc(c.subject)}</td><td>${c.files.map(esc).join('<br>')}</td></tr>`).join('\n');
  const srows = ss.map((s) => `<tr><td>${esc(s.ts)}</td><td>${esc(s.agent)}</td><td>${esc(s.event)}</td><td><code>${esc(JSON.stringify({ ...s, ts: undefined, agent: undefined, event: undefined }))}</code></td></tr>`).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>g4a review</title>
<style>body{font:14px system-ui;margin:2em}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:4px;vertical-align:top;text-align:left}</style></head><body>
<h1>g4a review: ${esc(path.basename(path.resolve(repo)))}</h1><h2>main (${cs.length} commits)</h2><table><tr><th>sha</th><th>date</th><th>author</th><th>subject</th><th>files</th></tr>
${rows}</table><h2>captured sessions (${ss.length})</h2>${ss.length ? `<table><tr><th>ts</th><th>agent</th><th>event</th><th>data</th></tr>${srows}</table>` : '<p>none (capture is off unless G4A_CAPTURE=1)</p>'}</body></html>\n`;
}
export function writeReview(repo, out, home = g4aHome()) {
  const f = out || path.join(ensurePrivateDir(path.join(home, 'review')), `${rid(repo)}.html`);
  writePrivate(f, reviewHtml(repo, home)); return f;
}
export function evalHook(result, env = process.env) {
  const cmd = env.G4A_EVAL_HOOK; if (!cmd) return undefined;
  const ms = Math.min(Number(env.G4A_EVAL_TIMEOUT_MS) || 30000, 600000);
  const clean = { ...env }; delete clean.G4A_AGENT_CREDENTIAL; delete clean.G4A_EVAL_HOOK;
  const r = spawnSync('sh', ['-c', cmd], { input: JSON.stringify(redactDeep(result, env)), encoding: 'utf8', timeout: ms, env: clean, maxBuffer: 1 << 20 });
  return { advisory: true, exit: r.status, timed_out: r.error?.code === 'ETIMEDOUT', output: redact(String((r.stdout || '') + (r.stderr || '')).slice(0, 4000), env) };
}
