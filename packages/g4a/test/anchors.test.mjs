// Group-committed ledger anchors (deferAnchors): entries chain at once, anchors catch up on flush or
// on the next start, and rollback detection still applies to every flushed head.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Authority } from '../src/authority.mjs';

const mk = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'g4a-anc-'));
  const repo = path.join(d, 'repo'); fs.mkdirSync(repo); execFileSync('git', ['init', '-q', repo]);
  return { d, repo, home: path.join(d, 'home'), keys: path.join(d, 'keys') };
};
const anchorSeq = (a, repo) => JSON.parse(fs.readFileSync(a.anchorFile(repo), 'utf8')).anchor.seq;

test('manual deferral: one anchor per flush, catch-up after a crash, rollback still refused', async () => {
  const t = mk();
  const a = new Authority(t.home, { keyDir: t.keys, deferAnchors: 'manual' });
  for (let i = 0; i < 5; i++) await a.appendLedger(t.repo, 'test', { i });
  assert.equal(fs.existsSync(a.anchorFile(t.repo)), false, 'no anchor before flush');
  a.flushAnchors();
  assert.equal(anchorSeq(a, t.repo), 4);
  await a.appendLedger(t.repo, 'test', { i: 5 }); // "crash": never flushed
  a.db.close();
  const b = new Authority(t.home, { keyDir: t.keys }); // reanchorAll at start catches up
  assert.equal(anchorSeq(b, t.repo), 5);
  b.db.prepare('DELETE FROM ledger WHERE repo = ? AND seq >= 4').run(t.repo); // roll back
  await assert.rejects(b.appendLedger(t.repo, 'test', {}), /rollback detected/);
  b.db.close(); fs.rmSync(t.d, { recursive: true, force: true });
});

test('auto deferral flushes within a few ms', async () => {
  const t = mk();
  const a = new Authority(t.home, { keyDir: t.keys, deferAnchors: 'auto' });
  await a.appendLedger(t.repo, 'test', { i: 0 }); await a.appendLedger(t.repo, 'test', { i: 1 });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(anchorSeq(a, t.repo), 1);
  a.db.close(); fs.rmSync(t.d, { recursive: true, force: true });
});
