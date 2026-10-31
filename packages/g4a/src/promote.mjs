// Promotion to main: scope check, merge ladder, required signed witnesses in bubblewrap,
// then a CAS ref update with a bounded retry when main moved. Verdicts follow the
// resolution-hardening shape: ADMIT (promoted), REFUSE, REVIEW (needs a human).
// Ladder: fast-forward -> git merge-tree (clean) -> [region analysis: both sides changed the
// same base lines => REVIEW, never auto-merged] -> Mergiraf in bwrap -> union of same-point
// pure insertions. Mergiraf/union output is never trusted alone: the frozen intent witnesses
// of every agent already promoted to main, plus the candidate's own, must pass on the result.
// Reused: scripts/lib/sandbox.mjs (runContained), scripts/resolvers/mergiraf-resolver.mjs,
// scripts/lib/resolve-ladder.mjs (findMergiraf), scripts/lib/fork-crew.mjs
// (conflictHunks, strayConflictMarkers), scripts/lib/safe-git.mjs.
import fs from 'node:fs';
import { spawnSync, spawn } from 'node:child_process';
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
// Changed base-line ranges from `git diff -U0`: {a, b} = b lines replaced starting at line a;
// b == 0 means a pure insertion after line a.
function hunks(top, from, to, file) {
  const d = safeGit(top, ['diff', '-U0', '--no-color', '--no-ext-diff', from, to, '--', file], { allowFailure: true }).stdout;
  const out = [];
  for (const line of d.split('\n')) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(line);
    if (m) { out.push({ a: Number(m[1]), b: m[2] === undefined ? 1 : Number(m[2]), add: [] }); continue; }
    if (out.length && line.startsWith('+') && !line.startsWith('+++')) out[out.length - 1].add.push(line.slice(1));
  }
  return out;
}
export function classifyRegions(ours, theirs) {
  const out = { sameRegion: [], adjacent: [], samePointInsert: [] };
  for (const o of ours) for (const t of theirs) {
    const tag = { ours: o, theirs: t };
    if (o.b > 0 && t.b > 0) {
      if (o.a < t.a + t.b && t.a < o.a + o.b) out.sameRegion.push(tag);
      else if (o.a + o.b === t.a || t.a + t.b === o.a) out.adjacent.push(tag);
    } else if (o.b === 0 && t.b === 0) {
      if (o.a === t.a) out.samePointInsert.push(tag);
    } else {
      const [m, i] = o.b > 0 ? [o, t] : [t, o];
      if (m.a <= i.a && i.a < m.a + m.b - 1) out.sameRegion.push(tag);
      else if (i.a === m.a - 1 || i.a === m.a + m.b - 1) out.adjacent.push(tag);
    }
  }
  return out;
}

// Apply both sides' (disjoint) hunks to the base; at a shared insertion point keep ours then
// theirs. Only reached when every overlap is a same-point pure insertion. Line-level
// `git merge-file --union` is not used: it aligns shared closing lines and interleaves blocks.
function unionInsertions(files, regionsHunks) {
  return files.map((f) => {
    const baseLines = f.base.split('\n');
    const { ours, theirs } = regionsHunks[f.path];
    const edits = [...ours.map((h) => ({ ...h, side: 0 })), ...theirs.map((h) => ({ ...h, side: 1 }))]
      .map((h) => ({ ...h, start: h.b === 0 ? h.a : h.a - 1 }))
      .sort((x, y) => x.start - y.start || x.side - y.side);
    const out = []; let i = 0;
    for (const e of edits) {
      if (e.start < i) return null;
      out.push(...baseLines.slice(i, e.start), ...e.add);
      i = e.start + e.b;
    }
    out.push(...baseLines.slice(i));
    return { path: f.path, text: out.join('\n') };
  });
}

