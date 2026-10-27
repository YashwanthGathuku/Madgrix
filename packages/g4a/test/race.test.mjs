// Regression (ForgeMark race run): a mirrored claim must use the authority's baseline. When
// another agent landed between the authority claim and the local claim, the local worktree
// started from a newer main, so the push carried the other agent's files and pre-receive
// refused it as out-of-claim. The local claim now refuses (main_out_of_sync, retryable) instead.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Authority } from '../src/authority.mjs';

test('claim with expectBaseline refuses when local main differs, and creates no worktree', async () => {
  const W = fs.mkdtempSync(path.join(os.tmpdir(), 'g4a-race-t-'));
  try {
    const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', G4A_RAW: '1' };
    const repo = path.join(W, 'r'); fs.mkdirSync(repo);
    const git = (...a) => execFileSync('git', a, { cwd: repo, env, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main'); fs.writeFileSync(path.join(repo, 'a'), '1'); git('add', '-A'); git('commit', '-qm', 'one');
    const old = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo, 'b'), '2'); git('add', '-A'); git('commit', '-qm', 'two'); git('checkout', '-q', '--detach');
    const auth = new Authority(path.join(W, 'home'), { keyDir: path.join(W, 'keys') });
    const r = await auth.claim({ repo, agent: 'x', paths: ['x/**'], expectBaseline: old });
    assert.equal(r.ok, false);
    assert.equal(r.refused, 'main_out_of_sync');
    assert.equal(fs.existsSync(path.join(repo, '.g4a', 'worktrees', 'x')), false);
    const ok = await auth.claim({ repo, agent: 'x', paths: ['x/**'], expectBaseline: git('rev-parse', 'main') });
    assert.equal(ok.ok, true);
    assert.equal(ok.baseline, git('rev-parse', 'main'));
    auth.db.close?.();
  } finally { fs.rmSync(W, { recursive: true, force: true }); }
});
