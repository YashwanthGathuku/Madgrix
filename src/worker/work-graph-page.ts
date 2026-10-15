/**
 * Judge-facing task Mission Control for GET /tasks/:id/graph.
 *
 * This is a projection of canonical WorkGraph + stored authority records.
 * It must never decide eligibility, invent a candidate, classify a new
 * conflict, verify a signature, or expose secrets. All governance decisions
 * remain in the protocol/authority layer.
 */

import type { PromotionBundle } from "../lib/attestation.ts";
import type {
	AuthorityState,
	CompositionRecord,
	ConflictRisk,
	EvaluationBundle,
	PermitRecord,
	WorkClaim,
} from "../lib/types.ts";
import { buildWorkGraph, type WorkGraph } from "../lib/work-graph.ts";

export interface WorkGraphViewOptions {
	fixtureBanner?: string;
	graph?: WorkGraph;
}

interface MemberView {
	agent_id: string;
	role: string;
	intent: string;
	scope: string[];
	claim_work_id: string | null;
	commit_sha: string | null;
	status: string;
}

interface CrewView {
	contender_id: string;
	parent: { agent_id: string; contender_id: string; fork_repo: string };
	members: MemberView[];
	baseline: string;
	outcome: string;
}

interface DepView {
	from: string;
	to: string;
	relation: string;
	detail: string | null;
	risk: string | null;
}

interface OverlapView {
	path: string;
	classification: string;
	agents: string[];
}

interface PageView {
	intent: string;
	taskId: string;
	taskStatus: string;
	baselineCommit: string;
	crew: CrewView | null;
	dependencies: DepView[];
	overlaps: OverlapView[];
	excerpts: CompositionRecord["files"];
	compositionState: string | null;
	promotableSha: string | null;
	memberShaHidden: boolean;
	contributionShas: string[];
}

const STATE_NOTES: Record<string, string> = {
	PENDING: "no candidate",
	COMPOSING: "no candidate",
	COMPOSED: "candidate only while this state is recorded",
	CONFLICTED: "no candidate",
	RESOLVING: "no candidate",
	RESOLVED: "new candidate only while this state is recorded",
};

const RISK_ORDER: Record<ConflictRisk, number> = {
	GREEN: 0,
	AMBER: 1,
	RED: 2,
	BLOCKED: 3,
};

function esc(value: string): string {
	return value.replace(/[&<>"']/g, (ch) => {
		if (ch === "&") return "&amp;";
		if (ch === "<") return "&lt;";
		if (ch === ">") return "&gt;";
		if (ch === '"') return "&quot;";
		return "&#39;";
	});
}

function text(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed === "" ? null : trimmed;
}

function num(value: unknown): string {
	return typeof value === "number" && Number.isFinite(value) ? String(value) : "not recorded";
}

function short(value: unknown, length = 12): string {
	const raw = text(value);
	return raw ? raw.slice(0, length) : "not recorded";
}

function roleLabel(role: string, id: string): string {
	if (role === "parent" || id === "parent") return "parent";
	if (role === "api") return "API agent";
	if (role === "ui") return "UI agent";
	if (role === "test") return "test/integration agent";
	return text(role) ?? id;
}

function reportDetail(state: AuthorityState, from: string, to: string): { detail: string | null; risk: string | null } {
	const report = (state.conflict_reports ?? []).find((row) => row.claim_a === from && row.claim_b === to);
	if (!report) return { detail: null, risk: null };
	return { detail: text(report.explanation), risk: text(report.risk) };
}

function pageView(state: AuthorityState, graph: WorkGraph): PageView {
	const crew: CrewView | null = graph.crew
		? {
				contender_id: graph.crew.contender_id,
				parent: {
					agent_id: graph.crew.parent.agent_id,
					contender_id: graph.crew.parent.contender_id,
					fork_repo: graph.crew.parent.fork_repo,
				},
				members: graph.crew.members.map((member) => ({
					agent_id: member.agent_id,
					role: member.role,
					intent: member.intent,
					scope: [...member.scope],
					claim_work_id: member.claim_work_id,
					commit_sha: member.commit_sha,
					status: member.status,
				})),
				baseline: graph.crew.baseline,
				outcome: graph.crew.outcome,
			}
		: null;
	const overlaps: OverlapView[] = graph.overlaps.map((file) => ({
		path: file.path,
		classification: file.classification,
		agents: [...file.agents],
	}));
	const dependencies: DepView[] = graph.dependencies.map((edge) => {
		const stored = edge.relation === "claim-conflict" ? reportDetail(state, edge.from, edge.to) : { detail: null, risk: null };
		return { from: edge.from, to: edge.to, relation: edge.relation, detail: stored.detail, risk: stored.risk };
	});
	const contribution = new Set<string>();
	for (const member of graph.members) if (member.commit_sha) contribution.add(member.commit_sha);
	const sameRecord = state.composition?.status === graph.composition_state;
	if (sameRecord && state.composition) {
		for (const sha of state.composition.contributing_shas) if (sha) contribution.add(sha);
	}
	const storedSha = sameRecord ? (state.composition?.candidate_sha ?? null) : null;
	const memberShaHidden =
		graph.candidate_sha === null && typeof storedSha === "string" && storedSha.length > 0 && contribution.has(storedSha);
	const paths = new Set(overlaps.map((file) => file.path));
	return {
		intent: text(graph.task.intent) ?? "not recorded",
		taskId: text(graph.task.task_id) ?? "not recorded",
		taskStatus: text(graph.task.status) ?? "not recorded",
		baselineCommit: text(graph.task.baseline_commit) ?? "not recorded",
		crew,
		dependencies,
		overlaps,
		excerpts: sameRecord ? (state.composition?.files ?? []).filter((file) => paths.has(file.path)) : [],
		compositionState: graph.composition_state,
		promotableSha: graph.candidate_sha,
		memberShaHidden,
		contributionShas: [...contribution],
	};
}

