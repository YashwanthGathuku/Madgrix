/**
 * HTML for GET /tasks/:id/graph.
 *
 * Reads task-authority state and prints it. This file does not classify
 * claims, score gates, choose a verdict, or verify a bundle. Risk colors
 * are the stored conflict-report words. A missing record stays missing.
 *
 * The route accepts the agent bearer, so this page does not print token
 * ids, agent secrets, permit nonces, DSSE signatures, hidden-test names,
 * or analysis findings.
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

export interface WorkGraphViewOptions {
	/**
	 * Caller-supplied label for an explicit fixture render. The worker
	 * route does not set this. Live task state is not described as a fixture.
	 */
	fixtureBanner?: string;
}

const RISKS: readonly ConflictRisk[] = ["GREEN", "AMBER", "RED", "BLOCKED"];

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

function roleLabel(role: string, id: string): string {
	if (role === "parent" || id === "parent") return "parent";
	if (role === "api") return "API agent";
	if (role === "ui") return "UI agent";
	if (role === "test") return "test/integration agent";
	const named = text(role);
	return named ?? id;
}

interface CrewRow {
	id: string;
	label: string;
	intent: string | null;
	compositionScope: string | null;
	claimScope: string | null;
	contenderStatus: string | null;
	claimStatus: string | null;
	forkCommit: string | null;
	sideCommit: string | null;
}

