// Agent names are bound to the OS uid of the first claimer (state/agents.json in the authority root).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bindAgent, rebindAgent, unbindAgent } from '../src/authority-service.mjs';
import { generateKeyPairSync, verify } from 'node:crypto';
import { canonicalJson } from '../../../src/lib/canonical.ts';

test('bindAgent: first claim binds uid + issues a credential; uid and credential both required after', () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'g4a-id-')); const L = { state };
  assert.equal(bindAgent(L, 'a1', 1001, false).ok, false, 'permit before any claim: no binding');
  const b = bindAgent(L, 'a1', 1001, true);
  assert.equal(b.ok, true); assert.equal(b.bound, true); assert.match(b.credential, /^[A-Za-z0-9_-]{43}$/);
  const cred = b.credential;
  assert.equal(bindAgent(L, 'a1', 1001, false).ok, false, 'same uid, no credential (impersonation by another same-uid process)');
  assert.equal(bindAgent(L, 'a1', 1001, false, 'y'.repeat(43)).ok, false, 'wrong credential');
  assert.equal(bindAgent(L, 'a1', 1001, true).ok, false, 're-claim without credential does not mint a new one');
  assert.deepEqual(bindAgent(L, 'a1', 1001, false, cred), { ok: true });
  const r = bindAgent(L, 'a1', 1002, true, cred); assert.equal(r.ok, false); assert.match(r.error, /bound to uid 1001/);
  assert.equal(bindAgent(L, 'a1', 0, false).ok, false, 'root still needs the credential');
  assert.equal(bindAgent(L, 'a1', 0, false, cred).ok, true, 'root skips the uid check');
  for (const bad of ['', '../x', 'a b', 'x'.repeat(65), null]) assert.equal(bindAgent(L, bad, 1001, true).ok, false);
  const stored = JSON.parse(fs.readFileSync(path.join(state, 'agents.json'), 'utf8')).a1;
  assert.equal(stored.uid, 1001); assert.ok(!JSON.stringify(stored).includes(cred), 'only the hash is stored');
  // legacy {agent: uid} entry: next claim by the bound uid upgrades it
  fs.writeFileSync(path.join(state, 'agents.json'), JSON.stringify({ old: 1001 }));
  assert.equal(bindAgent(L, 'old', 1001, false).legacy, true);
  assert.ok(bindAgent(L, 'old', 1001, true).credential);
  assert.equal(bindAgent(L, 'old', 1001, false).ok, false);
  // operator rebind / unbind (key passed in: the service only reaches these after the tty passphrase)
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const rb = rebindAgent(L, 'a1', 1002, privateKey);
  assert.equal(rb.ok, true); assert.notEqual(rb.credential, cred);
  assert.equal(bindAgent(L, 'a1', 1001, false, cred).ok, false, 'old uid/credential dead');
  assert.equal(bindAgent(L, 'a1', 1002, false, rb.credential).ok, true);
  assert.equal(unbindAgent(L, 'a1', privateKey).removed, true);
  assert.ok(bindAgent(L, 'a1', 1003, true).bound, 'name is free after unbind');
  const log = fs.readFileSync(path.join(state, 'identity.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  for (const e of log.filter((x) => x.event === 'rebind' || x.event === 'unbind')) {
    const { operator_sig, ...rest } = e;
    assert.ok(verify(null, Buffer.from(canonicalJson(rest)), publicKey, Buffer.from(operator_sig, 'hex')), 'operator-signed');
  }
  assert.ok(!fs.readFileSync(path.join(state, 'identity.jsonl'), 'utf8').includes(rb.credential));
  fs.rmSync(state, { recursive: true, force: true });
});