function missionSummary(state: AuthorityState, view: PageView): string {
	const latestVerdict = state.verdicts[state.verdicts.length - 1];
	const promoted = Object.keys(state.promotion_bundles ?? {}).length;
	const verifierReports = state.verdict_reports.length;
	const activeClaims = state.claims.filter((claim) => claim.status === "claimed" || claim.status === "active").length;
	return `<section class="mission-strip" id="mission-summary">
<div><span>Agents</span><strong>${view.crew?.members.length ?? 0}</strong></div>
<div><span>Active claims</span><strong>${activeClaims}</strong></div>
<div><span>Evaluations</span><strong>${Object.keys(state.evaluations).length}</strong></div>
<div><span>Blind reports</span><strong>${verifierReports}</strong></div>
<div><span>Verdict</span><strong>${esc(text(latestVerdict?.state) ?? "none")}</strong></div>
<div><span>Promotions</span><strong>${promoted}</strong></div>
</section>`;
}

function crewSection(view: PageView): string {
	if (!view.crew) return `<section id="crew"><h2>CrewContender</h2><p>No CrewContender is recorded.</p></section>`;
	const parent = view.crew.parent;
	const parentCard = `<article class="agent parent">
<h3>parent <code>${esc(parent.agent_id)}</code></h3>
<dl>
<div><dt>Intent</dt><dd>not recorded</dd></div>
<div><dt>Scope</dt><dd>not recorded</dd></div>
<div><dt>Status</dt><dd>authority parent</dd></div>
<div><dt>Commit</dt><dd>none</dd></div>
<div><dt>Contender</dt><dd><code>${esc(parent.contender_id)}</code></dd></div>
<div><dt>Fork</dt><dd><code>${esc(parent.fork_repo)}</code></dd></div>
</dl>
</article>`;
	const members = view.crew.members
		.map((member) => {
			const scope = member.scope.length > 0 ? esc(member.scope.join(", ")) : "not recorded";
			const commit = member.commit_sha ? `<code>${esc(member.commit_sha)}</code>` : "none";
			return `<article class="agent">
<h3>${esc(roleLabel(member.role, member.agent_id))} <code>${esc(member.agent_id)}</code></h3>
<dl>
<div><dt>Intent</dt><dd>${member.intent ? esc(member.intent) : "not recorded"}</dd></div>
<div><dt>Scope</dt><dd>${scope}</dd></div>
<div><dt>Status</dt><dd>${member.status ? esc(member.status) : "not recorded"}</dd></div>
<div><dt>Commit</dt><dd>${commit}</dd></div>
<div><dt>Claim</dt><dd>${member.claim_work_id ? `<code>${esc(member.claim_work_id)}</code>` : "none"}</dd></div>
</dl>
</article>`;
		})
		.join("");
	return `<section id="crew"><h2>CrewContender</h2>
<p class="note">One collaborative promotion unit. Member commits are contribution SHAs. The promotable candidate is in Composition.</p>
<p class="meta">Baseline <code>${esc(view.crew.baseline)}</code></p>
<div class="crew">${parentCard}${members}</div></section>`;
}

function reportsForClaim(state: AuthorityState, workId: string) {
	return (state.conflict_reports ?? []).filter((report) => report.claim_a === workId || report.claim_b === workId);
}

function knownRisk(value: string): value is ConflictRisk {
	return value === "GREEN" || value === "AMBER" || value === "RED" || value === "BLOCKED";
}

function clearanceOf(state: AuthorityState, claim: WorkClaim): { label: string; reports: ReturnType<typeof reportsForClaim> } {
	const reports = reportsForClaim(state, claim.work_id);
	let worst: ConflictRisk | null = null;
	let unknown = false;
	for (const report of reports) {
		const risk = String(report.risk);
		if (!knownRisk(risk)) {
			unknown = true;
			continue;
		}
		if (!worst || RISK_ORDER[risk] > RISK_ORDER[worst]) worst = risk;
	}
	if (unknown) return { label: "REVIEW", reports };
	if (!worst || worst === "GREEN") return { label: "CLEAR", reports };
	if (worst === "AMBER") return { label: "CAUTION", reports };
	return { label: "HOLD", reports };
}