export function combine(top, main, candidate, agent, log) {
  if (isAncestor(top, main, candidate)) return { sha: candidate, rung: 'fast-forward' };
  const mt = safeGit(top, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', main, candidate], { allowFailure: true });
  const [tree, ...conflicted] = splitNul(mt.stdout);
  if (mt.status > 1) throw new Error(`git merge-tree failed: ${mt.stderr.trim()}`);
  let finalTree = tree, rung = 'git-merge-tree';
  if (mt.status === 1) {
    const base = safeGit(top, ['merge-base', main, candidate]).stdout.trim();
    const files = [...new Set(conflicted)].map((p) => ({ path: p, base: show(top, base, p), sides: [{ text: show(top, main, p) }, { text: show(top, candidate, p) }] }));
    const raw = Object.fromEntries(files.map((f) => [f.path, { ours: hunks(top, base, main, f.path), theirs: hunks(top, base, candidate, f.path) }]));
    const regions = Object.fromEntries(files.map((f) => [f.path, classifyRegions(raw[f.path].ours, raw[f.path].theirs)]));
    const capsule = (reason) => ({ version: 'g4a-conflict-capsule/v1', reason, main, candidate, base, agent, regions, files: files.map((f) => ({ path: f.path, hunks: conflictHunks(f.base, f.sides[0].text, f.sides[1].text)?.hunks ?? null })) });
    // Both sides changed the same base lines: semantic overlap. Never auto-merged.
    if (Object.values(regions).some((r) => r.sameRegion.length)) return { review: capsule('same_region_overlap') };
    let resolved = mergirafRung(files, log);
    if (resolved) rung = 'mergiraf';
    else if (Object.values(regions).every((r) => r.adjacent.length === 0 && r.samePointInsert.length > 0)) {
      // only pure insertions at the same base point: keep both (ours then theirs); witnesses decide
      resolved = unionInsertions(files, raw);
      if (resolved.some((f) => !f)) resolved = null;
      if (resolved && resolved.some((f, i) => strayConflictMarkers(f.text, [files[i].base, ...files[i].sides.map((x) => x.text)]).length)) resolved = null;
      if (resolved) { rung = 'union-insertions'; log.push('union rung: same-point pure insertions kept from both sides'); }
    }
    if (!resolved) return { conflict: capsule('unresolved_conflict') };
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
      cwd: work, writable: [work], readOnly: [], hidden: sandboxHidden(), timeoutMs: 120_000, purpose: 'resolver',
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

// authority-side runs hide the authority's keys/state/repo from witnesses and resolvers
const sandboxHidden = () => (process.env.G4A_SANDBOX_HIDE || '').split(':').filter(Boolean);
// Run each witness command in bubblewrap on a detached checkout of `sha`.
const RUNNER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'witness-runner.mjs');
function runOne(spec) {
  return new Promise((resolve) => {
    const ch = spawn(process.execPath, ['--no-warnings', RUNNER], { stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    ch.stdout.on('data', (d) => { out += d; });
    ch.on('close', () => { try { resolve(JSON.parse(out)); } catch { resolve({ status: null, signal: null, timedOut: false, sandbox: 'runner_failed' }); } });
    ch.stdin.end(JSON.stringify(spec));
  });
}
export async function runWitnesses(top, sha, intents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g4a-witness-'));
  const wt = path.join(dir, 'tree');
  safeGit(top, ['worktree', 'add', '--quiet', '--detach', wt, sha]);
  try {
    const out = [];
    for (const { cmd, agents } of intents) {
      const r = await runOne({ command: cmd, cwd: wt, writable: [wt], timeoutMs: 300_000, purpose: 'witness', hidden: sandboxHidden(), env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir } });
      out.push({ cmd, agents, exit: r.status, signal: r.signal, timedOut: r.timedOut, sandbox: r.sandbox });
    }
    return out;
  } finally {
    safeGit(top, ['worktree', 'remove', '--force', wt], { allowFailure: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// One promotion attempt-set for a claim. `auth` is the Authority.
// Frozen intents: the witness commands of every claim already promoted in this repo (frozen at
// its promotion) plus the candidate's own. Deduplicated by command, tagged with owning agents.
function intentWitnesses(auth, claim) {
  const rows = auth.db.prepare('SELECT agent, witnesses FROM intents WHERE repo = ? ORDER BY frozen_at').all(claim.repo);
  const m = new Map();
  for (const { agent, witnesses } of [...rows.map((r) => ({ agent: r.agent, witnesses: JSON.parse(r.witnesses) })), { agent: claim.agent, witnesses: claim.witnesses }])
    for (const cmd of witnesses) { const e = m.get(cmd) ?? { cmd, agents: [] }; if (!e.agents.includes(agent)) e.agents.push(agent); m.set(cmd, e); }
  return [...m.values()];
}

// hooks: test-only injection points ({ afterIntent, afterCas }); production passes none.
export async function promote(auth, claim, jobId, hooks = {}) {
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
  // witness tamper guard: frozen witness files (pinned by blob hash at freeze) may not be
  // changed by a later promotion, including by the agent that owns them => REVIEW
  const pins = frozenPins(auth, claim.repo);
  const touched = changed.filter((f) => pins.has(f));
  if (touched.length) {
    await auth.serial(() => auth.appendLedger(claim.repo, 'promote_review', { job: jobId, claim: claim.id, agent: claim.agent, verdict: 'REVIEW', reason: 'witness_modified', paths: touched, owners: touched.map((f) => pins.get(f).agent) }));
    return { ok: false, status: 'review', verdict: 'REVIEW', reason: 'witness_modified', paths: touched };
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
        const e = await auth.serial(async () => { const r = await auth.appendLedger(claim.repo, 'promote', { ...p, recovered: true }); freezeIntent(auth, claim, p.main_after); return r; });
        return { ok: true, status: 'recovered', main: p.main_after, entry: e.seq };
      }
      const e = await auth.serial(() => auth.appendLedger(claim.repo, 'promote_noop', { job: jobId, claim: claim.id, agent: claim.agent, candidate, main }));
      return { ok: true, status: 'already_in_main', main, entry: e.seq };
    }
    if (attempt === 0) {
      const lastMain = auth.db.prepare("SELECT payload FROM ledger WHERE repo = ? AND kind IN ('promote', 'main_external') ORDER BY seq DESC LIMIT 1").get(claim.repo);
      const lp = lastMain && JSON.parse(lastMain.payload);
      const expect = lp && (lp.batch?.main_after ?? lp.main_after ?? lp.actual);
      if (expect && expect !== main) await auth.serial(() => auth.appendLedger(claim.repo, 'main_external', { job: jobId, expected: expect, actual: main, note: 'main moved outside the g4a daemon' }));
    }
    const c = combine(top, main, candidate, claim.agent, log);
    if (c.review) {
      const capsule_sha256 = await sha256Hex(canonicalJson(c.review));
      await auth.serial(() => auth.appendLedger(claim.repo, 'promote_review', { job: jobId, claim: claim.id, agent: claim.agent, verdict: 'REVIEW', reason: 'same_region_overlap', capsule_sha256, files: c.review.files.map((f) => f.path) }));
      return { ok: false, status: 'review', verdict: 'REVIEW', reason: 'same_region_overlap', capsule: c.review, log };
    }
    if (c.conflict) {
      const capsule_sha256 = await sha256Hex(canonicalJson(c.conflict));
      await auth.serial(() => auth.appendLedger(claim.repo, 'promote_refused', { job: jobId, claim: claim.id, agent: claim.agent, verdict: 'REFUSE', reason: 'unresolved_conflict', capsule_sha256, files: c.conflict.files.map((f) => f.path) }));
      return { ok: false, status: 'refused', verdict: 'REFUSE', reason: 'unresolved_conflict', capsule: c.conflict, log };
    }
    const drift = [...pins].filter(([f, p]) => blobAt(top, c.sha, f) !== p.blob).map(([f]) => f);
    if (drift.length) {
      await auth.serial(() => auth.appendLedger(claim.repo, 'promote_review', { job: jobId, claim: claim.id, agent: claim.agent, verdict: 'REVIEW', reason: 'witness_tamper', paths: drift }));
      return { ok: false, status: 'review', verdict: 'REVIEW', reason: 'witness_tamper', paths: drift };
    }
    const results = await runWitnesses(top, c.sha, intentWitnesses(auth, claim));
    const tree = safeGit(top, ['rev-parse', `${c.sha}^{tree}`]).stdout.trim();
    const report = { version: 'g4a-witness-report/v1', merged: c.sha, tree, candidate, main_before: main, rung: c.rung, results };
    const signer = await auth.signer();
    const { signature } = await signer.sign(Buffer.from(canonicalJson(report)));
    if (!results.every((r) => r.exit === 0)) {
      await auth.serial(() => auth.appendLedger(claim.repo, 'promote_refused', { job: jobId, claim: claim.id, agent: claim.agent, verdict: 'REFUSE', reason: 'witness_failed', witness: { report, signature, keyId: signer.keyId } }));
      return { ok: false, status: 'refused', verdict: 'REFUSE', reason: 'witness_failed', rung: c.rung, results };
    }
    const payload = { job: jobId, claim: claim.id, agent: claim.agent, candidate, main_before: main, main_after: c.sha, rung: c.rung, verdict: 'ADMIT', witness: { report, signature, keyId: signer.keyId }, attempts: attempt + 1 };
    await auth.serial(() => auth.appendLedger(claim.repo, 'promote_intent', payload));
    hooks.afterIntent?.();
    // a non-bare checkout of main: update-ref alone would leave its index/worktree stale
    const mco = mainCheckout(top, main);
    if (mco?.dirty) {
      await auth.serial(() => auth.appendLedger(claim.repo, 'promote_refused', { job: jobId, claim: claim.id, agent: claim.agent, verdict: 'REFUSE', reason: 'main_checked_out_dirty', worktree: mco.path, detail: mco.dirty }));
      return { ok: false, status: 'refused', verdict: 'REFUSE', reason: 'main_checked_out_dirty', worktree: mco.path };
    }
    // compare-and-swap: only moves main if it is still where we merged against
    const cas = safeGit(top, ['update-ref', '-m', `g4a promote ${claim.agent}`, 'refs/heads/main', c.sha, main || ZERO], { allowFailure: true });
    if (cas.status !== 0) { log.push(`CAS lost on attempt ${attempt}: main moved`); continue; }
    if (mco) {
      // clean and at main_before: two-way read-tree moves index+files; refuses rather than clobbers
      const rt = safeGit(mco.path, ['read-tree', '-u', '-m', main, c.sha], { allowFailure: true });
      payload.main_checkout = { path: mco.path, updated: rt.status === 0 };
      if (rt.status !== 0) log.push(`main checkout ${mco.path} not updated: ${rt.stderr.trim()}`);
    }
    hooks.afterCas?.();
    const e = await auth.serial(async () => { const r = await auth.appendLedger(claim.repo, 'promote', payload); freezeIntent(auth, claim, c.sha); return r; });
    return { ok: true, status: 'promoted', verdict: 'ADMIT', main: c.sha, rung: c.rung, attempts: attempt + 1, entry: e.seq, log };
  }
  await auth.serial(() => auth.appendLedger(claim.repo, 'promote_refused', { job: jobId, claim: claim.id, agent: claim.agent, reason: 'cas_retries_exhausted' }));
  return { ok: false, status: 'refused', reason: 'cas_retries_exhausted', log };
}

// ---- parallel batch landing ----
// Queued land requests whose changes touch disjoint files (and none of each other's witness
// paths) are combined into one chain m0 -> m1 -> ... -> final (every candidate is a parent of
// its step, so each exact pushed SHA lands), the union of their frozen + own witnesses runs ONCE
// on `final`, and one CAS moves main m0 -> final. Each claim still gets its own promote_intent
// and promote ledger entry (main_before/main_after = its chain step; batch.main_after = final)
// carrying the shared signed witness report. Anything the batch cannot take cleanly (refusals,
// review, conflicts, mergiraf/union rungs, pins, recovery) goes through promote() unchanged.
const BATCH_RUNGS = new Set(['fast-forward', 'git-merge-tree']);
export const MAX_BATCH = 32;
const hitsGlobs = (globs, f) => globs.some((g) => f === g || globMatchesPath(g, f));
// items: [{ claim, jobId }] in queue order. Runs under the caller's lock. Returns
// { results: Map(jobId -> result), batch: plan | null }; items in neither are deferred.
export async function planBatch(auth, items) {
  const results = new Map();
  if (!items.length) return { results, batch: null };
  const top = repoTop(items[0].claim.worktree);
  const repo = items[0].claim.repo;
  const pins = frozenPins(auth, repo);
  const eligible = [], solo = [];
  for (const it of items) {
    const { claim, jobId } = it;
    if (claim.repo !== repo) { solo.push(it); continue; }
    const done = auth.db.prepare("SELECT 1 FROM ledger WHERE repo = ? AND kind IN ('promote', 'promote_intent') AND json_extract(payload, '$.job') = ?").get(repo, jobId);
    const candidate = safeGit(top, ['rev-parse', '--verify', `refs/heads/${claim.branch}^{commit}`]).stdout.trim();
    if (done || candidate === claim.baseline || !claim.witnesses.length || isAncestor(top, candidate, readMain(top))) { solo.push(it); continue; }
    const changed = splitNul(safeGit(top, ['diff', '--name-only', '-z', `${claim.baseline}...${candidate}`]).stdout);
    if (!changed.length || changed.some((f) => !claim.paths.some((g) => globMatchesPath(g, f)) || pins.has(f))) { solo.push(it); continue; }
    eligible.push({ ...it, candidate, changed });
  }
  for (const it of solo) results.set(it.jobId, await promote(auth, it.claim, it.jobId));
  if (eligible.length === 0) return { results, batch: null };
  const m0 = readMain(top);
  let cur = m0;
  const used = new Set(), wglobs = [], members = [];
  for (const it of eligible) {
    if (members.length >= MAX_BATCH) break;
    const wp = it.claim.witness_paths ?? [];
    if (it.changed.some((f) => used.has(f) || hitsGlobs(wglobs, f)) || members.some((m) => m.changed.some((f) => hitsGlobs(wp, f)))) continue;
    const c = combine(top, cur, it.candidate, it.claim.agent, []);
    if (!c.sha || !BATCH_RUNGS.has(c.rung)) continue;
    members.push({ ...it, before: cur, after: c.sha, rung: c.rung });
    cur = c.sha; for (const f of it.changed) used.add(f); wglobs.push(...wp);
  }
  const drift = members.length >= 2 && [...pins].some(([f, p]) => blobAt(top, cur, f) !== p.blob);
  if (members.length < 2 || drift) {
    // nothing to batch: land the oldest eligible request alone (the rest stay queued)
    const first = eligible[0];
    results.set(first.jobId, await promote(auth, first.claim, first.jobId));
    return { results, batch: null };
  }
  const lastMain = auth.db.prepare("SELECT payload FROM ledger WHERE repo = ? AND kind IN ('promote', 'main_external') ORDER BY seq DESC LIMIT 1").get(repo);
  const lp = lastMain && JSON.parse(lastMain.payload);
  const expect = lp && (lp.batch?.main_after ?? lp.main_after ?? lp.actual);
  if (expect && expect !== m0) await auth.serial(() => auth.appendLedger(repo, 'main_external', { job: members[0].jobId, expected: expect, actual: m0, note: 'main moved outside the g4a daemon' }));
  const wit = new Map();
  for (const m of members) for (const w of intentWitnesses(auth, m.claim)) {
    const e = wit.get(w.cmd) ?? { cmd: w.cmd, agents: [] };
    for (const a of w.agents) if (!e.agents.includes(a)) e.agents.push(a);
    wit.set(w.cmd, e);
  }
  return { results, batch: { top, repo, m0, final: cur, members, witnesses: [...wit.values()] } };
}
// Runs WITHOUT the authority lock: witnesses on the exact final tree.
export const runBatchWitnesses = (b) => runWitnesses(b.top, b.final, b.witnesses);
// Under the lock again. stillValid(members) re-checks claims and pushed refs. Returns a Map of
// results; an empty map means "deferred" (main or a claim changed while witnesses ran).
export async function commitBatch(auth, b, results, stillValid = () => true) {
  const out = new Map();
  const { top, repo, m0, final, members } = b;
  if (readMain(top) !== m0 || !stillValid(members)) return out;
  const tree = safeGit(top, ['rev-parse', `${final}^{tree}`]).stdout.trim();
  const report = { version: 'g4a-witness-report/v1', merged: final, tree, candidate: null, main_before: m0, rung: 'batch',
    batch: members.map((m) => ({ job: m.jobId, claim: m.claim.id, agent: m.claim.agent, candidate: m.candidate, main_before: m.before, main_after: m.after, rung: m.rung })), results };
  const signer = await auth.signer();
  const { signature } = await signer.sign(Buffer.from(canonicalJson(report)));
  if (!results.every((r) => r.exit === 0)) {
    // attribute the failure: each claim goes through the full sequential ladder on its own
    await auth.serial(() => auth.appendLedger(repo, 'batch_witness_failed', { jobs: members.map((m) => m.jobId), final, witness: { report, signature, keyId: signer.keyId } }));
    for (const m of members) out.set(m.jobId, await promote(auth, m.claim, m.jobId));
    return out;
  }
  const id = `b_${final.slice(0, 12)}`;
  const witness = { report, signature, keyId: signer.keyId };
  const payloads = members.map((m, i) => ({ job: m.jobId, claim: m.claim.id, agent: m.claim.agent, candidate: m.candidate, main_before: m.before, main_after: m.after, rung: m.rung, verdict: 'ADMIT', witness, attempts: 1,
    batch: { id, index: i, size: members.length, main_before: m0, main_after: final } }));
  for (const p of payloads) await auth.serial(() => auth.appendLedger(repo, 'promote_intent', p));
  const mco = mainCheckout(top, m0);
  if (mco?.dirty) {
    for (const m of members) {
      await auth.serial(() => auth.appendLedger(repo, 'promote_refused', { job: m.jobId, claim: m.claim.id, agent: m.claim.agent, verdict: 'REFUSE', reason: 'main_checked_out_dirty', worktree: mco.path, detail: mco.dirty }));
      out.set(m.jobId, { ok: false, status: 'refused', verdict: 'REFUSE', reason: 'main_checked_out_dirty', worktree: mco.path });
    }
    return out;
  }
  const cas = safeGit(top, ['update-ref', '-m', `g4a promote batch ${id} (${members.length})`, 'refs/heads/main', final, m0 || ZERO], { allowFailure: true });
  if (cas.status !== 0) return out;
  let checkout;
  if (mco) { const rt = safeGit(mco.path, ['read-tree', '-u', '-m', m0, final], { allowFailure: true }); checkout = { path: mco.path, updated: rt.status === 0 }; }
  for (let i = 0; i < members.length; i++) {
    const m = members[i], p = payloads[i];
    if (checkout) p.main_checkout = checkout;
    const e = await auth.serial(async () => { const r = await auth.appendLedger(repo, 'promote', p); freezeIntent(auth, m.claim, m.after); return r; });
    out.set(m.jobId, { ok: true, status: 'promoted', verdict: 'ADMIT', main: final, rung: m.rung, attempts: 1, entry: e.seq, batch: { id, index: i, size: members.length } });
  }
  return out;
}

export function freezeIntent(auth, claim, mainAfter) {
  // pin every witness-referenced file (globs expanded on the promoted tree) by blob hash
  const top = repoTop(claim.worktree);
  const pins = {};
  const files = splitNul(safeGit(top, ['ls-tree', '-r', '--name-only', '-z', mainAfter]).stdout);
  for (const g of claim.witness_paths ?? []) for (const f of files) if (f === g || globMatchesPath(g, f)) pins[f] = blobAt(top, mainAfter, f);
  auth.db.prepare('INSERT OR IGNORE INTO intents (repo, claim, agent, witnesses, frozen_at, pins) VALUES (?, ?, ?, ?, ?, ?)')
    .run(claim.repo, claim.id, claim.agent, JSON.stringify(claim.witnesses), new Date().toISOString(), JSON.stringify(pins));
}
function frozenPins(auth, repo) {
  const m = new Map();
  for (const r of auth.db.prepare('SELECT agent, pins FROM intents WHERE repo = ? ORDER BY frozen_at').all(repo))
    for (const [f, blob] of Object.entries(JSON.parse(r.pins || '{}'))) m.set(f, { agent: r.agent, blob });
  return m;
}
function blobAt(top, sha, f) {
  const r = safeGit(top, ['rev-parse', '--verify', '--quiet', `${sha}:${f}`], { allowFailure: true });
  return r.status === 0 ? r.stdout.trim() : null;
}
// the worktree (if any) that has refs/heads/main checked out; {dirty} when it is unsafe to move
export function mainCheckout(top, main) {
  const lines = safeGit(top, ['worktree', 'list', '--porcelain']).stdout.split('\n');
  let cur = null, found = null;
  for (const l of lines) {
    if (l.startsWith('worktree ')) cur = { path: l.slice(9) };
    else if (l === 'bare' && cur) cur.bare = true;
    else if (l === 'branch refs/heads/main' && cur && !cur.bare) found = cur;
  }
  if (!found) return null;
  const head = safeGit(found.path, ['rev-parse', 'HEAD'], { allowFailure: true }).stdout.trim();
  if (head !== main) return { ...found, dirty: `HEAD ${head} != main ${main}` };
  safeGit(found.path, ['update-index', '-q', '--refresh'], { allowFailure: true });
  const st = safeGit(found.path, ['status', '--porcelain', '--untracked-files=no']).stdout;
  return st.trim() ? { ...found, dirty: 'uncommitted changes' } : found;
}
