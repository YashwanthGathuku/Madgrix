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
  const c1 = call('claim', { agent: 's1', paths: ['a.txt'] });
  assert.equal(c1.ok, true); assert.match(c1.agent_credential, /^[A-Za-z0-9_-]{43}$/);
  const cred = c1.agent_credential;
  // same uid, no / wrong credential: refused (another process of g4a-agent using the name)
  for (const c of ['permit', 'land', 'release']) for (const bad of [undefined, 'x'.repeat(43)]) {
    const r = call(c, { agent: 's1', ...(bad ? { credential: bad } : {}) });
    assert.equal(r.reason, 'agent_identity', `${c}: ${JSON.stringify(r)}`);
  }
  const p1 = call('permit', { agent: 's1', credential: cred });
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
    const r = callAs('g4a-agent2', c, { agent: 's1', paths: ['b.txt'], credential: cred });
    assert.equal(r.ok, false, `${c}: ${JSON.stringify(r)}`); assert.equal(r.reason, 'agent_identity');
  }
  // a permit issued to g4a-agent is useless when pushed by g4a-agent2
  const p3 = call('permit', { agent: 's1', credential: cred });
  sh(`sudo -n -u g4a-agent2 -H git config --global safe.directory '*'`);
  const clone2 = `/home/g4a-agent2/c-${path.basename(dir)}`;
  const steal = spawnSync('sudo', ['-n', '-u', 'g4a-agent2', '-H', 'bash', '-c', `cd /tmp; git clone -q ${repo} ${clone2} && cd ${clone2} && echo s >> a.txt && ${g} commit -qam s && git push -o permit=${p3.permit} ${RP} ${arepo} +HEAD:refs/heads/agents/s1 2>&1; echo rc=$?`], { encoding: 'utf8' });
  assert.match(steal.stdout, /issued to uid[\s\S]*rc=(?!0)\d+/, steal.stdout);
  // g4a-agent2 can still use its own name
  const c2 = callAs('g4a-agent2', 'claim', { agent: 's2', paths: ['b.txt'] });
  assert.equal(c2.ok, true);
  assert.equal(callAs('g4a-agent2', 'release', { agent: 's2', credential: c2.agent_credential }).ok, true);
  const audit = call('audit', {});
  assert.equal(audit.ok, true, JSON.stringify(audit));
  assert.equal(call('release', { agent: 's1', credential: cred }).ok, true);
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