function claimDimensions(claim: WorkClaim): string {
	const parts = [
		claim.scope.paths.length ? `${claim.scope.paths.length} path` : "",
		claim.scope.symbols.length ? `${claim.scope.symbols.length} symbol` : "",
		claim.contracts.modifies.length || claim.contracts.reads.length ? `${claim.contracts.modifies.length + claim.contracts.reads.length} contract` : "",
		claim.interfaces.length ? `${claim.interfaces.length} interface` : "",
		claim.schema_changes.length ? `${claim.schema_changes.length} schema` : "",
	].filter(Boolean);
	return parts.length ? parts.join(" · ") : "scope not recorded";
}

function semanticClearanceSection(state: AuthorityState): string {
	if (state.claims.length === 0) {
		return `<section id="clearance"><h2>Semantic clearance</h2><p>No WorkClaim is recorded.</p></section>`;
	}
	const cards = state.claims
		.map((claim) => {
			const clearance = clearanceOf(state, claim);
			const conflicts = clearance.reports
				.map((report) => {
					const other = report.claim_a === claim.work_id ? report.claim_b : report.claim_a;
					const layers = Object.entries(report.layers)
						.filter(([, values]) => values.length > 0)
						.map(([name, values]) => `${name}: ${values.join(", ")}`)
						.join(" · ");
					return `<li><strong>${esc(String(report.risk))}</strong> with <code>${esc(other)}</code>${layers ? ` · ${esc(layers)}` : ""}${text(report.explanation) ? `<p>${esc(report.explanation)}</p>` : ""}</li>`;
				})
				.join("");
			return `<article class="clearance-card">
<div class="clearance-head"><div><p class="kicker">${esc(claim.status)}</p><h3>${esc(claim.agent)} <code>${esc(claim.work_id)}</code></h3></div><strong class="clearance-state">${esc(clearance.label)}</strong></div>
<dl>
<div><dt>Baseline</dt><dd><code>${esc(claim.baseline)}</code></dd></div>
<div><dt>Dimensions</dt><dd>${esc(claimDimensions(claim))}</dd></div>
<div><dt>Lease</dt><dd>${esc(claim.lease.expires_at)}</dd></div>
<div><dt>Paths</dt><dd>${claim.scope.paths.length ? esc(claim.scope.paths.join(", ")) : "none"}</dd></div>
<div><dt>Symbols</dt><dd>${claim.scope.symbols.length ? esc(claim.scope.symbols.join(", ")) : "none"}</dd></div>
</dl>
${conflicts ? `<details><summary>${clearance.reports.length} recorded interaction${clearance.reports.length === 1 ? "" : "s"}</summary><ul>${conflicts}</ul></details>` : `<p class="note">No recorded conflict interaction.</p>`}
</article>`;
		})
		.join("");
	return `<section id="clearance"><h2>Semantic clearance</h2>
<p class="note">Read-only projection of stored WorkClaims and conflict reports. CLEAR/CAUTION/HOLD does not grant authority and does not replace the verdict or permit gates.</p>
${cards}</section>`;
}

function graphSection(state: AuthorityState, view: PageView): string {
	const deps =
		view.dependencies.length === 0
			? `<p>No dependency is recorded.</p>`
			: `<ul class="deps">${view.dependencies
					.map((edge) => {
						const risk = edge.risk ? `<p>Recorded risk ${esc(edge.risk)}</p>` : "";
						const detail = edge.detail ? `<p>${esc(edge.detail)}</p>` : "";
						return `<li class="dep"><span>${esc(edge.relation)}</span> <code>${esc(edge.from)}</code> → <code>${esc(edge.to)}</code>${risk}${detail}</li>`;
					})
					.join("")}</ul>`;
	const overlaps =
		view.overlaps.length === 0
			? `<p>No overlap is recorded.</p>`
			: `<ul class="deps">${view.overlaps
					.map((file) => `<li class="dep"><span>overlap</span> ${esc(file.path)} · ${esc(file.classification)} · ${esc(file.agents.join(", ") || "no agent recorded")}</li>`)
					.join("")}</ul>`;
	const reports = state.conflict_reports ?? [];
	const claimEdges = view.dependencies.some((edge) => edge.relation === "claim-conflict");
	const none = reports.length === 0 && !claimEdges ? `<p>No conflict reports are stored.</p>` : "";
	return `<section id="graph"><h2>Live work graph</h2>
<p class="note">Dependencies and overlaps are recorded relations. This page does not classify them.</p>
<h3>Dependencies</h3>${deps}
<h3>Overlaps</h3>${overlaps}
${none}</section>`;
}

function stateItem(name: string, current: string | null): string {
	const now = name === current ? " now" : "";
	return `<p class="state${now}">${name}<span>${STATE_NOTES[name]}</span></p>`;
}

function stateMap(current: string | null): string {
	const left = ["PENDING", "COMPOSING", "COMPOSED"].map((name) => stateItem(name, current)).join("");
	const right = ["CONFLICTED", "RESOLVING", "RESOLVED"].map((name) => stateItem(name, current)).join("");
	return `<div class="map">
<p class="note">The marked name is the recorded composition state. The other names are Git4Agents states. This is not a timeline of this task.</p>
<div class="fork"><div>${left}</div><div>${right}</div></div>
</div>`;
}

