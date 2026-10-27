// `g4a mcp`: a stdio MCP server (newline-delimited JSON-RPC 2.0, protocol 2025-06-18) exposing
// g4a claim / status / promote / verify / release / authority status as tools for Claude Code,
// Codex and Cursor. Every tool runs the real g4a CLI as a child process (argv array, no shell), so
// the server adds no new path around the daemon, authority, permits or the shim: it has exactly
// the privileges of the editor process that launched it. Claim secrets stay in G4A_HOME and are
// never returned. Repo defaults to G4A_MCP_REPO or the server's cwd (the editor workspace).
// Agent credentials (authority mode): by default the daemon keeps them in G4A_HOME/credentials
// (0600). With G4A_MCP_SESSION_CREDENTIALS=1 the server claims with --session-credential, keeps the
// credential only in this process's memory, hands it to the CLI on stdin (--credential-stdin), and
// strips it from every tool result, so it never reaches the model or the disk. Long calls emit
// notifications/progress when the client sent a progressToken, honour notifications/cancelled
// (the CLI child is killed; an already-queued promote job keeps running in the daemon), and are
// bounded by G4A_MCP_TIMEOUT_MS (default 600000).
import { spawn } from 'node:child_process';
import { redact, redactDeep } from './privacy.mjs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'g4a.mjs');
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const VERSION = '0.3.0';
const str = { type: 'string' };
const repoP = { repo: { type: 'string', description: 'Path inside the git repo (default: G4A_MCP_REPO or the server cwd)' } };
const agentP = { agent: { type: 'string', description: 'Agent name ([A-Za-z0-9._-], 1-64). In system mode it is bound to your OS uid on first claim.' } };

export const TOOLS = [
  { name: 'g4a_claim', description: 'Claim paths for an agent and get an isolated worktree. Overlapping claims are refused unless allow_overlap. Witnesses are commands (e.g. "npm test") that must pass before promote.',
    inputSchema: { type: 'object', properties: { ...repoP, ...agentP, paths: { type: 'array', items: str, minItems: 1 }, witnesses: { type: 'array', items: str }, allow_overlap: { type: 'boolean' } }, required: ['agent', 'paths'] },
    argv: (a) => ['claim', '--agent', a.agent, '--paths', a.paths.join(','), ...(a.witnesses || []).flatMap((w) => ['--witness', w]), ...(a.allow_overlap ? ['--allow-overlap'] : [])] },
  { name: 'g4a_status', description: 'Active claims, worktrees and queued promotions for the repo.', annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: { ...repoP } }, argv: () => ['status'] },
  { name: 'g4a_promote', description: "Ask g4a to land the agent's worktree on main: rebase/merge, run witnesses, then promoted / review / refused. Goes through the authority when one is attached.",
    inputSchema: { type: 'object', properties: { ...repoP, ...agentP, no_wait: { type: 'boolean' } }, required: ['agent'] },
    argv: (a) => ['promote', '--agent', a.agent, ...(a.no_wait ? ['--no-wait'] : [])] },
  { name: 'g4a_verify', description: 'Offline verification of the signed ledger (and the authority ledger/main when attached).', annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: { ...repoP } }, argv: () => ['verify'] },
  { name: 'g4a_release', description: "Release the agent's claim (optionally removing its worktree).",
    inputSchema: { type: 'object', properties: { ...repoP, ...agentP, remove_worktree: { type: 'boolean' } }, required: ['agent'] },
    argv: (a) => ['release', '--agent', a.agent, ...(a.remove_worktree ? ['--remove-worktree'] : [])] },
  { name: 'g4a_authority_status', description: "The attached authority's mode, main and claims.", annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: { ...repoP } }, argv: () => ['authority', 'status'] },
];

