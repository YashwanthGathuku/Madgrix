// Phase 2 default promotion path: the client never moves main itself from agent work. It pushes
// the claim branch to the authority with a one-time permit, asks the authority to land it (the
// authority runs the full ladder: scope, frozen witness pins, combine, witnesses, signed ledger,
// anchors), then fast-forwards the local main to the authority's main and mirrors the outcome
// into the local ledger (with the authority entry hash) and frozen intents.
import { safeGit } from '../../../scripts/lib/safe-git.mjs';
import { repoTop } from './authority.mjs';
import { freezeIntent, mainCheckout } from './promote.mjs';
import { callAsync, pushAgentAsync, fetchMainAsync } from './authority-client.mjs';

const ZERO = '0'.repeat(40);
const rev = (top, r) => safeGit(top, ['rev-parse', '--verify', '--quiet', r], { allowFailure: true }).stdout.trim();

export async function promoteViaAuthority(auth, claim, jobId, loc, credential) {
  const top = repoTop(claim.worktree);
  const done = auth.db.prepare("SELECT 1 FROM ledger WHERE repo = ? AND kind = 'promote' AND json_extract(payload, '$.job') = ?").get(claim.repo, jobId);
  if (done) return { ok: true, status: 'already_recorded' };
  const candidate = rev(top, `refs/heads/${claim.branch}^{commit}`);
  if (!candidate || candidate === claim.baseline) return { ok: false, status: 'refused', reason: 'no commits on the claim branch' };
  const pushed = await pushAgentAsync(loc, top, claim.agent, candidate, credential);
  const base = { job: jobId, claim: claim.id, agent: claim.agent, via: `authority:${loc.mode}` };
  if (!pushed.ok) {
    await auth.serial(() => auth.appendLedger(claim.repo, 'promote_refused', { ...base, reason: 'authority_push_refused', detail: pushed.error }));
    return { ok: false, status: 'refused', reason: 'authority_push_refused', detail: pushed.error };
  }
  const r = await callAsync(loc, 'land', { agent: claim.agent, candidate, job: jobId, credential });
  if (!(r.ok && (r.status === 'promoted' || r.status === 'recovered' || r.status === 'already_in_main' || r.status === 'already_recorded'))) {
    const kind = r.status === 'review' ? 'promote_review' : 'promote_refused';
    await auth.serial(() => auth.appendLedger(claim.repo, kind, { ...base, verdict: r.verdict ?? (r.status === 'review' ? 'REVIEW' : 'REFUSE'), reason: r.reason ?? r.error ?? 'authority refused', paths: r.paths, authority_entry: r.authority_entry }));
    return { ...r, via: base.via };
  }
  // sync local main to the authority main (fast-forward only, CAS, clean checkout only).
  // Serialized in-process: concurrent jobs land in one authority batch and then sync here.
  return auth.serial(() => syncLocal(auth, claim, jobId, loc, top, candidate, base, r));
}
async function syncLocal(auth, claim, jobId, loc, top, candidate, base, r) {
  const local = rev(top, 'refs/heads/main');
  const scratch = `refs/g4a/authority-main-${String(jobId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)}`;
  let amain;
  try { amain = await fetchMainAsync(loc, top, scratch); }
  finally { const old = rev(top, scratch); if (old) safeGit(top, ['update-ref', '-d', scratch, old], { allowFailure: true }); }
  const anc = (a, b) => safeGit(top, ['merge-base', '--is-ancestor', a, b], { allowFailure: true }).status === 0;
  // a concurrent job of the same batch may already have moved local main past this one
  const target = local && local !== amain && anc(amain, local) ? local : amain;
  if (local && local !== target && !anc(local, target)) {
    await auth.appendLedger(claim.repo, 'promote_refused', { ...base, reason: 'local_main_diverged', local, authority: amain });
    return { ok: false, status: 'refused', reason: 'local_main_diverged', local, authority: amain, landed_on_authority: true };
  }
  const mco = mainCheckout(top, local);
  if (mco?.dirty) {
    await auth.appendLedger(claim.repo, 'promote_refused', { ...base, reason: 'main_checked_out_dirty', worktree: mco.path, landed_on_authority: true });
    return { ok: false, status: 'refused', reason: 'main_checked_out_dirty', worktree: mco.path, landed_on_authority: true };
  }
  const payload = { ...base, candidate, main_before: local, main_after: target, verdict: 'ADMIT', rung: r.rung, authority_entry: r.authority_entry, authority_status: r.status, ...(r.batch ? { authority_batch: r.batch } : {}) };
  if (local !== target) {
    const cas = safeGit(top, ['update-ref', '-m', `g4a promote ${claim.agent} (authority)`, 'refs/heads/main', target, local || ZERO], { allowFailure: true });
    if (cas.status !== 0) return { ok: false, status: 'refused', reason: 'local main moved during sync', landed_on_authority: true };
    if (mco) { const rt = safeGit(mco.path, ['read-tree', '-u', '-m', local, target], { allowFailure: true }); payload.main_checkout = { path: mco.path, updated: rt.status === 0 }; }
  }
  const x = await auth.appendLedger(claim.repo, 'promote', payload); freezeIntent(auth, claim, target);
  return { ok: true, status: 'promoted', verdict: 'ADMIT', via: base.via, main: target, rung: r.rung, entry: x.seq, authority_entry: r.authority_entry, witnesses: r.results, ...(r.batch ? { batch: r.batch } : {}) };
}