function candidatePlate(view: PageView): string {
	if (view.promotableSha) return `<p class="candidate" id="promotable">PROMOTABLE CANDIDATE: <code>${esc(view.promotableSha)}</code></p>`;
	return `<p class="candidate" id="promotable">PROMOTABLE CANDIDATE: NONE</p>`;
}

function overlapExcerpt(file: CompositionRecord["files"][number]): string {
	const sides = (file.sides ?? [])
		.map((side) => `<div class="side"><p><code>${esc(text(side.agent_id) ?? "not recorded")}</code> ${esc(text(side.role) ?? "")}</p>
<p>Intent: ${esc(text(side.intent) ?? "not recorded")}</p>
<p>Contributing SHA <code>${esc(text(side.sha) ?? "none")}</code></p>
<pre>${text(side.excerpt) ? esc(side.excerpt) : "no excerpt stored"}</pre></div>`)
		.join("");
	return `<article class="overlap"><h3>${esc(text(file.path) ?? "not recorded")}</h3>
<p>Reason: ${esc(text(file.classification) ?? "not recorded")}</p>${sides}</article>`;
}

function compositionSection(view: PageView): string {
	if (!view.compositionState) return `<section id="composition"><h2>Composition</h2><p class="stamp">none</p><p>No composition is recorded.</p>${stateMap(null)}</section>`;
	const fileHtml = view.excerpts.length === 0 ? `<p>No overlap file is stored.</p>` : view.excerpts.map((file) => overlapExcerpt(file)).join("");
	const hidden = view.memberShaHidden ? `<p>The stored SHA is a member contribution. It is not shown as the promotable candidate.</p>` : "";
	return `<section id="composition"><h2>Composition</h2>
<p class="stamp">${esc(view.compositionState)}</p>
${stateMap(view.compositionState)}
${candidatePlate(view)}
${hidden}
${fileHtml}</section>`;
}

function resolutionSection(view: PageView): string {
	if (!view.compositionState) return `<section id="resolution"><h2>Resolution</h2><p>No composition is recorded.</p></section>`;
	const listed = view.contributionShas.map((sha) => `<li><code>${esc(sha)}</code></li>`).join("");
	const left = `<div><p class="kicker">Member contribution SHAs</p><ul>${listed || "<li>none</li>"}</ul></div>`;
	if (!view.promotableSha) {
		const why = view.memberShaHidden ? `<p>The stored SHA is a member contribution. It is not a new candidate.</p>` : `<p>Resolution state: unresolved.</p>`;
		return `<section id="resolution"><h2>Resolution</h2>${why}<div class="seam">${left}<p class="arrow">→</p><div class="candidate"><p class="kicker">Promotable candidate</p><p>NONE</p></div></div></section>`;
	}
	const fresh = view.compositionState === "RESOLVED";
	const kicker = fresh ? "New candidate" : "Promotable candidate";
	const note = fresh ? `<p>This SHA is a new software state. It still has to pass evaluation, the verdict seam, and a permit.</p>` : `<p>Resolution state: ${esc(view.compositionState)}.</p>`;
	return `<section id="resolution"><h2>Resolution</h2>${note}<div class="seam">${left}<p class="arrow">→</p><div class="candidate"><p class="kicker">${kicker}</p><code>${esc(view.promotableSha)}</code></div></div></section>`;
}

function mark(ok: boolean): string {
	return `<span class="${ok ? "pass" : "fail"}">${ok ? "pass" : "fail"}</span>`;
}

function gateList(bundle: EvaluationBundle): string {
	const admission = bundle.admission;
	return `<dl class="gates">
<div><dt>Baseline</dt><dd>${mark(admission.exact_baseline)}</dd></div>
<div><dt>Scope</dt><dd>${mark(admission.scope_compliance)}</dd></div>
<div><dt>Evaluation integrity</dt><dd>${mark(admission.no_eval_tampering)}</dd></div>
<div><dt>Tests</dt><dd>hidden oracle ${mark(bundle.hidden_oracle.passed)} (${num(bundle.hidden_oracle.total)} total) · regressions ${mark(bundle.regressions.passed)} (${num(bundle.regressions.total)} total)</dd></div>
<div><dt>Security</dt><dd>${mark(bundle.security_policy.passed)}</dd></div>
<div><dt>Provenance / policy</dt><dd>provenance ${mark(admission.provenance_complete)} · tool states ${mark(admission.valid_tool_states)} · static analysis ${mark(bundle.static_analysis.passed)}</dd></div>
<div><dt>Semantic checks</dt><dd>${mark(bundle.semantic_checks.passed)} (${num(bundle.semantic_checks.total)} total)</dd></div>
<div><dt>Tainted</dt><dd>${bundle.tainted ? "yes" : "no"}</dd></div>
<div><dt>Bundle hash</dt><dd><code>${esc(text(bundle.bundle_hash) ?? "not recorded")}</code></dd></div>
</dl>`;
}

