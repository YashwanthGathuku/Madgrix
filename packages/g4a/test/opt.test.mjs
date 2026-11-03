// Landing optimizations: in-memory witness cache (passes only, exact tree + command) and the
// adaptive batch cap. Fixtures under os.tmpdir(), removed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runWitnesses, witnessCacheStats, batchCapOf, noteBatchOutcome, MAX_BATCH } from '../src/promote.mjs';

const ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', G4A_RAW: '1' };
test('witness cache: hit on the same tree+cmd, miss on a new tree, failures never cached, opt-out', async () => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'g4a-opt-')));
  const git = (...a) => execFileSync('git', a, { cwd: d, env: { ...process.env, ...ID }, encoding: 'utf8' }).trim();
  try {
    git('init', '-q', '-b', 'main'); fs.writeFileSync(path.join(d, 'a'), '1'); git('add', '-A'); git('commit', '-qm', 'one');
    const s1 = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(d, 'a'), '2'); git('add', '-A'); git('commit', '-qm', 'two');
    const s2 = git('rev-parse', 'HEAD');
    witnessCacheStats.clear();
    const pass = [{ cmd: 'test -f a', agents: ['x'] }], fail = [{ cmd: 'false', agents: ['x'] }];
    const r1 = await runWitnesses(d, s1, pass); assert.equal(r1[0].exit, 0); assert.equal(r1[0].cached, undefined);
    const r2 = await runWitnesses(d, s1, pass); assert.equal(r2[0].exit, 0); assert.equal(r2[0].cached, true);
    // a commit with the same tree also hits (keyed by tree, not commit)
    const s1b = git('commit-tree', `${s1}^{tree}`, '-m', 'same tree');
    assert.equal((await runWitnesses(d, s1b, pass))[0].cached, true);
    assert.equal((await runWitnesses(d, s2, pass))[0].cached, undefined, 'different tree runs for real');
    assert.notEqual((await runWitnesses(d, s1, fail))[0].exit, 0);
    const f2 = await runWitnesses(d, s1, fail); assert.notEqual(f2[0].exit, 0); assert.equal(f2[0].cached, undefined, 'failures are not cached');
    // mixed: one uncached command forces a real run of all
    const mixed = await runWitnesses(d, s1, [...pass, { cmd: 'true', agents: ['y'] }]); assert.ok(mixed.every((r) => !r.cached));
    process.env.G4A_WITNESS_CACHE = '0';
    try { assert.equal((await runWitnesses(d, s1, pass))[0].cached, undefined); } finally { delete process.env.G4A_WITNESS_CACHE; }
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});
test('adaptive batch cap: starts at MAX_BATCH, halves on a failed batch (min 1), doubles back on success', () => {
  const r = '/nonexistent-repo';
  assert.equal(batchCapOf(r), MAX_BATCH);
  noteBatchOutcome(r, 20, false); assert.equal(batchCapOf(r), 10);
  noteBatchOutcome(r, 10, false); noteBatchOutcome(r, 5, false); noteBatchOutcome(r, 3, false); noteBatchOutcome(r, 2, false); noteBatchOutcome(r, 1, false);
  assert.equal(batchCapOf(r), 1);
  for (let i = 0; i < 10; i++) noteBatchOutcome(r, 1, true);
  assert.equal(batchCapOf(r), MAX_BATCH);
});
