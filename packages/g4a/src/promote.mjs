// Promotion to main: scope check, merge (rung 0 git merge-tree, rung 1 Mergiraf in a
// bubblewrap sandbox), required signed witnesses in bubblewrap, then a CAS ref update
// with a bounded retry when main moved. Replaces the Cloudflare promotion workflow.
// Reused: scripts/lib/sandbox.mjs (runContained), scripts/resolvers/mergiraf-resolver.mjs,
// scripts/lib/resolve-ladder.mjs (findMergiraf), scripts/lib/fork-crew.mjs
// (conflictHunks, strayConflictMarkers), scripts/lib/safe-git.mjs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeGit } from '../../../scripts/lib/safe-git.mjs';
import { runContained } from '../../../scripts/lib/sandbox.mjs';
import { findMergiraf } from '../../../scripts/lib/resolve-ladder.mjs';
import { conflictHunks, strayConflictMarkers } from '../../../scripts/lib/fork-crew.mjs';
import { canonicalJson, sha256Hex } from '../../../src/lib/canonical.ts';
import { globMatchesPath, repoTop, splitNul } from './authority.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const MERGIRAF_RESOLVER = path.join(ROOT, 'scripts/resolvers/mergiraf-resolver.mjs');
const ZERO = '0'.repeat(40);
const ID_ENV = { GIT_AUTHOR_NAME: 'g4a', GIT_AUTHOR_EMAIL: 'g4a@localhost', GIT_COMMITTER_NAME: 'g4a', GIT_COMMITTER_EMAIL: 'g4a@localhost' };
export const MAX_CAS_RETRIES = 3;

const show = (top, rev, file) => {
  const r = safeGit(top, ['cat-file', 'blob', `${rev}:${file}`], { allowFailure: true });
  return r.status === 0 ? r.stdout : '';
};
const isAncestor = (top, a, b) => safeGit(top, ['merge-base', '--is-ancestor', a, b], { allowFailure: true }).status === 0;
const readMain = (top) => safeGit(top, ['rev-parse', '--verify', 'refs/heads/main^{commit}']).stdout.trim();