function evaluationSection(state: AuthorityState, view: PageView): string {
	const candidate = view.promotableSha;
	const bundles = Object.entries(state.evaluations ?? {});
	const parts: string[] = [];
	if (candidate && !Object.hasOwn(state.evaluations ?? {}, candidate)) parts.push(`<p>No evaluation bundle is stored for the promotable candidate <code>${esc(candidate)}</code>.</p>`);
	if (bundles.length === 0 && !candidate) parts.push(`<p>No evaluation bundle is stored.</p>`);
	for (const [sha, bundle] of bundles) {
		const relation = candidate && sha === candidate ? "Promotable candidate." : "Stored bundle. Not the promotable candidate.";
		parts.push(`<article class="bundle"><h3><code>${esc(sha)}</code></h3><p>${relation}</p>${gateList(bundle)}</article>`);
	}
	return `<section id="evaluation"><h2>Evaluation</h2>${parts.join("")}</section>`;
}

function verifierBoardSection(state: AuthorityState): string {
	const reports = state.verdict_reports ?? [];
	const registered = Object.keys(state.verifier_keys ?? {});
	if (registered.length === 0 && reports.length === 0) return `<section id="blind-verifiers"><h2>Blind verifier board</h2><p>No verifier activity is recorded.</p></section>`;
	const rows = registered.map((verifierId) => {
		const report = reports.find((row) => row.verifier_id === verifierId);
		const committed = Object.hasOwn(state.verifier_commitments ?? {}, verifierId);
		const revealed = Object.hasOwn(state.verifier_reveals ?? {}, verifierId);
		return `<tr><td><code>${esc(verifierId)}</code></td><td>${committed ? "committed" : "no commitment"}</td><td>${revealed ? "revealed" : "not revealed"}</td><td>${report ? esc(report.verdict) : "no report"}</td><td>${report ? `<code>${esc(report.candidate_label)}</code>` : "none"}</td></tr>`;
	}).join("");
	const unregistered = reports.filter((report) => !registered.includes(report.verifier_id)).map((report) => `<tr><td><code>${esc(report.verifier_id)}</code></td><td>not registered in view</td><td>not shown</td><td>${esc(report.verdict)}</td><td><code>${esc(report.candidate_label)}</code></td></tr>`).join("");
	return `<section id="blind-verifiers"><h2>Blind verifier board</h2>
<p class="note">Shows stored commitment/reveal/report state. Signatures, report reasons, key material and candidate-to-SHA mappings stay off this page.</p>
<div class="table-wrap"><table><thead><tr><th>Verifier</th><th>Commit</th><th>Reveal</th><th>Verdict</th><th>Blind label</th></tr></thead><tbody>${rows}${unregistered}</tbody></table></div>
</section>`;
}

function verdictSection(state: AuthorityState): string {
	const verdicts = state.verdicts ?? [];
	const latest = verdicts[verdicts.length - 1];
	const verdictHtml = latest
		? `<p class="stamp">${esc(text(latest.state) ?? "not recorded")}</p><p>Winner ${text(latest.winner_sha) ? `<code>${esc(latest.winner_sha ?? "")}</code>` : "none"}.</p>${verdicts.length > 1 ? `<p>Showing the latest of ${verdicts.length} verdict records.</p>` : ""}<ul>${(latest.reasons ?? []).map((reason) => `<li>${esc(text(reason) ?? "not recorded")}</li>`).join("") || "<li>no reason recorded</li>"}</ul>`
		: `<p>No verdict is recorded.</p>`;
	const quarantines = Object.values(state.quarantine ?? {});
	const quarantineHtml = quarantines.length === 0
		? `<h3>Quarantine</h3><p>No quarantine record is stored.</p>`
		: `<h3>Quarantine</h3><ul>${quarantines.map((record) => `<li><code>${esc(text(record.contender_id) ?? "not recorded")}</code> ${esc(text(record.status) ?? "not recorded")} · ${esc(text(record.trigger) ?? "not recorded")}</li>`).join("")}</ul>`;
	return `<section id="verdict"><h2>Verdict seam</h2>${verdictHtml}${quarantineHtml}</section>`;
}

function permitRelation(view: PageView, permit: PermitRecord): string {
	const winner = text(permit.winner_candidate_sha);
	if (!view.compositionState) return "No composition is recorded.";
	if (view.promotableSha && winner === view.promotableSha) return "This permit names the promotable candidate.";
	if (winner && view.contributionShas.includes(winner)) return "This permit names a member contribution SHA, not the promotable candidate.";
	if (!view.promotableSha) return "The promotable candidate is none.";
	return "This permit names a different SHA from the promotable candidate.";
}

function authorizationSection(state: AuthorityState, view: PageView): string {
	const permits = Object.values(state.permits ?? {});
	if (permits.length === 0) return `<section id="authorization"><h2>Authorization</h2><p>No permit is recorded.</p></section>`;
	const cards = permits.map((permit) => `<article class="permit"><h3><code>${esc(text(permit.permit_id) ?? "not recorded")}</code></h3>
<dl>
<div><dt>Candidate SHA</dt><dd><code>${esc(text(permit.winner_candidate_sha) ?? "none")}</code></dd></div>
<div><dt>Destination head</dt><dd><code>${esc(text(permit.expected_destination_head) ?? "none")}</code></dd></div>
<div><dt>Permit status</dt><dd>${permit.consumed ? "consumed" : "issued, not consumed"}</dd></div>
<div><dt>Destination</dt><dd><code>${esc(text(permit.destination_repo) ?? "not recorded")}</code></dd></div>
<div><dt>Bound evaluation</dt><dd><code>${esc(text(permit.evaluation_bundle_hash) ?? "not recorded")}</code></dd></div>
</dl><p>${esc(permitRelation(view, permit))}</p></article>`).join("");
	return `<section id="authorization"><h2>Authorization</h2>${cards}</section>`;
}