function crewRows(state: AuthorityState): CrewRow[] {
	const map = new Map<string, CrewRow>();
	const ensure = (id: string): CrewRow => {
		let row = map.get(id);
		if (!row) {
			row = {
				id,
				label: roleLabel("", id),
				intent: null,
				compositionScope: null,
				claimScope: null,
				contenderStatus: null,
				claimStatus: null,
				forkCommit: null,
				sideCommit: null,
			};
			map.set(id, row);
		}
		return row;
	};

	for (const agent of state.composition?.agents ?? []) {
		const id = text(agent.id);
		if (!id) continue;
		const row = ensure(id);
		row.label = roleLabel(text(agent.role) ?? "", id);
		row.intent = text(agent.intent);
		const paths = Array.isArray(agent.paths) ? agent.paths.filter((p) => text(p)).join(", ") : "";
		row.compositionScope = text(paths);
		row.sideCommit = text(agent.sha);
	}

	for (const claim of state.claims ?? []) {
		const id = text(claim.agent);
		if (!id) continue;
		const row = ensure(id);
		if (!row.intent) row.intent = text(claim.intent?.behavior?.join("; ") ?? "");
		const paths = claim.scope?.paths?.filter((p) => text(p)).join(", ") ?? "";
		const scope = text(paths);
		row.claimScope = row.claimScope && scope ? `${row.claimScope}, ${scope}` : (row.claimScope ?? scope);
		const status = text(claim.status);
		row.claimStatus = row.claimStatus && status ? `${row.claimStatus}, ${status}` : (row.claimStatus ?? status);
	}

	for (const contender of Object.values(state.contenders ?? {})) {
		const id = text(contender.agent_id);
		if (!id) continue;
		const row = ensure(id);
		row.contenderStatus = text(contender.status);
		row.forkCommit = text(contender.latest_commit);
	}

	const order = new Map<string, number>();
	let n = 0;
	for (const row of map.values()) {
		if (row.id === "parent" || row.label === "parent") order.set(row.id, n++);
	}
	for (const agent of state.composition?.agents ?? []) {
		const id = text(agent.id);
		if (id && !order.has(id)) order.set(id, n++);
	}
	for (const id of map.keys()) if (!order.has(id)) order.set(id, n++);
	return [...map.values()].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

function scopeLine(row: CrewRow): string {
	const composition = row.compositionScope;
	const claim = row.claimScope;
	if (composition && claim && composition !== claim) {
		return `composition ${esc(composition)} · claim ${esc(claim)}`;
	}
	if (composition) return esc(composition);
	if (claim) return esc(claim);
	return "not recorded";
}

function statusLine(row: CrewRow): string {
	if (row.contenderStatus && row.claimStatus && row.contenderStatus !== row.claimStatus) {
		return `contender ${esc(row.contenderStatus)} · claim ${esc(row.claimStatus)}`;
	}
	const one = row.contenderStatus ?? row.claimStatus;
	return one ? esc(one) : "not recorded";
}

function commitLine(row: CrewRow): string {
	if (row.forkCommit && row.sideCommit && row.forkCommit !== row.sideCommit) {
		return `fork <code>${esc(row.forkCommit)}</code> · side <code>${esc(row.sideCommit)}</code>`;
	}
	const sha = row.sideCommit ?? row.forkCommit;
	return sha ? `<code>${esc(sha)}</code>` : "none";
}

function crewSection(state: AuthorityState): string {
	const rows = crewRows(state);
	if (rows.length === 0) return `<section id="crew"><h2>Crew</h2><p>No agents are recorded.</p></section>`;
	const cards = rows
		.map(
			(row) => `<article class="agent">
<h3>${esc(row.label)} <code>${esc(row.id)}</code></h3>
<dl>
<div><dt>Intent</dt><dd>${row.intent ? esc(row.intent) : "not recorded"}</dd></div>
<div><dt>Scope</dt><dd>${scopeLine(row)}</dd></div>
<div><dt>Status</dt><dd>${statusLine(row)}</dd></div>
<div><dt>Commit</dt><dd>${commitLine(row)}</dd></div>
</dl>
</article>`,
		)
		.join("");
	return `<section id="crew"><h2>Crew</h2>${cards}</section>`;
}

function claimByWork(state: AuthorityState, workId: string): WorkClaim | undefined {
	return state.claims.find((claim) => claim.work_id === workId);
}

function nameForWork(state: AuthorityState, workId: string): string {
	const claim = claimByWork(state, workId);
	if (!claim) return workId;
	const agent = state.composition?.agents.find((row) => row.claim_work_id === workId || row.id === claim.agent);
	const label = agent ? roleLabel(text(agent.role) ?? "", text(agent.id) ?? claim.agent) : roleLabel("", claim.agent);
	return `${label} (${claim.agent})`;
}

function graphSection(state: AuthorityState): string {
	const reports = state.conflict_reports ?? [];
	const key = `<ul class="key">
<li><span class="swatch risk-GREEN">GREEN</span> no conflict on the recorded layers</li>
<li><span class="swatch risk-AMBER">AMBER</span> shared dependency, unavailable dependency analysis, or an amended claim</li>
<li><span class="swatch risk-RED">RED</span> shared symbol or contract</li>
<li><span class="swatch risk-BLOCKED">BLOCKED</span> shared state</li>
</ul>
<p class="note">Colors mark stored conflict reports only. This page does not classify pairs. A line overlap stays under Composition, with the classification the combine step stored.</p>`;
	const edges =
		reports.length === 0
			? `<p>No conflict reports are stored.</p>`
			: `<ul class="edges">${reports
					.map((report) => {
						const risk = report.risk;
						const known = (RISKS as readonly string[]).includes(risk);
						const cls = known ? `edge risk-${risk}` : "edge";
						return `<li class="${cls}"><span class="risk">${esc(risk)}</span> ${esc(nameForWork(state, report.claim_a))} × ${esc(nameForWork(state, report.claim_b))}<p>${esc(report.explanation)}</p></li>`;
					})
					.join("")}</ul>`;
	return `<section id="graph"><h2>Live work graph</h2>${key}${edges}</section>`;
}

function compositionSection(state: AuthorityState): string {
	const composition = state.composition;
	if (!composition) {
		return `<section id="composition"><h2>Composition</h2><p class="stamp">none</p><p>No composition is recorded.</p></section>`;
	}
	const files = composition.files ?? [];
	const fileHtml =
		files.length === 0
			? `<p>No overlap file is stored.</p>`
			: files.map((file) => overlapFile(file)).join("");
	const candidate = text(composition.candidate_sha);
	return `<section id="composition"><h2>Composition</h2>
<p class="stamp">${esc(composition.status)}</p>
<p>Candidate ${candidate ? `<code>${esc(candidate)}</code>` : "none"}.</p>
${fileHtml}</section>`;
}

function overlapFile(file: CompositionRecord["files"][number]): string {
	const sides = (file.sides ?? [])
		.map(
			(side) => `<div class="side"><p><code>${esc(side.agent_id)}</code> ${esc(side.role)}</p>
<p>Intent: ${esc(side.intent)}</p>
<p>Contributing SHA <code>${esc(side.sha)}</code></p>
<pre>${text(side.excerpt) ? esc(side.excerpt) : "no excerpt stored"}</pre></div>`,
		)
		.join("");
	return `<article class="overlap"><h3>${esc(file.path)}</h3>
<p>Reason: ${esc(file.classification)}</p>
${sides}</article>`;
}

function resolutionSection(state: AuthorityState): string {
	const composition = state.composition;
	if (!composition) {
		return `<section id="resolution"><h2>Resolution</h2><p>No composition is recorded.</p></section>`;
	}
	const contributing = (composition.contributing_shas ?? [])
		.map((sha) => `<li><code>${esc(sha)}</code></li>`)
		.join("");
	const candidate = text(composition.candidate_sha);
	if (composition.status === "CONFLICTED" || !candidate) {
		return `<section id="resolution"><h2>Resolution</h2>
<p>Resolution state: unresolved.</p>
<div class="seam"><div><p class="kicker">Contributing SHAs</p><ul>${contributing || "<li>none</li>"}</ul></div>
<p class="arrow">→</p>
<div class="candidate"><p class="kicker">Candidate SHA</p><p>none</p></div></div></section>`;
	}
	const isNew = !composition.contributing_shas.includes(candidate);
	const label = isNew ? "New candidate" : "Candidate SHA is one of the contributing SHAs";
	return `<section id="resolution"><h2>Resolution</h2>
<p>Resolution state: ${esc(composition.status)}.</p>
<div class="seam"><div><p class="kicker">Contributing SHAs</p><ul>${contributing}</ul></div>
<p class="arrow">→</p>
<div class="candidate"><p class="kicker">${esc(label)}</p><code>${esc(candidate)}</code></div></div></section>`;
}

function mark(ok: boolean): string {
	return `<span class="${ok ? "pass" : "fail"}">${ok ? "pass" : "fail"}</span>`;
}

function gateList(bundle: EvaluationBundle): string {
	const admission = bundle.admission;
	const hidden = bundle.hidden_oracle;
	const regressions = bundle.regressions;
	const security = bundle.security_policy;
	const semantic = bundle.semantic_checks;
	return `<dl class="gates">
<div><dt>Baseline</dt><dd>${mark(admission.exact_baseline)}</dd></div>
<div><dt>Scope</dt><dd>${mark(admission.scope_compliance)}</dd></div>
<div><dt>Evaluation integrity</dt><dd>${mark(admission.no_eval_tampering)}</dd></div>
<div><dt>Tests</dt><dd>hidden oracle ${mark(hidden.passed)} (${num(hidden.total)} total) · regressions ${mark(regressions.passed)} (${num(regressions.total)} total)</dd></div>
<div><dt>Security</dt><dd>${mark(security.passed)}</dd></div>
<div><dt>Provenance / policy</dt><dd>provenance ${mark(admission.provenance_complete)} · tool states ${mark(admission.valid_tool_states)} · static analysis ${mark(bundle.static_analysis.passed)}</dd></div>
<div><dt>Semantic checks</dt><dd>${mark(semantic.passed)} (${num(semantic.total)} total)</dd></div>
<div><dt>Tainted</dt><dd>${bundle.tainted ? "yes" : "no"}</dd></div>
<div><dt>Bundle hash</dt><dd><code>${esc(bundle.bundle_hash)}</code></dd></div>
</dl>`;
}

function evaluationSection(state: AuthorityState): string {
	const candidate = text(state.composition?.candidate_sha);
	const bundles = Object.entries(state.evaluations ?? {});
	const parts: string[] = [];
	if (candidate && !Object.hasOwn(state.evaluations ?? {}, candidate)) {
		parts.push(`<p>No evaluation bundle is stored for the composition candidate <code>${esc(candidate)}</code>.</p>`);
	}
	if (bundles.length === 0 && !candidate) parts.push(`<p>No evaluation bundle is stored.</p>`);
	for (const [sha, bundle] of bundles) {
		const relation =
			candidate && sha === candidate
				? "Composition candidate."
				: "Stored bundle. Not the composition candidate.";
		parts.push(`<article class="bundle"><h3><code>${esc(sha)}</code></h3><p>${relation}</p>${gateList(bundle)}</article>`);
	}
	return `<section id="evaluation"><h2>Evaluation</h2>${parts.join("")}</section>`;
}

function verdictSection(state: AuthorityState): string {
	const verdicts = state.verdicts ?? [];
	const latest = verdicts[verdicts.length - 1];
	const verdictHtml = latest
		? `<p class="stamp">${esc(latest.state)}</p>
<p>Winner ${latest.winner_sha ? `<code>${esc(latest.winner_sha)}</code>` : "none"}.</p>
${verdicts.length > 1 ? `<p>Showing the latest of ${verdicts.length} verdict records.</p>` : ""}
<ul>${latest.reasons.map((reason) => `<li>${esc(reason)}</li>`).join("") || "<li>no reason recorded</li>"}</ul>`
		: `<p>No verdict is recorded.</p>`;
	const quarantines = Object.values(state.quarantine ?? {});
	const quarantineHtml =
		quarantines.length === 0
			? `<h3>Quarantine</h3><p>No quarantine record is stored.</p>`
			: `<h3>Quarantine</h3><ul>${quarantines
					.map(
						(record) =>
							`<li><code>${esc(record.contender_id)}</code> ${esc(record.status)} · ${esc(record.trigger)}</li>`,
					)
					.join("")}</ul>`;
	return `<section id="verdict"><h2>Verdict seam</h2>${verdictHtml}${quarantineHtml}</section>`;
}

function permitRelation(state: AuthorityState, permit: PermitRecord): string {
	const candidate = state.composition?.candidate_sha ?? null;
	if (!state.composition) return "No composition is recorded.";
	if (candidate && permit.winner_candidate_sha === candidate) return "This permit names the composition candidate.";
	if (state.composition.contributing_shas.includes(permit.winner_candidate_sha)) {
		return "This permit names a contributing SHA, not the composition candidate.";
	}
	if (!candidate) return "The composition candidate is none.";
	return "This permit names a different SHA from the composition candidate.";
}

function authorizationSection(state: AuthorityState): string {
	const permits = Object.values(state.permits ?? {});
	if (permits.length === 0) {
		return `<section id="authorization"><h2>Authorization</h2><p>No permit is recorded.</p></section>`;
	}
	const cards = permits
		.map(
			(permit) => `<article class="permit"><h3><code>${esc(permit.permit_id)}</code></h3>
<dl>
<div><dt>Candidate SHA</dt><dd><code>${esc(permit.winner_candidate_sha)}</code></dd></div>
<div><dt>Destination head</dt><dd><code>${esc(permit.expected_destination_head)}</code></dd></div>
<div><dt>Permit status</dt><dd>${permit.consumed ? "consumed" : "issued, not consumed"}</dd></div>
<div><dt>Destination</dt><dd><code>${esc(permit.destination_repo)}</code></dd></div>
<div><dt>Bound evaluation</dt><dd><code>${esc(permit.evaluation_bundle_hash)}</code></dd></div>
</dl>
<p>${esc(permitRelation(state, permit))}</p></article>`,
		)
		.join("");
	return `<section id="authorization"><h2>Authorization</h2>${cards}</section>`;
}

function bundlesOf(state: AuthorityState): Array<{ permitId: string; bundle: PromotionBundle; permit: PermitRecord | undefined }> {
	return Object.entries(state.promotion_bundles ?? {}).map(([permitId, bundle]) => ({
		permitId,
		bundle,
		permit: state.permits?.[permitId],
	}));
}

function promotionSection(state: AuthorityState): string {
	const bundles = bundlesOf(state);
	const consumed = Object.values(state.permits ?? {}).filter((permit) => permit.consumed);
	if (bundles.length === 0 && consumed.length === 0) {
		return `<section id="promotion"><h2>Promotion</h2><p>No promotion is recorded.</p></section>`;
	}
	const fromBundles = bundles
		.map(({ permit, bundle }) => {
			const authorized = permit ? permit.winner_candidate_sha : null;
			return `<article class="ship"><dl>
<div><dt>Authorized SHA</dt><dd>${authorized ? `<code>${esc(authorized)}</code>` : "permit not stored"}</dd></div>
<div><dt>Promoted SHA</dt><dd><code>${esc(bundle.ship.commit)}</code></dd></div>
<div><dt>Canonical destination</dt><dd><code>${esc(bundle.ship.repo)}</code></dd></div>
<div><dt>Promoted from</dt><dd><code>${esc(bundle.ship.base)}</code></dd></div>
</dl></article>`;
		})
		.join("");
	const consumedWithoutBundle = consumed
		.filter((permit) => !state.promotion_bundles?.[permit.permit_id])
		.map(
			(permit) =>
				`<p>Permit <code>${esc(permit.permit_id)}</code> is consumed. No promotion bundle is stored, so this page does not name a promoted SHA.</p>`,
		)
		.join("");
	return `<section id="promotion"><h2>Promotion</h2>${fromBundles}${consumedWithoutBundle}</section>`;
}

function proofSection(state: AuthorityState): string {
	const bundles = bundlesOf(state);
	if (bundles.length === 0) {
		return `<section id="proof"><h2>Proof</h2><p>No promotion bundle is stored.</p><p>Offline verification: not executed in this view.</p></section>`;
	}
	const cards = bundles
		.map(({ bundle }) => {
			const envelopes = bundle.statements ?? [];
			const signed = envelopes.filter((envelope) =>
				(envelope.signatures ?? []).some((signature) => text(signature.sig)),
			).length;
			const named = text(bundle.authority_pubkey_der_hex);
			const prefix = named ? named.slice(0, 12) : null;
			return `<article class="proof"><dl>
<div><dt>Bundle</dt><dd>version ${esc(String(bundle.version))} · ${envelopes.length} envelopes · ship <code>${esc(bundle.ship?.commit ?? "none")}</code></dd></div>
<div><dt>Signature</dt><dd>${signed} of ${envelopes.length} envelopes include a signature field. This page does not check the signature.</dd></div>
<div><dt>Authority key</dt><dd>${prefix ? `named in the bundle, prefix <code>${esc(prefix)}</code>. The prefix is a label, not a trust anchor. This page does not check it against an out-of-band trust key.` : "not named in the bundle."}</dd></div>
<div><dt>Offline verification</dt><dd>Offline verification: not executed in this view.</dd></div>
</dl></article>`;
		})
		.join("");
	return `<section id="proof"><h2>Proof</h2>${cards}</section>`;
}

const CSS = `
:root {
  --ink: #142029;
  --muted: #526570;
  --paper: #e7eef3;
  --plate: #f8fbfc;
  --line: #c5d2db;
  --stamp: #0f3d4c;
  --green: #0d6b3c;
  --amber: #8a4b08;
  --red: #9d1c2f;
  --blocked: #3a2f7a;
}
* { box-sizing: border-box; }
body {
  margin: 0 auto;
  max-width: 40rem;
  padding: 1.25rem 1.15rem 3rem;
  color: var(--ink);
  background: var(--paper);
  font: 1.02rem/1.45 Bahnschrift, "Avenir Next Condensed", "Segoe UI", sans-serif;
}
h1 { font-size: 1.85rem; font-weight: 600; letter-spacing: -0.03em; line-height: 1.15; margin: 0.2rem 0 0.6rem; }
h2 { font-size: 0.78rem; font-weight: 650; letter-spacing: 0.14em; text-transform: uppercase; margin: 0 0 0.7rem; }
h3 { font-size: 1.05rem; font-weight: 600; margin: 0 0 0.35rem; }
p { margin: 0.35rem 0; }
section { padding: 1.15rem 0; border-top: 1px solid var(--line); }
.kicker, .note, dt { color: var(--muted); }
.kicker { font-size: 0.78rem; letter-spacing: 0.14em; text-transform: uppercase; margin: 0; }
code, pre { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size: 0.86em; }
code { overflow-wrap: anywhere; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; background: var(--plate); border: 1px solid var(--line); padding: 0.55rem 0.65rem; margin: 0.4rem 0 0; }
.meta { color: var(--muted); font-size: 0.92rem; }
.stamp {
  display: inline-block;
  margin: 0.2rem 0 0.6rem;
  padding: 0.15rem 0.45rem;
  border: 2px solid var(--stamp);
  color: var(--stamp);
  font-size: 1.7rem;
  letter-spacing: 0.08em;
  line-height: 1.1;
}
.agent, .overlap, .bundle, .permit, .ship, .proof {
  background: var(--plate);
  border: 1px solid var(--line);
  padding: 0.75rem 0.8rem;
  margin: 0.55rem 0;
}
dl { display: grid; grid-template-columns: 9.5rem 1fr; gap: 0.28rem 0.75rem; margin: 0; }
dl div { display: contents; }
dt { margin: 0; }
dd { margin: 0; }
.key, .edges { list-style: none; padding: 0; margin: 0.4rem 0; }
.key li, .edges li { margin: 0.35rem 0; }
.swatch, .risk { font-weight: 650; letter-spacing: 0.04em; }
.risk-GREEN { color: var(--green); }
.risk-AMBER { color: var(--amber); }
.risk-RED { color: var(--red); }
.risk-BLOCKED { color: var(--blocked); }
.edge { border-left: 3px solid var(--line); padding-left: 0.6rem; }
.edge.risk-GREEN { border-left-color: var(--green); }
.edge.risk-AMBER { border-left-color: var(--amber); }
.edge.risk-RED { border-left-color: var(--red); }
.edge.risk-BLOCKED { border-left-color: var(--blocked); }
.seam { display: grid; gap: 0.35rem; }
.arrow { margin: 0; font-size: 1.4rem; color: var(--stamp); }
.candidate { border: 2px solid var(--stamp); padding: 0.6rem 0.7rem; background: var(--plate); }
.pass { color: var(--green); font-weight: 650; }
.fail { color: var(--red); font-weight: 650; }
.fixture { border: 1px solid var(--stamp); padding: 0.55rem 0.7rem; margin: 0 0 0.8rem; }
footer { color: var(--muted); font-size: 0.88rem; }
@media (max-width: 36rem) {
  dl { grid-template-columns: 1fr; gap: 0.05rem; }
  dl div { display: block; margin: 0.35rem 0; }
  .stamp { font-size: 1.35rem; }
}
`;

/**
 * One task page. `options.fixtureBanner` is escaped and shown only when
 * the caller passes it. The worker does not.
 */
export function renderWorkGraphPage(state: AuthorityState, options: WorkGraphViewOptions = {}): string {
	const task = state.task;
	const banner = text(options.fixtureBanner);
	const contract = text(task.behavior_contract);
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(task.task_id)} · MADGRIX</title>
<style>${CSS}</style>
</head>
<body>
${banner ? `<p class="fixture">${esc(banner)}</p>` : ""}
<header id="task">
<p class="kicker">Task</p>
<h1>${esc(task.intent)}</h1>
<p class="meta">${esc(task.task_id)} · ${esc(state.task_status)} · ${esc(task.policy_version)}</p>
<p class="meta">Baseline <code>${esc(task.baseline_repo)}</code> <code>${esc(task.baseline_commit)}</code></p>
<p class="meta">Task hash <code>${esc(task.task_hash)}</code></p>
${contract ? `<p>${esc(contract)}</p>` : ""}
</header>
${crewSection(state)}
${graphSection(state)}
${compositionSection(state)}
${resolutionSection(state)}
${evaluationSection(state)}
${verdictSection(state)}
${authorizationSection(state)}
${promotionSection(state)}
${proofSection(state)}
<footer><p>Rendered from task-authority state. This page does not classify claims, choose a verdict, or verify a bundle.</p></footer>
</body>
</html>`;
}
