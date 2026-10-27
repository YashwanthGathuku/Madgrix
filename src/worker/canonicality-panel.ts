import { canonCapFromPermit, type CanonCap } from "../lib/canoncap.ts";
import { buildCausalProofGraph, type CausalProofGraph } from "../lib/causal-proof.ts";
import { buildConflictCapsule, type ConflictCapsule } from "../lib/conflict-capsule.ts";
import type { AuthorityState } from "../lib/types.ts";

export interface CanonicalityProjection {
	canoncaps: CanonCap[];
	causal_proof: CausalProofGraph | null;
	conflict_capsule: ConflictCapsule | null;
	target_sha: string | null;
}

export async function projectCanonicality(state: AuthorityState): Promise<CanonicalityProjection> {
	const permits = Object.values(state.permits ?? {});
	const canoncaps = await Promise.all(permits.map((permit) => canonCapFromPermit(permit)));
	const consumed = [...permits].reverse().find((permit) => permit.consumed);
	const accepted = [...state.verdicts].reverse().find((verdict) => verdict.winner_sha);
	const target_sha = consumed?.winner_candidate_sha ?? accepted?.winner_sha ?? state.composition?.candidate_sha ?? null;
	const causal_proof = target_sha
		? await buildCausalProofGraph(state, target_sha).catch(() => null)
		: null;
	const conflict_capsule = state.composition?.status === "CONFLICTED"
		? await buildConflictCapsule(state.task.task_hash, state.composition)
		: null;
	return { canoncaps, causal_proof, conflict_capsule, target_sha };
}

function esc(value: unknown): string {
	return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
		'"': "&quot;",
		"'": "&#39;",
	})[ch] ?? ch);
}

function short(value: string, n = 14): string {
	return value.length <= n ? value : `${value.slice(0, n)}…`;
}

export function renderCanonicalityPanel(projection: CanonicalityProjection): string {
	const capCards = projection.canoncaps.length === 0
		? "<p>No CanonCap has been issued for this task.</p>"
		: projection.canoncaps.map((cap) => `<article class="madgrix-canon-card">
<h3>CanonCap <code>${esc(short(cap.canoncap_id))}</code></h3>
<p><strong>${esc(cap.status)}</strong> · single-use canonicalization authority</p>
<dl>
<div><dt>Candidate</dt><dd><code>${esc(cap.bindings.candidate_sha)}</code></dd></div>
<div><dt>Tree</dt><dd><code>${esc(short(cap.bindings.candidate_tree_sha256, 20))}</code></dd></div>
<div><dt>Evidence</dt><dd><code>${esc(short(cap.bindings.evaluation_bundle_hash, 20))}</code></dd></div>
<div><dt>Destination</dt><dd><code>${esc(cap.bindings.destination_repo)}</code></dd></div>
<div><dt>Expected HEAD</dt><dd><code>${esc(cap.bindings.expected_destination_head)}</code></dd></div>
</dl>
</article>`).join("");

	const capsule = projection.conflict_capsule;
	const conflictHtml = capsule
		? `<article class="madgrix-canon-card danger"><h3>Conflict Capsule <code>${esc(short(capsule.capsule_id))}</code></h3>
<p><strong>NO CANDIDATE EXISTS.</strong> Resolution creates a new SHA, invalidates old authority, and requires re-evaluation.</p>
<p>${capsule.conflicts.map((c) => `<code>${esc(c.path)}</code>`).join(" · ")}</p></article>`
		: `<p>No unresolved Conflict Capsule is present.</p>`;

	const proof = projection.causal_proof;
	const proofHtml = proof
		? `<article class="madgrix-canon-card"><h3>Causal Proof Graph</h3>
<p>Git proves ancestry. MADGRIX proves canonicality causality.</p>
<p><strong>Root</strong> <code>${esc(proof.causal_root)}</code></p>
<ol>${proof.nodes.map((node) => `<li><strong>${esc(node.label)}</strong> <code>${esc(short(node.digest, 20))}</code></li>`).join("")}</ol></article>`
		: `<p>No causal proof is available for the current task state.</p>`;

	return `<section id="madgrix-canonicality" class="madgrix-canonicality">
<style>
.madgrix-canonicality{margin:28px 0;padding:24px;border:1px solid #334155;border-radius:14px;background:#08111f;color:#e5edf8;font-family:system-ui,sans-serif}
.madgrix-canonicality h2{margin-top:0}.madgrix-canonicality code{overflow-wrap:anywhere;color:#7dd3fc}
.madgrix-canon-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px}
.madgrix-canon-card{padding:16px;border:1px solid #334155;border-radius:10px;background:#0f172a}.madgrix-canon-card.danger{border-color:#ef4444}
.madgrix-canon-card dl{margin:0}.madgrix-canon-card dl div{display:grid;grid-template-columns:110px 1fr;gap:8px;margin:6px 0}.madgrix-canon-card dt{color:#94a3b8}.madgrix-canon-card dd{margin:0}
</style>
<h2>MADGRIX Canonicality</h2>
<p><strong>Canonicality is a capability, not a branch permission.</strong></p>
<div class="madgrix-canon-grid">${capCards}${conflictHtml}${proofHtml}</div>
</section>`;
}