function bundlesOf(state: AuthorityState): Array<{ permitId: string; bundle: PromotionBundle; permit: PermitRecord | undefined }> {
	return Object.entries(state.promotion_bundles ?? {}).map(([permitId, bundle]) => ({ permitId, bundle, permit: state.permits?.[permitId] }));
}

function promotionSection(state: AuthorityState): string {
	const bundles = bundlesOf(state);
	const consumed = Object.values(state.permits ?? {}).filter((permit) => permit.consumed);
	if (bundles.length === 0 && consumed.length === 0) return `<section id="promotion"><h2>Promotion</h2><p>No promotion is recorded.</p></section>`;
	const fromBundles = bundles.map(({ permit, bundle }) => {
		const authorized = permit ? text(permit.winner_candidate_sha) : null;
		const ship = bundle.ship;
		return `<article class="ship"><dl>
<div><dt>Authorized SHA</dt><dd>${authorized ? `<code>${esc(authorized)}</code>` : "permit not stored"}</dd></div>
<div><dt>Promoted SHA</dt><dd><code>${esc(text(ship?.commit) ?? "none")}</code></dd></div>
<div><dt>Canonical destination</dt><dd><code>${esc(text(ship?.repo) ?? "not recorded")}</code></dd></div>
<div><dt>Promoted from</dt><dd><code>${esc(text(ship?.base) ?? "none")}</code></dd></div>
</dl></article>`;
	}).join("");
	const consumedWithoutBundle = consumed.filter((permit) => !state.promotion_bundles?.[permit.permit_id]).map((permit) => `<p>Permit <code>${esc(text(permit.permit_id) ?? "not recorded")}</code> is consumed. No promotion bundle is stored, so this page does not name a promoted SHA.</p>`).join("");
	return `<section id="promotion"><h2>Promotion</h2>${fromBundles}${consumedWithoutBundle}</section>`;
}

function whyCanonicalSection(state: AuthorityState): string {
	const bundles = bundlesOf(state);
	if (bundles.length === 0) return `<section id="why-canonical"><h2>Why canonical?</h2><p>No canonical promotion is recorded for this task.</p></section>`;
	const cards = bundles.map(({ permitId, permit, bundle }) => {
		const ship = bundle.ship;
		const candidate = permit ? text(permit.winner_candidate_sha) : null;
		const promoted = text(ship?.commit);
		const evalBundle = candidate ? state.evaluations?.[candidate] : undefined;
		const latestVerdict = [...state.verdicts].reverse().find((verdict) => !candidate || verdict.winner_sha === candidate) ?? state.verdicts[state.verdicts.length - 1];
		const contender = permit ? state.contenders?.[permit.contender_id] : undefined;
		const exactMatch = Boolean(candidate && promoted && candidate === promoted);
		const evidenceMatch = Boolean(permit && evalBundle && permit.evaluation_bundle_hash === evalBundle.bundle_hash);
		const headMatch = Boolean(permit && ship?.base && permit.expected_destination_head === ship.base);
		return `<article class="why-card">
<div class="why-title"><div><p class="kicker">Canonical decision record</p><h3>${promoted ? `<code>${esc(promoted)}</code>` : "promoted SHA not recorded"}</h3></div><strong>${exactMatch ? "EXACT STATE MATCH" : "STATE MISMATCH"}</strong></div>
<dl class="why-grid">
<div><dt>Why?</dt><dd>${esc(state.task.intent)}</dd></div>
<div><dt>Task</dt><dd><code>${esc(state.task.task_id)}</code></dd></div>
<div><dt>Baseline</dt><dd><code>${esc(state.task.baseline_commit)}</code></dd></div>
<div><dt>Producer</dt><dd>${contender ? `<code>${esc(contender.agent_id)}</code> via <code>${esc(contender.contender_id)}</code>` : "not recorded"}</dd></div>
<div><dt>Candidate</dt><dd>${candidate ? `<code>${esc(candidate)}</code>` : "not recorded"}</dd></div>
<div><dt>Competing evaluations</dt><dd>${Object.keys(state.evaluations ?? {}).length}</dd></div>
<div><dt>Verdict</dt><dd>${latestVerdict ? esc(latestVerdict.state) : "not recorded"}</dd></div>
<div><dt>Permit</dt><dd><code>${esc(permitId)}</code>${permit ? ` · ${permit.consumed ? "consumed" : "not consumed"}` : " · permit record absent"}</dd></div>
<div><dt>Evidence binding</dt><dd>${evidenceMatch ? "MATCH" : "NO MATCH SHOWN"}</dd></div>
<div><dt>Destination-head binding</dt><dd>${headMatch ? "MATCH" : "NO MATCH SHOWN"}</dd></div>
<div><dt>Canonical destination</dt><dd><code>${esc(text(ship?.repo) ?? "not recorded")}</code></dd></div>
<div><dt>Result</dt><dd>${promoted ? `<code>${esc(promoted)}</code>` : "not recorded"}</dd></div>
</dl>
<p class="seal-line">${exactMatch ? "WHAT WAS AUTHORIZED = WHAT WAS SHIPPED" : "The stored records do not show an exact candidate-to-ship equality."}</p>
</article>`;
	}).join("");
	return `<section id="why-canonical"><h2>Why canonical?</h2>
<p class="note">Explanation is assembled only from stored task, evaluation, verdict, permit and promotion records. It does not perform offline verification.</p>
${cards}</section>`;
}

