# Spec amendment: queue-ancestry-reconciliation-v1 — forward Git ancestry may close a causal gap

**Status:** proposed · **Date:** 2026-10-14
**Amends:** `specs/amendments/queue-causal-tip-v1.md`. It does not replace that amendment.
**Affects:** `CLOUDFLARE_RUNTIME_MODEL.md` (FROZEN) §3, by this amendment file only. The frozen spec is not edited.

## (1) The live failure this records

On 2026-10-14 the deployed Worker `d17e65673abb6869ea224e7c953cbf936b6b3f32` ran task `task_048aca8851f9e0db31e0f391`. No canonical write, evaluation, verdict, permit, reservation, Workflow instance, or promotion container invocation happened.

Agent-02's first candidate `bd9573dbe170aa69ecdae2f71dfdfdece7a22e5c` was not applied. The runner's existing empty republish created `c19f0cece766982d8881ea78dc59ab3d3861a585`, whose parent is that first candidate. The authority tip was still the baseline `3b71d3a93e41fde8716ed411c8e3be3abb684be6`. The ledger contains `queue_event_requires_reconciliation`.

That ledger entry is evidence the republish reached the Artifacts subscription, the Queue, the Worker consumer, and TaskAuthority. Queue delivery was partial, not absent. Ingestion ran. The missing piece was a way to accept a later commit that truly descends from the observed tip when the intermediate push event never arrived.

This amendment does not repair that task. The task stays as evidence.

## (2) The causal rule that still holds

`queue-causal-tip-v1` remains in force. The observed tip is `latest_commit` when that is non-empty, otherwise `fork_base` when that is non-empty.

- Seen `event_key` → `ACK_DUP`.
- Unknown repository → `REJECTED_UNKNOWN_REPO`.
- `after` is already the observed tip → `ALREADY_OBSERVED`.
- `before` is the observed tip, and no closed refusal proof is attached → `APPLIED_NEW`.
- Anything else, with no proof → `REQUIRES_RECONCILIATION`. The tip stays.

A stale or out-of-order event still must not rewind `latest_commit`. This amendment does not delete the `before == observed tip` check and does not set `latest_commit = event.after` for every new key.

## (3) The one added transition

When `before` is not the observed tip and `after` is not the observed tip, the Worker may attach an ancestry proof read from Artifacts `repo.readCommit`. TaskAuthority applies it only when the proof shows:

`observed_tip ∈ Ancestors(event.after)`

in the commit parent graph, using every parent of a merge. The outcome is `RECONCILED_NEW`. `latest_commit` becomes `event.after`.

For the live shape `B ← C1 ← C2`, with the authority still at `B` and only the `C1 → C2` event delivered, the proof is the parent list of `C2` and then of `C1`. The tip moves from `B` to `C2`. It does not move to `C1`. `C1` was not recovered. The empty republish is a new commit SHA even when its tree is unchanged.

The walk visits at most 256 commits (`ANCESTRY_VISIT_BOUND`). A larger cone is retried. It is not treated as a non-ancestor and it is not applied.

## (4) Trust boundary

TaskAuthority does not call Artifacts. The Worker reads commit metadata and builds the proof. TaskAuthority, inside its storage transaction, checks the proof against the tip stored in that transaction:

1. The event shape is valid and the repository is a known contender.
2. `event.after` is not empty or the zero object id.
3. `proof.observed_tip` equals the current observed tip.
4. `proof.target_after` equals `event.after`.
5. The path is within the bound, the hashes are 40- or 64-character lowercase hex, and the path has no duplicate or cyclic representation.
6. Each child lists the parents the proof claims, and those edges reach the current tip by walking parents.
7. The direction is forward only. A path that would move the tip to an ancestor or a sibling is not a forward proof.

A proof that names a tip other than the current tip, or whose edges do not validate, returns `RETRY_RECONCILIATION`. The `event_key` is not recorded. The Worker re-reads state and builds a new proof. A Queue redelivery of the same push is therefore not stranded as `ACK_DUP`.

A read that throws, a commit object that is missing, or a walk that hits the bound is also retried in the Worker before `POST /event`. Those failures do not record the key.

`payload.commits` on `cf.artifacts.repo.pushed` is not the authority for this proof. It can be truncated. `repo.readCommit` is the lookup.

## (5) What is refused

- Stale: tip `C2`, event after `C1`, and `C2` is not an ancestor of `C1`. The tip stays `C2`.
- Divergent: tip `C`, event after `D`, with `C` and `D` both children of `B`. No reconciliation.
- Rewind: tip `C`, event `C → B`, and Artifacts shows `B` is an ancestor of `C` rather than a descendant. The Worker attaches a closed refusal proof (the cone of `B` was fully read and `C` is absent). TaskAuthority records `REQUIRES_RECONCILIATION` and does not move the tip. A direct `POST /event` that omits that proof still follows `queue-causal-tip-v1` and can `APPLIED_NEW` when `before` is the tip. The Queue consumer does not omit the proof when the walk shows the update is not forward.
- Unreadable commit, or a cone past 256 commits: retry, no permanent `ACK_DUP`.

## (6) Ledger

A successful gap close appends `queue_event_reconciled`. The hashed payload binds `event_key`, `contender_id`, `repo`, `ref`, `observed_tip`, `before`, `after`, `proof_digest`, and `proof_path_length`.

The wording for that entry is: forward ancestry reconciliation from the observed tip to a later delivered Git state. It is not recovery of the missing Queue event.

A second delivery of the same event is `ACK_DUP`. It does not append another `queue_event_reconciled` and it does not move the tip again.

A proven non-ancestor still uses `queue_event_requires_reconciliation`. The missing event is not back-filled.

## (7) What this amendment does not say

It does not say the deployed `d17e656` Worker has this behavior. It does not authorize a deploy. It does not change evaluation, the Verdict Seam, permits, promotion reservation, the promotion container, quarantine, or composition ownership. It does not claim production readiness, formal verification, or that a longer subscription wait is the repair. It does not mutate task `task_048aca8851f9e0db31e0f391` or `default/madgrix-demo-canonical`.