// values go into argv after a flag; refuse anything the CLI option parser could read as a flag
function validate(t, a) {
  const bad = (m) => { throw Object.assign(new Error(m), { code: -32602 }); };
  if (typeof a !== 'object' || a === null || Array.isArray(a)) bad('arguments must be an object');
  for (const k of Object.keys(a)) if (!(k in t.inputSchema.properties)) bad(`unknown argument ${k}`);
  const strs = Object.values(a).flatMap((v) => (Array.isArray(v) ? v : [v])).filter((v) => typeof v === 'string');
  if (strs.some((v) => /[\x00-\x08\x0a-\x1f\x7f]/.test(v))) bad('arguments must not contain NUL, newlines or other control characters');
  for (const k of t.inputSchema.required || []) if (a[k] === undefined) bad(`missing ${k}`);
  if (a.agent !== undefined && !/^[A-Za-z0-9._-]{1,64}$/.test(a.agent)) bad('agent must match [A-Za-z0-9._-]{1,64}');
  if (a.repo !== undefined && (typeof a.repo !== 'string' || !a.repo || a.repo.startsWith('-'))) bad('repo must be a path');
  if (a.paths !== undefined && (!Array.isArray(a.paths) || !a.paths.length || a.paths.some((p) => typeof p !== 'string' || !p || p.startsWith('-') || p.includes(',')))) bad('paths must be non-empty strings without commas or a leading -');
  if (a.witnesses !== undefined && (!Array.isArray(a.witnesses) || a.witnesses.some((w) => typeof w !== 'string' || !w || w.startsWith('-')))) bad('witnesses must be command strings');
  for (const k of ['allow_overlap', 'no_wait', 'remove_worktree']) if (a[k] !== undefined && typeof a[k] !== 'boolean') bad(`${k} must be boolean`);
}

function runCli(argv, cwd, timeoutMs, { stdin, signal, onTick } = {}) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ['--no-warnings', CLI, ...argv], { cwd, env: process.env, stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    if (stdin !== undefined) c.stdin.end(stdin);
    let so = '', se = '', why = null; c.stdout.on('data', (d) => { so += d; }); c.stderr.on('data', (d) => { se += d; });
    const kill = (w) => { why ??= w; c.kill('SIGTERM'); };
    const t = setTimeout(() => kill('timeout'), timeoutMs);
    const t0 = Date.now(); const tick = onTick ? setInterval(() => onTick(Date.now() - t0), 2000) : null;
    const onAbort = () => kill('cancelled'); signal?.addEventListener('abort', onAbort);
    const done = (r) => { clearTimeout(t); if (tick) clearInterval(tick); signal?.removeEventListener('abort', onAbort); resolve({ ...r, why }); };
    c.on('close', (code) => done({ code, stdout: so, stderr: se }));
    c.on('error', (e) => done({ code: -1, stdout: '', stderr: e.message }));
  });
}

const SESSION = process.env.G4A_MCP_SESSION_CREDENTIALS === '1';
const creds = new Map(); // `${repo}\0${agent}` -> credential, memory only
const scrub = (j) => { if (j && typeof j === 'object') { delete j.agent_credential; for (const v of Object.values(j)) scrub(v); } return j; };