// One OS user per agent (g4a agent add / g4a run / g4a agent remove). Runs after the test above in
// the same file (node --test runs a file's tests in order), so the two never race on the install.
test('agent users: separate uids, scoped launcher, no impersonation, full cleanup', { skip: !canSudo && 'needs passwordless sudo' }, () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CODEX_|CLAUDECODE|GEMINI_CLI|G4A_)/.test(k)));
  const dir = fs.mkdtempSync('/tmp/g4a-au-'); fs.chmodSync(dir, 0o755);
  Object.assign(env, { G4A_HOME: path.join(dir, 'home'), G4A_KEY_DIR: path.join(dir, 'keys') });
  const repo = path.join(dir, 'repo');
  const g4a = (args, o = {}) => spawnSync(process.execPath, ['--no-warnings', CLI, ...args], { encoding: 'utf8', env, cwd: repo, ...o });
  const J = (r) => { try { return JSON.parse(r.stdout); } catch { return { ok: false, raw: r.stdout + r.stderr }; } };
  const run = (name, script) => g4a(['run', '--agent', name, '--', 'sh', '-c', script]);
  const H = (n) => `/var/lib/g4a-agents/${n}`;
  let repoIdStr = null; const uids = {};
  try {
    const g = `git -c user.name=t -c user.email=t@t`;
    assert.equal(sh(`mkdir ${repo} && cd ${repo} && git init -q -b main && echo a > a.txt && echo b > b.txt && ${g} add -A && ${g} commit -qm base && git checkout -q --detach`).status, 0);
    repoIdStr = fs.realpathSync(path.join(repo, '.git'));
    assert.equal(g4a(['authority', 'init', '--system', '--repo', repo]).status, 0);
    assert.equal(g4a(['daemon', '--detach']).status, 0);
    // argument injection / bad names are refused before anything runs as root
    for (const bad of ['x;id', '../x', '-o', 'Alice', 'a b', '', 'x'.repeat(25), 'a$(id)']) {
      assert.equal(J(g4a(['agent', 'add', bad])).ok, false, `agent add ${JSON.stringify(bad)}`);
      assert.notEqual(g4a(['run', '--agent', bad, '--', 'id']).status, 0);
    }
    for (const n of ['alice', 'bob']) {
      const r = J(g4a(['agent', 'add', n]));
      assert.equal(r.ok, true, JSON.stringify(r)); uids[n] = r.uid;
      // private home, credential owned by the agent user, dir 0700 / file 0600
      const st = sh(`sudo -n stat -c '%U %a' ${H(n)} ${path.dirname(r.credential_file)} ${r.credential_file}`).stdout.trim().split('\n');
      assert.deepEqual(st, [`g4a-a-${n} 700`, `g4a-a-${n} 700`, `g4a-a-${n} 600`]);
      // no sudo beyond the authority wrappers, no privileged groups
      const l = sh(`sudo -n -l -U g4a-a-${n}`).stdout;
      assert.doesNotMatch(l, /\((ALL|root)[^)]*\)/); assert.match(l, /\(g4a-authority\)/);
      assert.doesNotMatch(sh(`id g4a-a-${n}`).stdout, /sudo|wheel|adm|docker/);
    }
    assert.equal(J(g4a(['agent', 'add', 'alice'])).ok, false, 'duplicate add');
    // sudoers: the operator may run only the launcher, only as each agent user; visudo-clean
    const rules = sh('sudo -n cat /etc/sudoers.d/g4a-agents').stdout;
    const me = os.userInfo().username;
    assert.deepEqual(rules.split('\n').filter((x) => x && !x.startsWith('#') && !x.startsWith('Defaults')), [`${me} ALL=(g4a-a-alice) NOPASSWD: ${WRAP}/g4a-agent-exec`, `${me} ALL=(g4a-a-bob) NOPASSWD: ${WRAP}/g4a-agent-exec`]);
    assert.match(rules, /env_reset/); assert.equal(sh('sudo -n visudo -cf /etc/sudoers.d/g4a-agents').status, 0);

    // the launcher runs the command as the agent user, in its own clone, with the shim first on PATH
    const who = run('alice', 'id -un; pwd; command -v git; echo "$G4A_HOME"');
    assert.equal(who.status, 0, who.stderr);
    assert.deepEqual(who.stdout.trim().split('\n'), ['g4a-a-alice', `${H('alice')}/repo`, `${H('alice')}/.g4a/bin/git`, `${H('alice')}/.g4a`]);
    // ... and cannot escalate: no sudo to root/the operator/another agent, no launcher for bob
    for (const s of ['sudo -n true', 'sudo -n -u root id', `sudo -n -u ${me} id`, `sudo -n -u g4a-a-bob ${WRAP}/g4a-agent-exec id`, `sudo -n -u g4a-authority ${WRAP}/g4a-authority 0000000000000000 init-root e30=`]) {
      const r = run('alice', `${s} >/dev/null 2>&1; echo rc=$?`);
      assert.match(r.stdout, /rc=(?!0)\d+/, `alice: ${s}`);
    }
    // the launcher refuses when invoked directly (not as an agent user) and from root
    assert.notEqual(sh(`${WRAP}/g4a-agent-exec id`).status, 0);
    assert.notEqual(sh(`sudo -n ${WRAP}/g4a-agent-exec id`).status, 0);
    assert.notEqual(spawnSync('sudo', ['-n', process.execPath, '--no-warnings', CLI, 'run', '--agent', 'alice', '--', 'id'], { encoding: 'utf8', env }).status, 0, 'g4a run from root');
    // shell metacharacters in the command are passed as plain argv (no eval by the launcher)
    const inj = g4a(['run', '--agent', 'alice', '--', 'echo', '$(id -u);', '`id`', '&&', 'id']);
    assert.equal(inj.stdout.trim(), '$(id -u); `id` && id');
    // caller-supplied env (other than the allowlist) does not reach the agent
    const ev = spawnSync(process.execPath, ['--no-warnings', CLI, 'run', '--agent', 'alice', '--', 'sh', '-c', 'echo "${LD_PRELOAD:-none} ${G4A_RAW:-none} ${ANTHROPIC_API_KEY:-none}"'], { encoding: 'utf8', cwd: repo, env: { ...env, LD_PRELOAD: '/tmp/x.so', G4A_RAW: '1', ANTHROPIC_API_KEY: 'k-test' } });
    assert.equal(ev.stdout.trim(), 'none none k-test');

    // separation between agents: credential, clone/worktree, impersonation
    const credA = sh(`sudo -n find ${H('alice')}/.g4a/credentials -type f`).stdout.trim();
    assert.match(run('bob', `cat ${credA} 2>&1; echo rc=$?`).stdout, /Permission denied[\s\S]*rc=1/);
    assert.match(run('bob', `ls ${H('alice')} 2>&1; echo rc=$?`).stdout, /Permission denied/);
    const c = run('alice', 'g4a claim --agent alice --paths a.txt --witness true');
    assert.equal(J(c).ok, true, c.stdout + c.stderr);
    assert.match(run('bob', `echo X > ${H('alice')}/repo/.g4a/worktrees/alice/a.txt 2>/dev/null; echo rc=$?`).stdout, /rc=(?!0)\d+/);
    // bob cannot act as alice (own credential or none), the operator cannot act as anyone
    for (const cmd of [['claim', '--agent', 'alice', '--paths', 'b.txt', '--witness', 'true'], ['release', '--agent', 'alice'], ['promote', '--agent', 'alice']]) {
      const r = J(g4a(['run', '--agent', 'bob', '--', 'g4a', ...cmd]));
      assert.notEqual(r.ok, true, `bob ${cmd[0]} as alice: ${JSON.stringify(r)}`);
    }
    const id = JSON.parse(fs.readFileSync('/etc/g4a/authority.json', 'utf8'))[repoIdStr].id;
    const asBob = spawnSync('sudo', ['-n', '-u', 'g4a-a-bob', 'sudo', '-n', '-u', 'g4a-authority', `${WRAP}/g4a-authority`, id, 'permit', b64({ agent: 'alice' })], { encoding: 'utf8', cwd: '/tmp' });
    assert.match(asBob.stdout, /agent_identity/);
    for (const os2 of ['os-bind', 'os-unbind', 'os-policy']) assert.match(spawnSync('sudo', ['-n', '-u', 'g4a-a-bob', 'sudo', '-n', '-u', 'g4a-authority', `${WRAP}/g4a-authority`, id, os2, b64({ agent: 'bob', uid: 0 })], { encoding: 'utf8', cwd: '/tmp' }).stdout, /bad command/);
    const op = J(g4a(['claim', '--agent', 'op', '--paths', 'b.txt', '--witness', 'true']));
    assert.equal(op.ok, false); assert.match(JSON.stringify(op), /own OS users/);
    // an agent CLI started as the operator (agent marker set) is refused on writes in the repo
    const opw = sh(`cd ${repo} && PATH=${env.G4A_HOME}/bin:$PATH CLAUDECODE=1 git commit --allow-empty -qm x 2>&1; echo rc=$?`, { env });
    if (fs.existsSync(path.join(env.G4A_HOME, 'bin', 'git'))) assert.match(opw.stdout, /own OS users[\s\S]*rc=1/);
    // alice's full flow: edit in her own worktree, promote through the authority as her uid
    const p = run('alice', 'cd .g4a/worktrees/alice && echo A > a.txt && git add -A && git commit -qm a && g4a promote --agent alice');
    assert.equal(J(p).status, 'promoted', p.stdout + p.stderr);
    // bob syncs (launcher) and lands his own change on top
    const pb = run('bob', 'g4a claim --agent bob --paths b.txt --witness true >/dev/null && cd .g4a/worktrees/bob && test "$(cat a.txt)" = A && echo B > b.txt && git add -A && git commit -qm b && g4a promote --agent bob');
    assert.equal(J(pb).status, 'promoted', pb.stdout + pb.stderr);
    // each agent anchors its own ledger chain; bob cannot write alice's anchor ref
    const anc = `/var/lib/g4a-authority/repos/${id}/anchors.git`;
    const push = (ref) => run('bob', `/usr/bin/git push -q --receive-pack="sudo -n -u g4a-authority ${WRAP}/g4a-receive-pack" ${anc} HEAD:${ref} 2>&1; echo rc=$?`).stdout;
    for (const ref of ['refs/g4a/client-ledgers/carol', 'refs/g4a/client-ledger', 'refs/g4a/x']) assert.match(push(ref), /may only append[\s\S]*rc=(?!0)\d+/, ref);
    assert.match(sh(`cd /tmp && sudo -n -u g4a-authority git -C ${anc} for-each-ref --format='%(refname)'`).stdout, /client-ledgers\/alice[\s\S]*client-ledgers\/bob/);
    // the operator's checkout catches up with authority main
    const s = J(g4a(['authority', 'sync']));
    assert.equal(s.ok, true, JSON.stringify(s));
    assert.equal(sh(`git -C ${repo} show main:b.txt`).stdout.trim(), 'B');
    for (const n of ['alice', 'bob']) { const v = run(n, 'g4a verify'); assert.equal(J(v).ok, true, n + ': ' + v.stdout + v.stderr); }
    assert.equal(J(g4a(['authority', 'audit'])).ok, true);

    // cleanup leaves nothing: user, group, home, processes, tmp files, sudoers, maps, binding
    run('alice', 'sleep 300 >/dev/null 2>&1 & echo x > /tmp/g4a-au-left-alice; true');
    for (const n of ['alice', 'bob']) assert.equal(J(g4a(['agent', 'remove', n])).ok, true);
    for (const n of ['alice', 'bob']) {
      assert.notEqual(sh(`id g4a-a-${n}`).status, 0); assert.notEqual(sh(`getent group g4a-a-${n}`).status, 0);
      assert.equal(fs.existsSync(H(n)), false); assert.notEqual(sh(`pgrep -u ${uids[n]}`).status, 0);
      assert.equal(sh(`sudo -n find /tmp /var/tmp /dev/shm /var/lib /etc -xdev -uid ${uids[n]} 2>/dev/null`).stdout.trim(), '');
    }
    assert.equal(fs.existsSync('/etc/sudoers.d/g4a-agents'), false);
    assert.equal(fs.existsSync('/etc/g4a/agents.json'), false);
    assert.doesNotMatch(fs.readFileSync('/etc/g4a/authority.json', 'utf8'), /"agent"/);
    const st = sh(`sudo -n cat /var/lib/g4a-authority/repos/${id}/state/agents.json /var/lib/g4a-authority/repos/${id}/state/os-agents.json`).stdout;
    assert.doesNotMatch(st, /alice|bob/);
    assert.equal(fs.existsSync('/var/lib/g4a-agents'), false);
  } finally {
    g4a(['stop']);
    for (const n of ['alice', 'bob']) if (sh(`id g4a-a-${n}`).status === 0) g4a(['agent', 'remove', n]);
    if (repoIdStr) assert.match(g4a(['authority', 'uninstall', '--system', '--repo-id', repoIdStr], { cwd: '/tmp' }).stdout, /"ok":\s*true/);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
