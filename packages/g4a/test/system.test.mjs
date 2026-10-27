// Phase 2 system-mode separation: the authority runs as the g4a-authority OS user and a non-sudo
// agent user (g4a-agent) must be PREVENTED (not merely detected) from writing authority refs,
// bypassing the receive-pack wrapper, or reading the authority keys. Needs passwordless sudo to
// install; skipped otherwise. Installs into /usr/local/lib/g4a, /var/lib/g4a-authority*, /etc/g4a.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'g4a.mjs');
const canSudo = spawnSync('sudo', ['-n', 'true']).status === 0 && os.platform() === 'linux';
const sh = (cmd, opts = {}) => spawnSync('bash', ['-c', cmd], { encoding: 'utf8', ...opts });
const asAgent = (cmd) => spawnSync('sudo', ['-n', '-u', 'g4a-agent', '-H', 'bash', '-c', `cd /tmp; ${cmd}`], { encoding: 'utf8' });
const WRAP = '/usr/local/lib/g4a/bin';
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');

test('system authority: agent user is prevented from bypassing the authority', { skip: !canSudo && 'needs passwordless sudo' }, () => {
  const created = [];
  for (const u of ['g4a-agent', 'g4a-agent2']) if (sh(`id ${u}`).status !== 0) { assert.equal(sh(`sudo -n useradd --system --create-home --shell /bin/bash ${u}`).status, 0); created.push(u); }
  let repoIdStr = null;
  const env0 = { ...process.env };
  try {
  assert.notEqual(sh('sudo -n -l -U g4a-agent').stdout.match(/\(ALL\)/), true, 'g4a-agent must not have general sudo');
  const dir = fs.mkdtempSync('/tmp/g4a-sys-');
  fs.chmodSync(dir, 0o755);
  const repo = path.join(dir, 'repo');
  const g = `git -c user.name=t -c user.email=t@t`;
  assert.equal(sh(`mkdir ${repo} && cd ${repo} && git init -q -b main && echo a > a.txt && echo b > b.txt && ${g} add -A && ${g} commit -qm base && git checkout -q --detach`).status, 0);
  repoIdStr = fs.realpathSync(path.join(repo, '.git'));
  const env = { ...process.env, G4A_HOME: path.join(dir, 'home'), G4A_KEY_DIR: path.join(dir, 'keys') };
  const init = spawnSync(process.execPath, ['--no-warnings', CLI, 'authority', 'init', '--system', '--repo', repo], { encoding: 'utf8', env });
  assert.equal(init.status, 0, init.stderr);
  const info = JSON.parse(init.stdout);
  const arepo = `${info.root}/repo`;
  const callAs = (u, cmd, p) => JSON.parse(spawnSync('sudo', ['-n', '-u', u, '-H', 'sudo', '-n', '-u', 'g4a-authority', `${WRAP}/g4a-authority`, info.id, cmd, b64(p)], { encoding: 'utf8', cwd: '/tmp' }).stdout);
  const call = (cmd, p) => callAs('g4a-agent', cmd, p);

  // 1. direct ref write on the authority repo: prevented by file permissions
  const ur = asAgent(`git --git-dir=${arepo} update-ref refs/heads/main HEAD~0 2>&1; echo rc=$?`);
  assert.match(ur.stdout, /rc=(?!0)\d+/, 'agent update-ref on authority repo must fail');
  assert.match(asAgent(`ls ${info.root} 2>&1; echo rc=$?`).stdout, /Permission denied[\s\S]*rc=2/);
  // sudo to the authority user for anything but the wrappers is refused
  assert.notEqual(asAgent(`sudo -n -u g4a-authority git --git-dir=${arepo} update-ref refs/heads/main HEAD`).status, 0);

  // 2. --receive-pack override (raw git-receive-pack, as self and via sudo) fails
  asAgent(`git config --global safe.directory '*'`); // the fixture repo is owned by the test user
  const clone = `/home/g4a-agent/c-${path.basename(dir)}`;
  assert.equal(asAgent(`git clone -q ${repo} ${clone} && cd ${clone} && echo x >> a.txt && ${g} commit -qam x 2>&1`).status, 0, "clone");
  for (const rp of ['git-receive-pack', 'sudo -n -u g4a-authority git-receive-pack', `sudo -n -u g4a-authority /usr/bin/git-receive-pack`]) {
    const r = asAgent(`cd ${clone} && git push --receive-pack='${rp}' ${arepo} HEAD:refs/heads/main 2>&1; echo rc=$?`);
    assert.match(r.stdout, /rc=(?!0)\d+/, `push with --receive-pack='${rp}' must fail`);
  }
  // the sanctioned wrapper without a permit, or to main, is refused by pre-receive
  const RP = `--receive-pack='sudo -n -u g4a-authority ${WRAP}/g4a-receive-pack'`;
  assert.match(asAgent(`cd ${clone} && git push ${RP} ${arepo} HEAD:refs/heads/main 2>&1; echo rc=$?`).stdout, /rc=(?!0)\d+/);
  assert.match(asAgent(`cd ${clone} && git push ${RP} ${arepo} HEAD:refs/heads/agents/s1 2>&1; echo rc=$?`).stdout, /rc=(?!0)\d+/);

  // 3. agent cannot read the authority keys (direct, or via sudo cat)
  assert.match(asAgent(`cat ${info.root}/keys/* 2>&1; echo rc=$?`).stdout, /rc=(?!0)\d+/);
  assert.notEqual(asAgent(`sudo -n -u g4a-authority cat ${info.root}/keys/witness-ed25519.pem`).status, 0);
  // argument injection into the wrapper is refused
  assert.notEqual(asAgent(`sudo -n -u g4a-authority ${WRAP}/g4a-authority ../x status e30=`).status, 0);
  assert.notEqual(asAgent(`sudo -n -u g4a-authority ${WRAP}/g4a-authority ${info.id} init-root e30=`).status, 0);
  assert.notEqual(asAgent(`sudo -n -u g4a-authority ${WRAP}/g4a-receive-pack /etc`).status, 0);

  // a permitted, in-scope push through the wrapper succeeds; out-of-scope is refused
  assert.equal(call('claim', { agent: 's1', paths: ['a.txt'] }).ok, true);
  const p1 = call('permit', { agent: 's1' });
  assert.equal(p1.ok, true);
  const ok = asAgent(`cd ${clone} && git push -o permit=${p1.permit} ${RP} ${arepo} HEAD:refs/heads/agents/s1 2>&1; echo rc=$?`);
  assert.match(ok.stdout, /rc=0/, ok.stdout);
  // replaying the same permit is refused
  assert.match(asAgent(`cd ${clone} && echo y >> a.txt && ${g} commit -qam y && git push -o permit=${p1.permit} ${RP} ${arepo} HEAD:refs/heads/agents/s1 2>&1; echo rc=$?`).stdout, /rc=(?!0)\d+/);
  const p2 = call('permit', { agent: 's1' });
  assert.match(asAgent(`cd ${clone} && echo z >> b.txt && ${g} commit -qam z && git push -o permit=${p2.permit} ${RP} ${arepo} HEAD:refs/heads/agents/s1 2>&1; echo rc=$?`).stdout, /rc=(?!0)\d+/, 'out-of-claim path must be refused');
  // the anchor remote via the agent wrapper only accepts refs/g4a/client-ledger, append-only
  assert.match(asAgent(`cd ${clone} && git push ${RP} ${info.root}/anchors.git HEAD:refs/g4a/authority-ledger 2>&1; echo rc=$?`).stdout, /rc=(?!0)\d+/);
  // agent identity: s1 is bound to g4a-agent's uid; g4a-agent2 cannot claim, permit, land or release as s1
  for (const c of ['claim', 'permit', 'land', 'release']) {
    const r = callAs('g4a-agent2', c, { agent: 's1', paths: ['b.txt'] });
    assert.equal(r.ok, false, `${c}: ${JSON.stringify(r)}`); assert.equal(r.reason, 'agent_identity');
  }
  // a permit issued to g4a-agent is useless when pushed by g4a-agent2
  const p3 = call('permit', { agent: 's1' });
  sh(`sudo -n -u g4a-agent2 -H git config --global safe.directory '*'`);
  const clone2 = `/home/g4a-agent2/c-${path.basename(dir)}`;
  const steal = spawnSync('sudo', ['-n', '-u', 'g4a-agent2', '-H', 'bash', '-c', `cd /tmp; git clone -q ${repo} ${clone2} && cd ${clone2} && echo s >> a.txt && ${g} commit -qam s && git push -o permit=${p3.permit} ${RP} ${arepo} +HEAD:refs/heads/agents/s1 2>&1; echo rc=$?`], { encoding: 'utf8' });
  assert.match(steal.stdout, /issued to uid[\s\S]*rc=(?!0)\d+/, steal.stdout);
  // g4a-agent2 can still use its own name
  assert.equal(callAs('g4a-agent2', 'claim', { agent: 's2', paths: ['b.txt'] }).ok, true);
  assert.equal(callAs('g4a-agent2', 'release', { agent: 's2' }).ok, true);
  const audit = call('audit', {});
  assert.equal(audit.ok, true, JSON.stringify(audit));
  call('release', { agent: 's1' });
  sh(`sudo -n rm -rf ${clone} ${clone2}`); fs.rmSync(dir, { recursive: true, force: true });
  } finally {
    // self-clean: drop this repo's authority (and the whole install if no other repo uses it), and test users
    if (repoIdStr) {
      const u = spawnSync(process.execPath, ['--no-warnings', CLI, 'authority', 'uninstall', '--system', '--repo-id', repoIdStr], { encoding: 'utf8', env: env0 });
      assert.match(u.stdout, /"ok":\s*true/, u.stdout + u.stderr);
    }
    for (const u of created) sh(`sudo -n userdel -r ${u} 2>/dev/null`);
  }
});
