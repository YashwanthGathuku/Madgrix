// Phase 3: `g4a mcp` stdio server. Spawns the real server, speaks JSON-RPC over stdio like an
// editor would, and drives a claim -> commit -> promote -> verify -> release round trip.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

delete process.env.G4A_LOCAL_LAND;
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'g4a.mjs');
const ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, ...ID, G4A_RAW: '1' } }).trim();
const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

function mcp(env, cwd) {
  const c = spawn(process.execPath, ['--no-warnings', CLI, 'mcp'], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map(); const lines = [];
  readline.createInterface({ input: c.stdout }).on('line', (l) => { const m = JSON.parse(l); lines.push(m); waiting.get(m.id)?.(m); waiting.delete(m.id); });
  let n = 0;
  const reqId = (id, method, params) => new Promise((res) => { waiting.set(id, res); c.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const req = (method, params) => new Promise((res) => { const id = ++n; waiting.set(id, res); c.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  const raw = (s) => c.stdin.write(s + '\n');
  const call = async (name, args) => (await req('tools/call', { name, arguments: args })).result;
  const close = () => new Promise((r) => { c.once('exit', r); c.stdin.end(); });
  return { req, reqId, raw, call, close, lines };
}
function startDaemon(env) {
  const c = spawn(process.execPath, ['--no-warnings', CLI, 'daemon'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; c.stderr.on('data', (d) => { err += d; });
  return new Promise((res, rej) => {
    const t = setInterval(() => { if (err.includes('g4a daemon pid')) { clearInterval(t); res(c); } }, 20);
    c.on('exit', (code) => { clearInterval(t); rej(new Error(`daemon exited ${code}: ${err}`)); });
  });
}
const stop = (c) => new Promise((r) => { if (c.exitCode !== null || c.signalCode) return r(); c.once('exit', r); c.kill('SIGTERM'); });

test('mcp: initialize, tools/list, protocol errors, argument validation', async () => {
  const home = tmp('g4a-mcp-home-');
  const s = mcp({ ...process.env, G4A_HOME: home, G4A_KEY_DIR: `${home}-keys` }, home);
  try {
    const init = await s.req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    assert.equal(init.result.protocolVersion, '2025-06-18'); assert.equal(init.result.serverInfo.name, 'g4a'); assert.ok(init.result.capabilities.tools);
    assert.equal((await s.req('initialize', { protocolVersion: '1999-01-01' })).result.protocolVersion, '2025-06-18', 'unknown version -> latest supported');
    s.raw(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })); // no reply
    const names = (await s.req('tools/list', {})).result.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['g4a_authority_status', 'g4a_claim', 'g4a_promote', 'g4a_release', 'g4a_status', 'g4a_verify']);
    for (const t of (await s.req('tools/list', {})).result.tools) { assert.equal(t.inputSchema.type, 'object'); assert.equal(t.argv, undefined); }
    assert.deepEqual(await s.req('ping', {}).then((m) => m.result), {});
    assert.equal((await s.req('nope', {})).error.code, -32601);
    assert.equal((await s.req('tools/call', { name: 'g4a_nope', arguments: {} })).error.code, -32602);
    for (const bad of [{ agent: '--repo=/etc', paths: ['a'] }, { agent: 'a', paths: ['--x'] }, { agent: 'a', paths: ['a,b'] }, { agent: 'a', paths: [] }, { agent: 'a' }, { agent: 'a', paths: ['a'], extra: 1 }, { agent: 'a', paths: ['a'], witnesses: ['--x'] }, { agent: 'a', paths: ['a'], allow_overlap: 'yes' }]) {
      const r = await s.req('tools/call', { name: 'g4a_claim', arguments: bad });
      assert.equal(r.error?.code, -32602, JSON.stringify(bad));
    }
    s.raw('{not json');
    await s.req('ping', {});
    assert.ok(s.lines.some((m) => m.error?.code === -32700));
    // daemon not running: a tool error (isError), not a protocol error
    const down = await s.call('g4a_status', {});
    assert.equal(down.isError, true);
  } finally { await s.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

test('mcp: claim -> commit -> promote (via authority) -> verify -> release round trip', async () => {
  const home = tmp('g4a-mcp-home-'), repo = tmp('g4a-mcp-repo-'), auth = tmp('g4a-mcp-auth-');
  const env = { ...process.env, G4A_HOME: home, G4A_KEY_DIR: `${home}-keys` };
  git(repo, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n'); fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base'); git(repo, 'checkout', '-q', '--detach');
  execFileSync(process.execPath, ['--no-warnings', CLI, 'authority', 'init', path.join(auth, 'a'), '--repo', repo], { env, encoding: 'utf8' });
  const d = await startDaemon(env);
  const s = mcp(env, repo);
  try {
    await s.req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    const c = await s.call('g4a_claim', { agent: 'm1', paths: ['a.txt'], witnesses: ['true'] });
    assert.equal(c.isError, false, c.content[0].text); assert.equal(c.structuredContent.ok, true);
    assert.ok(!JSON.stringify(c).includes('secret_sha256') && !/"secret"/.test(JSON.stringify(c)), 'claim secret never returned');
    const wt = c.structuredContent.worktree; assert.ok(fs.existsSync(wt));
    assert.equal((await s.call('g4a_claim', { agent: 'm2', paths: ['a.txt'], witnesses: ['true'] })).isError, true, 'overlap refused');
    const st = await s.call('g4a_status', {});
    assert.ok(st.structuredContent.claims.some((x) => x.agent === 'm1'));
    fs.writeFileSync(path.join(wt, 'a.txt'), 'A\n'); git(wt, 'add', 'a.txt'); git(wt, 'commit', '-qm', 'edit a');
    const p = await s.call('g4a_promote', { agent: 'm1' });
    assert.equal(p.structuredContent.status, 'promoted', p.content[0].text);
    assert.match(p.structuredContent.via, /^authority:/);
    assert.equal(git(repo, 'show', 'main:a.txt'), 'A');
    const v = await s.call('g4a_verify', {});
    assert.equal(v.isError, false, v.content[0].text); assert.equal(v.structuredContent.ok, true);
    assert.equal((await s.call('g4a_authority_status', {})).isError, false);
    assert.equal((await s.call('g4a_release', { agent: 'm1', remove_worktree: true })).isError, false);
    // repo argument from another cwd works too
    assert.equal((await s.call('g4a_status', { repo })).isError, false);
  } finally {
    await s.close(); await stop(d);
    for (const x of [home, `${home}-keys`, repo, auth]) fs.rmSync(x, { recursive: true, force: true });
  }
});

test('mcp: session credentials stay in memory; progress, cancellation and timeout on long promotes', async () => {
  const home = tmp('g4a-mcp-home-'), repo = tmp('g4a-mcp-repo-'), auth = tmp('g4a-mcp-auth-');
  const env = { ...process.env, G4A_HOME: home, G4A_KEY_DIR: `${home}-keys` };
  git(repo, 'init', '-q', '-b', 'main'); for (const f of ['a.txt', 'b.txt', 'c.txt']) fs.writeFileSync(path.join(repo, f), f + '\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base'); git(repo, 'checkout', '-q', '--detach');
  execFileSync(process.execPath, ['--no-warnings', CLI, 'authority', 'init', path.join(auth, 'a'), '--repo', repo], { env, encoding: 'utf8' });
  const d = await startDaemon(env);
  const s = mcp({ ...env, G4A_MCP_SESSION_CREDENTIALS: '1' }, repo);
  const t = mcp({ ...env, G4A_MCP_TIMEOUT_MS: '4000' }, repo);
  try {
    await s.req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    const c = await s.call('g4a_claim', { agent: 's1', paths: ['a.txt'], witnesses: ['sleep 3'] });
    assert.equal(c.isError, false, c.content[0].text);
    assert.ok(!JSON.stringify(c).includes('agent_credential'), 'credential never returned to the model');
    assert.equal(fs.existsSync(path.join(home, 'credentials')) && fs.readdirSync(path.join(home, 'credentials'), { recursive: true }).some((f) => f.endsWith('s1')), false, 'session credential not on disk');
    const wt = c.structuredContent.worktree;
    fs.writeFileSync(path.join(wt, 'a.txt'), 'A\n'); git(wt, 'add', 'a.txt'); git(wt, 'commit', '-qm', 'edit a');
    // a plain CLI promote without the credential is refused by the authority
    const cliNo = (() => { try { return execFileSync(process.execPath, ['--no-warnings', CLI, 'promote', '--repo', repo, '--agent', 's1'], { env, encoding: 'utf8' }); } catch (e) { return e.stdout + e.stderr; } })();
    assert.doesNotMatch(cliNo, /"status": ?"promoted"/);
    const p = await s.req('tools/call', { name: 'g4a_promote', arguments: { agent: 's1' }, _meta: { progressToken: 'tok1' } });
    assert.equal(p.result.structuredContent.status, 'promoted', p.result.content[0].text);
    const prog = s.lines.filter((m) => m.method === 'notifications/progress' && m.params.progressToken === 'tok1');
    assert.ok(prog.length >= 1, 'progress notifications sent during a slow witness');
    assert.ok(prog.every((m, i) => i === 0 || m.params.progress > prog[i - 1].params.progress), 'progress increases');
    assert.equal(git(repo, 'show', 'main:a.txt'), 'A');
    // cancellation: no response for the cancelled id, the server keeps serving
    const c2 = await s.call('g4a_claim', { agent: 's2', paths: ['b.txt'], witnesses: ['sleep 4'] });
    const wt2 = c2.structuredContent.worktree; fs.writeFileSync(path.join(wt2, 'b.txt'), 'B\n'); git(wt2, 'add', 'b.txt'); git(wt2, 'commit', '-qm', 'edit b');
    let answered = false; s.reqId(900, 'tools/call', { name: 'g4a_promote', arguments: { agent: 's2' } }).then(() => { answered = true; });
    await new Promise((r) => setTimeout(r, 800));
    s.raw(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 900, reason: 'user' } }));
    assert.deepEqual((await s.req('ping', {})).result, {});
    await new Promise((r) => setTimeout(r, 1000)); assert.equal(answered, false, 'cancelled request gets no response');
    await new Promise((r) => setTimeout(r, 3500)); // let the daemon finish the cancelled client's job
    // timeout: bounded, reported as a tool error that points at g4a_status
    await t.req('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } });
    const c3 = await t.call('g4a_claim', { agent: 't1', paths: ['c.txt'], witnesses: ['sleep 12'] });
    assert.equal(c3.isError, false, c3.content[0].text);
    const wt3 = c3.structuredContent.worktree; fs.writeFileSync(path.join(wt3, 'c.txt'), 'C\n'); git(wt3, 'add', 'c.txt'); git(wt3, 'commit', '-qm', 'edit c');
    const to = await t.call('g4a_promote', { agent: 't1' });
    assert.equal(to.isError, true); assert.match(to.content[0].text, /timed out after 4000ms.*g4a_status/s);
  } finally {
    await s.close(); await t.close(); await stop(d);
    for (const x of [home, `${home}-keys`, repo, auth]) fs.rmSync(x, { recursive: true, force: true });
  }
});

test('editor snippets parse and launch `g4a mcp`', async () => {
  const dir = path.join(path.dirname(CLI), '..', 'editors');
  for (const f of ['claude-code.mcp.json', 'cursor.mcp.json']) {
    const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).mcpServers.g4a;
    assert.equal(s.command, 'node'); assert.match(s.args.join(' '), /packages\/g4a\/bin\/g4a\.mjs mcp$/);
  }
  const toml = fs.readFileSync(path.join(dir, 'codex.config.toml'), 'utf8');
  assert.match(toml, /^\[mcp_servers\.g4a\]$/m); assert.match(toml, /^args = \[.*"mcp"\]$/m);
});
