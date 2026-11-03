// `g4a authority serve` / `--status` / `--stop` and `g4a stop` covering the server (same-user mode).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { serverPid } from '../src/authority-server.mjs';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(PKG, 'bin', 'g4a.mjs');
const ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', G4A_RAW: '1' };

test('authority serve: start, status, stop; g4a stop stops it; planted pid files are never signalled', () => {
  const W = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'g4a-sc-')));
  const repo = path.join(W, 'r'), root = path.join(W, 'auth'), home = path.join(W, 'h');
  const env = { ...process.env, ...ID, G4A_HOME: home, G4A_KEY_DIR: `${home}-keys` };
  const cli = (...a) => { const r = spawnSync(process.execPath, ['--no-warnings', CLI, ...a], { cwd: repo, encoding: 'utf8', env, timeout: 30000 }); try { return JSON.parse(r.stdout); } catch { return { raw: r.stdout + r.stderr }; } };
  try {
    fs.mkdirSync(repo); const git = (...a) => execFileSync('git', a, { cwd: repo, env, encoding: 'utf8' });
    git('init', '-q', '-b', 'main'); fs.writeFileSync(path.join(repo, 'a'), '1'); git('add', '-A'); git('commit', '-qm', 'base'); git('checkout', '-q', '--detach');
    assert.equal(cli('authority', 'init', root, '--repo', repo).ok, true);
    assert.equal(cli('authority', 'serve', '--status', '--repo', repo).running, false);
    const up = cli('authority', 'serve', '--repo', repo); assert.equal(up.ok, true, JSON.stringify(up)); assert.equal(up.running, true);
    const st = cli('authority', 'serve', '--status', '--repo', repo); assert.equal(st.running, true); assert.ok(st.pid > 1);
    assert.equal(cli('authority', 'serve', '--repo', repo).ok, true, 'second start is a no-op');
    assert.equal(serverPid(root), st.pid);
    const s1 = cli('authority', 'serve', '--stop', '--repo', repo); assert.equal(s1.stopped, st.pid, JSON.stringify(s1));
    assert.equal(cli('authority', 'serve', '--status', '--repo', repo).running, false);
    // planted pid file: this test's own pid (not a server for this root) and pid 1 are refused
    for (const pid of [process.pid, 1]) { fs.writeFileSync(path.join(root, 'run', 'pid'), String(pid)); assert.equal(serverPid(root), 0); }
    assert.equal(cli('authority', 'serve', '--stop', '--repo', repo).running, false);
    // g4a stop covers the server
    assert.equal(cli('authority', 'serve', '--repo', repo).running, true);
    const pid = serverPid(root); assert.ok(pid);
    const s2 = cli('stop', '--repo', repo); assert.equal(s2.server?.stopped, pid, JSON.stringify(s2));
    assert.equal(serverPid(root), 0);
  } finally {
    const pid = serverPid(root); if (pid) try { process.kill(pid); } catch {}
    fs.rmSync(W, { recursive: true, force: true }); fs.rmSync(`${home}-keys`, { recursive: true, force: true });
  }
});
