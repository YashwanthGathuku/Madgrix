import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import http from 'node:http';
import { createHash } from 'node:crypto';
import { startProxy, resolve, listenerUid } from '../src/cred-proxy.mjs';

test('credential proxy: token auth, key injection, header stripping, path and origin safety', async () => {
  const store = fs.mkdtempSync(path.join(os.tmpdir(), 'g4a-cp-'));
  const tok = 'ab'.repeat(32);
  fs.mkdirSync(path.join(store, 'agents', 'alice'), { recursive: true });
  fs.writeFileSync(path.join(store, 'agents', 'alice', 'token.sha256'), createHash('sha256').update(tok).digest('hex') + '\n');
  fs.writeFileSync(path.join(store, 'agents', 'alice', 'OPENAI_API_KEY'), 'sk-real\n');
  const seen = [];
  const up = http.createServer((q, s) => { seen.push({ url: q.url, h: q.headers }); s.setHeader('set-cookie', 'a=b'); s.end('up'); });
  await new Promise((r) => up.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${up.address().port}`;
  const { server, port, counts } = await startProxy({ store, port: 0, origins: { OPENAI_API_KEY: origin } });
  const get = (p, headers = {}) => new Promise((ok) => http.get({ host: '127.0.0.1', port, path: p, headers }, (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => ok({ code: r.statusCode, b, h: r.headers })); }));
  try {
    assert.equal(resolve(store, 'alice', tok, 'OPENAI_API_KEY'), 'sk-real');
    assert.equal(resolve(store, 'alice', 'cd'.repeat(32), 'OPENAI_API_KEY'), null);
    assert.equal(resolve(store, '../x', tok, 'OPENAI_API_KEY'), null);
    const ok = await get(`/g4a/alice/${tok}/OPENAI_API_KEY/v1/chat?key=leak&x=1`, { authorization: 'Bearer stolen', cookie: 'c=1', 'x-forwarded-for': '1.2.3.4' });
    assert.equal(ok.code, 200); assert.equal(ok.b, 'up'); assert.equal(ok.h['set-cookie'], undefined);
    assert.equal(seen[0].url, '/v1/chat?x=1');
    assert.equal(seen[0].h.authorization, 'Bearer sk-real');
    assert.equal(seen[0].h.cookie, undefined); assert.equal(seen[0].h['x-forwarded-for'], undefined);
    assert.equal((await get(`/g4a/alice/${'cd'.repeat(32)}/OPENAI_API_KEY/v1/chat`)).code, 401);
    assert.equal((await get(`/g4a/alice/${tok}/ANTHROPIC_API_KEY/v1/x`)).code, 401, 'ungranted provider');
    assert.equal((await get(`/g4a/alice/${tok}/NOPE/v1/x`)).code >= 400, true);
    assert.equal((await get(`/g4a/alice/${tok}/OPENAI_API_KEY/..%2f..%2fetc`)).code, 400);
    assert.equal((await get(`/g4a/alice/${tok}/OPENAI_API_KEY//evil.example/x`)).code >= 400, true, 'cannot change origin');
    assert.equal((await get(`/g4a/alice/${tok}/OPENAI_API_KEY/%E0%A4%A`)).code >= 400, true, 'malformed escapes refused');
    assert.equal(seen.length, 1, 'only the authorized request reached upstream');
    assert.ok(!JSON.stringify(counts).includes('sk-real'));
    if (fs.existsSync('/proc/net/tcp')) assert.equal(listenerUid(port), process.getuid());
  } finally { server.closeAllConnections(); server.close(); up.closeAllConnections(); up.close(); fs.rmSync(store, { recursive: true, force: true }); }
});