function activitySection(state: AuthorityState): string {
	const entries = [...(state.ledger ?? [])].slice(-12);
	if (entries.length === 0) return `<section id="activity"><h2>Activity timeline</h2><p>No ledger entry is stored.</p></section>`;
	const items = entries.map((entry) => `<li><span>#${entry.seq}</span><time>${esc(entry.ts)}</time><strong>${esc(entry.kind)}</strong><code>${esc(short(entry.payload_hash))}</code></li>`).join("");
	return `<section id="activity"><h2>Activity timeline</h2><p class="note">Latest authority-ledger events. Payloads and secrets are not rendered.</p><ol class="timeline">${items}</ol></section>`;
}

function proofSection(state: AuthorityState): string {
	const bundles = bundlesOf(state);
	const offline = `<p class="kicker">Offline verification</p><p>Not run</p>`;
	if (bundles.length === 0) return `<section id="proof"><h2>Proof</h2><p>No promotion bundle is stored.</p>${offline}</section>`;
	const cards = bundles.map(({ bundle }) => {
		const envelopes = bundle.statements ?? [];
		const signed = envelopes.filter((envelope) => (envelope.signatures ?? []).some((signature) => text(signature.sig))).length;
		const named = text(bundle.authority_pubkey_der_hex);
		const prefix = named ? named.slice(0, 12) : null;
		return `<article class="proof"><dl>
<div><dt>Bundle</dt><dd>version ${esc(String(bundle.version ?? "not recorded"))} · ${envelopes.length} envelopes · ship <code>${esc(text(bundle.ship?.commit) ?? "none")}</code></dd></div>
<div><dt>Signature</dt><dd>${signed} of ${envelopes.length} envelopes include a signature field. This page does not check the signature.</dd></div>
<div><dt>Authority key</dt><dd>${prefix ? `named in the bundle, prefix <code>${esc(prefix)}</code>. The prefix is a label, not a trust anchor. This page does not check it against an out-of-band trust key.` : "not named in the bundle."}</dd></div>
</dl></article>`;
	}).join("");
	return `<section id="proof"><h2>Proof</h2>${cards}${offline}</section>`;
}

