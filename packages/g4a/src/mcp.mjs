// `g4a mcp`: a stdio MCP server (newline-delimited JSON-RPC 2.0, protocol 2025-06-18) exposing
// g4a claim / status / promote / verify / release / authority status as tools for Claude Code,
// Codex and Cursor. Every tool runs the real g4a CLI as a child process (argv array, no shell), so
// the server adds no new path around the daemon, authority, permits or the shim: it has exactly
// the privileges of the editor process that launched it. Claim secrets stay in G4A_HOME and are
// never returned. Repo defaults to G4A_MCP_REPO or the server's cwd (the editor workspace).
import { spawn } from 'node:child_process';
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
  for (const k of t.inputSchema.required || []) if (a[k] === undefined) bad(`missing ${k}`);
  if (a.agent !== undefined && !/^[A-Za-z0-9._-]{1,64}$/.test(a.agent)) bad('agent must match [A-Za-z0-9._-]{1,64}');
  if (a.repo !== undefined && (typeof a.repo !== 'string' || !a.repo || a.repo.startsWith('-'))) bad('repo must be a path');
  if (a.paths !== undefined && (!Array.isArray(a.paths) || !a.paths.length || a.paths.some((p) => typeof p !== 'string' || !p || p.startsWith('-') || p.includes(',')))) bad('paths must be non-empty strings without commas or a leading -');
  if (a.witnesses !== undefined && (!Array.isArray(a.witnesses) || a.witnesses.some((w) => typeof w !== 'string' || !w || w.startsWith('-')))) bad('witnesses must be command strings');
  for (const k of ['allow_overlap', 'no_wait', 'remove_worktree']) if (a[k] !== undefined && typeof a[k] !== 'boolean') bad(`${k} must be boolean`);
}

function runCli(argv, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, ['--no-warnings', CLI, ...argv], { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let so = '', se = ''; c.stdout.on('data', (d) => { so += d; }); c.stderr.on('data', (d) => { se += d; });
    const t = setTimeout(() => c.kill('SIGTERM'), timeoutMs);
    c.on('close', (code) => { clearTimeout(t); resolve({ code, stdout: so, stderr: se }); });
    c.on('error', (e) => { clearTimeout(t); resolve({ code: -1, stdout: '', stderr: e.message }); });
  });
}

export async function callTool(name, args = {}, { cwd = process.env.G4A_MCP_REPO || process.cwd(), timeoutMs = Number(process.env.G4A_MCP_TIMEOUT_MS || 600_000) } = {}) {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) throw Object.assign(new Error(`unknown tool ${name}`), { code: -32602 });
  validate(t, args);
  const repo = path.resolve(cwd, args.repo || '.');
  const r = await runCli([...t.argv(args), '--repo', repo], repo, timeoutMs);
  let json = null; try { json = JSON.parse(r.stdout); } catch {}
  const daemonDown = /ECONNREFUSED|ENOENT.*sock|daemon/i.test(r.stderr) && !json;
  const text = json ? JSON.stringify(json, null, 2) : (r.stdout || r.stderr || `g4a exited ${r.code}`).trim() + (daemonDown ? '\n(hint: start the daemon with `g4a daemon --detach`)' : '');
  return { content: [{ type: 'text', text }], ...(json ? { structuredContent: json } : {}), isError: r.code !== 0 || json?.ok === false };
}

export function serve(input = process.stdin, output = process.stdout) {
  const send = (m) => output.write(JSON.stringify(m) + '\n');
  const rl = readline.createInterface({ input });
  const pending = new Set();
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
        const p = callTool(m.params?.name, m.params?.arguments ?? {}).then(reply, (e) => fail(e.code ?? -32603, e.message));
        pending.add(p); p.finally(() => pending.delete(p)); return;
      }
      default: if (m.method.startsWith('notifications/')) return; return fail(-32601, `method not found: ${m.method}`);
    }
  });
  return new Promise((r) => rl.on('close', () => Promise.allSettled([...pending]).then(r)));
}
