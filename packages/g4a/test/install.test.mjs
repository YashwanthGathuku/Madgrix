// g4a install --login / --rc: idempotent PATH blocks in login profiles, exactly reversed on uninstall.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'g4a.mjs');

test('install --login: ~/.profile (+ existing .bash_profile/.zprofile), idempotent, uninstall restores byte-for-byte', () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'g4a-inst-'));
  try {
    const env = { ...process.env, HOME: h, G4A_HOME: path.join(h, '.g4a') };
    const run = (...a) => spawnSync(process.execPath, ['--no-warnings', CLI, ...a], { env, encoding: 'utf8' });
    fs.writeFileSync(path.join(h, '.bash_profile'), 'echo hi'); // no trailing newline
    fs.writeFileSync(path.join(h, '.bashrc'), '# rc\n');
    assert.equal(run('install', '--login', '--rc', path.join(h, '.bashrc')).status, 0);
    assert.equal(run('install', '--login', '--rc', path.join(h, '.bashrc')).status, 0); // twice
    for (const f of ['.profile', '.bash_profile', '.bashrc']) {
      const t = fs.readFileSync(path.join(h, f), 'utf8');
      assert.equal(t.split('g4a').length > 1 && (t.match(/export PATH=/g) ?? []).length, 1, `${f} has exactly one block`);
    }
    assert.equal(fs.existsSync(path.join(h, '.zprofile')), false, 'does not create .zprofile');
    const login = spawnSync('bash', ['-lc', 'command -v git'], { env: { HOME: h, PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
    assert.equal(login.stdout.trim().split('\n').pop(), path.join(h, '.g4a', 'bin', 'git'), JSON.stringify(login));
    assert.equal(run('uninstall').status, 0);
    assert.equal(fs.existsSync(path.join(h, '.profile')), false, 'created .profile removed');
    assert.equal(fs.readFileSync(path.join(h, '.bash_profile'), 'utf8'), 'echo hi');
    assert.equal(fs.readFileSync(path.join(h, '.bashrc'), 'utf8'), '# rc\n');
  } finally { fs.rmSync(h, { recursive: true, force: true }); }
});