const CSS = `
:root{--ink:#111d27;--muted:#60727e;--paper:#edf3f6;--plate:#fff;--line:#cbd8df;--stamp:#103f50;--green:#0d6b3c;--red:#9d1c2f;--blue:#1c5d83;--shadow:0 12px 40px rgba(23,48,62,.08)}
*{box-sizing:border-box}
body{margin:0 auto;max-width:72rem;padding:1.4rem 1.2rem 4rem;color:var(--ink);background:linear-gradient(180deg,#e6eff4 0,#f4f8fa 18rem);font:1rem/1.45 Inter,Bahnschrift,"Segoe UI",sans-serif}
header{padding:1.3rem 0 1rem}h1{font-size:clamp(1.9rem,4vw,3.25rem);font-weight:700;letter-spacing:-.045em;line-height:1.02;margin:.25rem 0 .7rem;max-width:54rem}h2{font-size:.78rem;font-weight:750;letter-spacing:.14em;text-transform:uppercase;margin:0 0 .8rem}h3{font-size:1.04rem;margin:0 0 .35rem}p{margin:.35rem 0}section{padding:1.25rem 0;border-top:1px solid var(--line)}.kicker,.note,dt{color:var(--muted)}.kicker{font-size:.73rem;letter-spacing:.14em;text-transform:uppercase;margin:0}.meta,.flow{color:var(--muted)}code,pre{font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;font-size:.86em}code{overflow-wrap:anywhere}pre{white-space:pre-wrap;background:#f5f8fa;border:1px solid var(--line);padding:.6rem}.flow{text-align:center;font-size:1.2rem;color:var(--stamp)}
.mission-strip{display:grid;grid-template-columns:repeat(6,1fr);gap:.5rem;border:0;padding:.6rem 0 1.4rem}.mission-strip div{background:rgba(255,255,255,.8);border:1px solid var(--line);border-radius:.65rem;padding:.65rem;box-shadow:var(--shadow)}.mission-strip span{display:block;color:var(--muted);font-size:.7rem;text-transform:uppercase;letter-spacing:.08em}.mission-strip strong{font-size:1.1rem}
.stamp{display:inline-block;margin:.2rem 0 .6rem;padding:.15rem .45rem;border:2px solid var(--stamp);color:var(--stamp);font-size:1.7rem;letter-spacing:.08em;line-height:1.1}.crew{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.55rem}.agent,.overlap,.bundle,.permit,.ship,.proof,.clearance-card,.why-card{background:var(--plate);border:1px solid var(--line);border-radius:.55rem;padding:.82rem;margin:.55rem 0;min-width:0;box-shadow:var(--shadow)}.agent dl,.agent dl div{display:block}.agent dl div{margin:.4rem 0}.agent dt{font-size:.72rem;text-transform:uppercase;letter-spacing:.08em}dl{display:grid;grid-template-columns:9rem 1fr;gap:.3rem .65rem;margin:0}dl div{display:contents}dd{margin:0;min-width:0}.deps{list-style:none;padding:0}.dep{border-left:3px solid var(--line);padding:.25rem 0 .25rem .65rem;margin:.4rem 0}.fork{display:grid;grid-template-columns:1fr 1fr;gap:.45rem}.state{border:1px solid var(--line);padding:.45rem;color:var(--muted);margin:0}.state span{display:block;font-size:.82rem}.state.now{border:2px solid var(--stamp);color:var(--stamp);font-weight:700}.seam{display:grid;gap:.35rem}.arrow{font-size:1.4rem;color:var(--stamp)}.candidate{border:2px solid var(--stamp);border-radius:.45rem;padding:.72rem;background:var(--plate)}.pass{color:var(--green);font-weight:700}.fail{color:var(--red);font-weight:700}.fixture{border:1px solid var(--stamp);padding:.55rem .7rem}.clearance-head,.why-title{display:flex;justify-content:space-between;gap:1rem;align-items:flex-start}.clearance-state,.why-title>strong{border:1px solid var(--stamp);border-radius:999px;padding:.23rem .55rem;font-size:.72rem;letter-spacing:.08em;color:var(--stamp);white-space:nowrap}.clearance-card details{margin-top:.65rem}.clearance-card summary{cursor:pointer;color:var(--blue)}.clearance-card li{margin:.45rem 0}.table-wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;background:var(--plate)}th,td{border-bottom:1px solid var(--line);padding:.55rem;text-align:left;vertical-align:top}th{font-size:.72rem;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}.why-grid{grid-template-columns:11rem 1fr}.seal-line{border-top:1px solid var(--line);margin-top:.8rem;padding-top:.7rem;font-weight:750;letter-spacing:.04em}.timeline{list-style:none;padding:0;margin:.5rem 0}.timeline li{display:grid;grid-template-columns:3rem 12rem minmax(10rem,1fr) 8rem;gap:.5rem;align-items:center;padding:.42rem 0;border-bottom:1px solid var(--line)}.timeline time{color:var(--muted);font-size:.85rem}footer{color:var(--muted);font-size:.88rem;padding-top:1rem}
@media(max-width:52rem){.mission-strip{grid-template-columns:repeat(3,1fr)}.crew{grid-template-columns:1fr}.timeline li{grid-template-columns:3rem 1fr}.timeline strong,.timeline code{grid-column:2}.why-grid,dl,.fork{grid-template-columns:1fr}dl div{display:block;margin:.35rem 0}.stamp{font-size:1.35rem}}
@media(max-width:30rem){.mission-strip{grid-template-columns:repeat(2,1fr)}.clearance-head,.why-title{display:block}.clearance-state,.why-title>strong{display:inline-block;margin-top:.5rem}}
`;

export function renderWorkGraphPage(state: AuthorityState, options: WorkGraphViewOptions = {}): string {
	const task = state.task;
	const view = pageView(state, options.graph ?? buildWorkGraph(state));
	const banner = text(options.fixtureBanner);
	const contract = text(task.behavior_contract);
	const policy = text(task.policy_version) ?? "not recorded";
	const repo = text(task.baseline_repo) ?? "not recorded";
	const hash = text(task.task_hash) ?? "not recorded";
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(view.taskId)} · MADGRIX Mission Control</title><style>${CSS}</style></head>
<body>
${banner ? `<p class="fixture">${esc(banner)}</p>` : ""}
<header id="task"><p class="kicker">MADGRIX Mission Control · Task / intent</p><h1>${esc(view.intent)}</h1><p class="meta">${esc(view.taskId)} · ${esc(view.taskStatus)} · ${esc(policy)}</p><p class="meta">Baseline <code>${esc(repo)}</code> <code>${esc(view.baselineCommit)}</code></p><p class="meta">Task hash <code>${esc(hash)}</code></p>${contract ? `<p>${esc(contract)}</p>` : ""}</header>
${missionSummary(state, view)}
<p class="flow">↓</p>${crewSection(view)}
<p class="flow">↓</p>${semanticClearanceSection(state)}
<p class="flow">↓</p>${graphSection(state, view)}
<p class="flow">↓</p>${compositionSection(view)}
${resolutionSection(view)}
${evaluationSection(state, view)}
${verifierBoardSection(state)}
${verdictSection(state)}
${authorizationSection(state, view)}
${promotionSection(state)}
${whyCanonicalSection(state)}
${activitySection(state)}
${proofSection(state)}
<footer><p>Rendered from the canonical work graph and stored authority records. This page does not classify overlaps, choose a verdict, grant clearance authority, or verify a bundle.</p></footer>
</body></html>`;
}