export async function callTool(name, args = {}, { cwd = process.env.G4A_MCP_REPO || process.cwd(), timeoutMs = Number(process.env.G4A_MCP_TIMEOUT_MS || 600_000), signal, onProgress, session = SESSION } = {}) {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) throw Object.assign(new Error(`unknown tool ${name}`), { code: -32602 });
  validate(t, args);
  const repo = path.resolve(cwd, args.repo || '.');
  const key = `${repo}\0${args.agent}`;
  const argv = [...t.argv(args), '--repo', repo];
  let stdin;
  if (session && args.agent && ['g4a_claim', 'g4a_promote', 'g4a_release'].includes(name)) {
    if (name === 'g4a_claim') argv.push('--session-credential');
    if (creds.has(key)) { argv.push('--credential-stdin'); stdin = creds.get(key); }
  }
  const r = await runCli(argv, repo, timeoutMs, { stdin, signal, onTick: onProgress && ((ms) => onProgress(ms, `g4a ${t.argv(args)[0]} running ${Math.round(ms / 1000)}s`)) });
  if (r.why === 'cancelled') throw Object.assign(new Error('cancelled'), { cancelled: true });
  let json = null; try { json = JSON.parse(r.stdout); } catch {}
  if (json?.agent_credential && session) creds.set(key, json.agent_credential);
  if (name === 'g4a_release' && json?.ok !== false && r.code === 0) creds.delete(key);
  scrub(json); if (json) json = redactDeep(json);
  if (r.why === 'timeout') return { content: [{ type: 'text', text: `g4a timed out after ${timeoutMs}ms (G4A_MCP_TIMEOUT_MS). A queued promote keeps running in the daemon; check g4a_status.` }], isError: true };
  const daemonDown = /ECONNREFUSED|ENOENT.*sock|daemon/i.test(r.stderr) && !json;
  const text = json ? JSON.stringify(json, null, 2) : redact((r.stdout || r.stderr || `g4a exited ${r.code}`).trim()) + (daemonDown ? '\n(hint: start the daemon with `g4a daemon --detach`)' : '');
  return { content: [{ type: 'text', text }], ...(json ? { structuredContent: json } : {}), isError: r.code !== 0 || json?.ok === false };
}

// Only our own validation errors (code -32602) reach the client verbatim; Node internals
// (ERR_INVALID_ARG_VALUE, spawn errors, stack-ish text) become a generic message.
export function publicError(e) { return e && e.code === -32602 && typeof e.message === 'string' ? e.message : 'internal error (see the g4a MCP server log)'; }

export function serve(input = process.stdin, output = process.stdout) {
  const send = (m) => output.write(JSON.stringify(m) + '\n');
  const rl = readline.createInterface({ input });
  const pending = new Set(); const inflight = new Map();
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let m; try { m = JSON.parse(line); } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
    const reply = (result) => m.id !== undefined && send({ jsonrpc: '2.0', id: m.id, result });
    const fail = (code, message) => m.id !== undefined && send({ jsonrpc: '2.0', id: m.id, error: { code, message } });
    if (m.jsonrpc !== '2.0' || typeof m.method !== 'string') return fail(-32600, 'invalid request');
    switch (m.method) {
      case 'initialize': {
        const v = m.params?.protocolVersion; return reply({ protocolVersion: PROTOCOLS.includes(v) ? v : PROTOCOLS[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'g4a', version: VERSION },
          instructions: 'Coordinate parallel agents on one repo: g4a_claim before editing, work only in the returned worktree, then g4a_promote. Do not push to main yourself.' });
      }
      case 'ping': return reply({});
      case 'tools/list': return reply({ tools: TOOLS.map(({ argv, ...t }) => t) });
      case 'tools/call': {
        const ac = new AbortController(); const tok = m.params?._meta?.progressToken;
        const onProgress = tok === undefined ? undefined : (ms, message) => send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: tok, progress: Math.round(ms / 1000), message } });
        inflight.set(m.id, ac);
        const p = callTool(m.params?.name, m.params?.arguments ?? {}, { signal: ac.signal, onProgress })
          .then(reply, (e) => { if (e.cancelled) return; if (e?.code !== -32602) process.stderr.write(`[g4a mcp] ${redact(String(e?.message ?? e))}\n`); fail(e.code === -32602 ? e.code : -32603, publicError(e)); }); // cancelled requests get no response (MCP spec)
        pending.add(p); p.finally(() => { pending.delete(p); inflight.delete(m.id); }); return;
      }
      case 'notifications/cancelled': inflight.get(m.params?.requestId)?.abort(); return;
      default: if (m.method.startsWith('notifications/')) return; return fail(-32601, `method not found: ${m.method}`);
    }
  });
  return new Promise((r) => rl.on('close', () => Promise.allSettled([...pending]).then(r)));
}
