// Agent names are bound to the OS uid of the first claimer (state/agents.json in the authority root).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bindAgent } from '../src/authority-service.mjs';

test('bindAgent: first claim binds, other uid refused, root allowed, bad names refused', () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'g4a-id-')); const L = { state };
  assert.equal(bindAgent(L, 'a1', 1001, false).ok, false, 'permit before any claim: no binding');
  assert.deepEqual(bindAgent(L, 'a1', 1001, true), { ok: true, bound: true });
  assert.equal(bindAgent(L, 'a1', 1001, false).ok, true);
  const r = bindAgent(L, 'a1', 1002, true); assert.equal(r.ok, false); assert.match(r.error, /bound to uid 1001/);
  assert.equal(bindAgent(L, 'a1', 0, false).ok, true, 'root may act for any agent');
  for (const bad of ['', '../x', 'a b', 'x'.repeat(65), null]) assert.equal(bindAgent(L, bad, 1001, true).ok, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(state, 'agents.json'), 'utf8')).a1, 1001);
  fs.rmSync(state, { recursive: true, force: true });
});