// Merge candidate onto main. Returns { sha, rung } or { conflict: capsule }.
function combine(top, main, candidate, agent, log) {
  if (isAncestor(top, main, candidate)) return { sha: candidate, rung: 'fast-forward' };
  const mt = safeGit(top, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', main, candidate], { allowFailure: true });
  const [tree, ...conflicted] = splitNul(mt.stdout);
  if (mt.status > 1) throw new Error(`git merge-tree failed: ${mt.stderr.trim()}`);
  let finalTree = tree, rung = 'git-merge-tree';
  if (mt.status === 1) {
    const base = safeGit(top, ['merge-base', main, candidate]).stdout.trim();
    const files = [...new Set(conflicted)].map((p) => ({ path: p, base: show(top, base, p), sides: [{ text: show(top, main, p) }, { text: show(top, candidate, p) }] }));
    const resolved = mergirafRung(files, log);
    if (!resolved) {
      const capsule = { version: 'g4a-conflict-capsule/v1', main, candidate, base, agent, files: files.map((f) => ({ path: f.path, hunks: conflictHunks(f.base, f.sides[0].text, f.sides[1].text)?.hunks ?? null })) };
      return { conflict: capsule };
    }
    // rebuild the merged tree with the resolved blobs
    const idx = path.join(os.tmpdir(), `g4a-index-${process.pid}-${Date.now()}`);
    try {
      const env = { GIT_INDEX_FILE: idx };
      safeGit(top, ['read-tree', tree], { env });
      for (const f of resolved) {
        const blob = safeGit(top, ['hash-object', '-w', '--stdin'], { input: f.text }).stdout.trim();
        const mode = (safeGit(top, ['ls-tree', candidate, '--', f.path]).stdout.split(' ')[0]) || '100644';
        safeGit(top, ['update-index', '--add', '--cacheinfo', `${mode},${blob},${f.path}`], { env });
      }
      finalTree = safeGit(top, ['write-tree'], { env }).stdout.trim();
    } finally { fs.rmSync(idx, { force: true }); }
    rung = 'mergiraf';
  }
  const sha = safeGit(top, ['commit-tree', finalTree, '-p', main, '-p', candidate, '-m', `g4a promote ${agent}`], { env: ID_ENV }).stdout.trim();
  return { sha, rung };
}

function mergirafRung(files, log) {
  const bin = findMergiraf();
  if (!bin) { log.push('mergiraf not installed; rung skipped'); return null; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g4a-resolve-'));
  try {
    const work = path.join(dir, 'work'); fs.mkdirSync(work);
    const conflictPath = path.join(dir, 'conflict.json');
    fs.writeFileSync(conflictPath, JSON.stringify({ files }));
    const r = runContained({
      command: `${JSON.stringify(process.execPath)} ${JSON.stringify(MERGIRAF_RESOLVER)}`,
      cwd: work, writable: [work], readOnly: [], timeoutMs: 120_000, purpose: 'resolver',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, MADGRIX_CONFLICT_PATH: conflictPath, MERGIRAF_BIN: bin },
    });
    log.push(`mergiraf rung: exit ${r.status} sandbox ${r.sandbox}${r.stderrTail ? ` (${r.stderrTail})` : ''}`);
    if (r.status !== 0) return null;
    const out = [];
    for (const f of files) {
      const p = path.join(work, f.path);
      if (!fs.existsSync(p)) return null;
      const text = fs.readFileSync(p, 'utf8');
      if (strayConflictMarkers(text, [f.base, ...f.sides.map((s) => s.text)]).length) return null;
      out.push({ path: f.path, text });
    }
    return out;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// Run each witness command in bubblewrap on a detached checkout of `sha`.
function runWitnesses(top, sha, commands) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g4a-witness-'));
  const wt = path.join(dir, 'tree');
  safeGit(top, ['worktree', 'add', '--quiet', '--detach', wt, sha]);
  try {
    return commands.map((cmd) => {
      const r = runContained({ command: cmd, cwd: wt, writable: [wt], timeoutMs: 300_000, purpose: 'witness', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir } });
      return { cmd, exit: r.status, signal: r.signal, timedOut: r.timedOut, sandbox: r.sandbox };
    });
  } finally {
    safeGit(top, ['worktree', 'remove', '--force', wt], { allowFailure: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// One promotion attempt-set for a claim. `auth` is the Authority.
export async function promote(auth, claim, jobId) {
  const top = repoTop(claim.worktree);
  const log = [];
  const candidate = safeGit(top, ['rev-parse', '--verify', `refs/heads/${claim.branch}^{commit}`]).stdout.trim();
  // crash recovery: the CAS may have landed before the daemon died
  const done = auth.db.prepare("SELECT 1 FROM ledger WHERE repo = ? AND kind = 'promote' AND json_extract(payload, '$.job') = ?").get(claim.repo, jobId);
  if (done) return { ok: true, status: 'already_recorded' };
  if (candidate === claim.baseline) return { ok: false, status: 'refused', reason: 'no commits on the claim branch' };
  const changed = splitNul(safeGit(top, ['diff', '--name-only', '-z', `${claim.baseline}...${candidate}`]).stdout);
  const out = changed.filter((f) => !claim.paths.some((g) => globMatchesPath(g, f)));
  if (out.length) {
    await auth.serial(() => auth.appendLedger(claim.repo, 'promote_refused', { job: jobId, claim: claim.id, agent: claim.agent, reason: 'out_of_scope', paths: out }));
    return { ok: false, status: 'refused', reason: 'out_of_scope', paths: out };
  }
  if (!claim.witnesses.length) return { ok: false, status: 'refused', reason: 'claim has no witness commands; witnesses are required' };
  for (let attempt = 0; attempt <= MAX_CAS_RETRIES; attempt++) {
    const main = readMain(top);
    if (isAncestor(top, candidate, main)) {
      // either the daemon crashed between CAS and the ledger write (an intent exists), or
      // the candidate already reached main some other way (noop, no witness claimed)
      const intent = auth.db.prepare("SELECT payload FROM ledger WHERE repo = ? AND kind = 'promote_intent' AND json_extract(payload, '$.job') = ? ORDER BY seq DESC LIMIT 1").get(claim.repo, jobId);
      const p = intent && JSON.parse(intent.payload);
      if (p && isAncestor(top, p.main_after, main)) {
        const e = await auth.serial(() => auth.appendLedger(claim.repo, 'promote', { ...p, recovered: true }));
        return { ok: true, status: 'recovered', main: p.main_after, entry: e.seq };
      }
      const e = await auth.serial(() => auth.appendLedger(claim.repo, 'promote_noop', { job: jobId, claim: claim.id, agent: claim.agent, candidate, main }));
      return { ok: true, status: 'already_in_main', main, entry: e.seq };
    }
    const c = combine(top, main, candidate, claim.agent, log);
    if (c.conflict) {
      const capsule_sha256 = await sha256Hex(canonicalJson(c.conflict));
      await auth.serial(() => auth.appendLedger(claim.repo, 'promote_refused', { job: jobId, claim: claim.id, agent: claim.agent, reason: 'unresolved_conflict', capsule_sha256, files: c.conflict.files.map((f) => f.path) }));
      return { ok: false, status: 'refused', reason: 'unresolved_conflict', capsule: c.conflict, log };
    }
    const results = runWitnesses(top, c.sha, claim.witnesses);
    const tree = safeGit(top, ['rev-parse', `${c.sha}^{tree}`]).stdout.trim();
    const report = { version: 'g4a-witness-report/v1', merged: c.sha, tree, candidate, main_before: main, rung: c.rung, results };
    const signer = await auth.signer();
    const { signature } = await signer.sign(Buffer.from(canonicalJson(report)));
    if (!results.every((r) => r.exit === 0)) {
      await auth.serial(() => auth.appendLedger(claim.repo, 'promote_refused', { job: jobId, claim: claim.id, agent: claim.agent, reason: 'witness_failed', witness: { report, signature, keyId: signer.keyId } }));
      return { ok: false, status: 'refused', reason: 'witness_failed', results };
    }
    const payload = { job: jobId, claim: claim.id, agent: claim.agent, candidate, main_before: main, main_after: c.sha, rung: c.rung, witness: { report, signature, keyId: signer.keyId }, attempts: attempt + 1 };
    await auth.serial(() => auth.appendLedger(claim.repo, 'promote_intent', payload));
    if (process.env.G4A_TEST_CRASH_AFTER_INTENT === '1') process.kill(process.pid, 'SIGKILL');
    // compare-and-swap: only moves main if it is still where we merged against
    const cas = safeGit(top, ['update-ref', '-m', `g4a promote ${claim.agent}`, 'refs/heads/main', c.sha, main || ZERO], { allowFailure: true });
    if (cas.status !== 0) { log.push(`CAS lost on attempt ${attempt}: main moved`); continue; }
    if (process.env.G4A_TEST_CRASH_AFTER_CAS === '1') process.kill(process.pid, 'SIGKILL');
    const e = await auth.serial(() => auth.appendLedger(claim.repo, 'promote', payload));
    return { ok: true, status: 'promoted', main: c.sha, rung: c.rung, attempts: attempt + 1, entry: e.seq, log };
  }
  await auth.serial(() => auth.appendLedger(claim.repo, 'promote_refused', { job: jobId, claim: claim.id, agent: claim.agent, reason: 'cas_retries_exhausted' }));
  return { ok: false, status: 'refused', reason: 'cas_retries_exhausted', log };
}
