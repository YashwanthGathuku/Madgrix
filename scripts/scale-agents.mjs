#!/usr/bin/env node
// @ts-nocheck -- CLI glue over untyped live JSON; the tested logic is typed in scripts/lib/scale.mjs.
/**
 * Scale test for the Git4agents coordination protocol.
 *
 * Each scripted agent runs the real coordination steps against ONE task:
 * it is enrolled at task freeze (POST /tasks, agent_ids), then claims its
 * own distinct path with its intent attached (POST /tasks/:id/claim, with
 * its per-agent secret). Every 20th agent also claims its neighbour's path,
 * so the authority must flag a known set of overlaps. Afterwards the ledger
 * is fetched and its hash chain verified.
 *
 * No step creates an Artifacts fork: claims and enrollment live in the
 * TaskAuthority Durable Object only. Submitting commits needs a contender
 * fork; at scale that is done the fork-crew way (many sub-agents on one
 * parent fork, see scripts/run-fork-crew.mjs), not one fork per agent.
 *
 * Modes:
 *   --mode live   real Worker at MADGRIX_BASE_URL (needs MADGRIX_CONTROL_SERVICE_TOKEN,
 *                 MADGRIX_AGENT_SERVICE_TOKEN, MADGRIX_BASELINE_REPO, MADGRIX_BASELINE_COMMIT)
 *   --mode local  the same pure state machine the DO runs (src/lib/task-state.ts),
 *                 in-process, one claim at a time (the DO is single-threaded),
 *                 and the size of the single stored state value is checked
 *                 against the 2 MiB SQLite-backed DO value limit.
 *
 *   --ramp 10,100,500,1000,2000   --concurrency 50   --out result.json
 * Ramping stops when error rate > 2% or any 429 is seen.
 * Never prints tokens or agent secrets.
 */
import { writeFile } from "node:fs/promises";
import { planAgents, claimBody, pool, summarize, flaggedPathOverlap, falseOverlapFlags } from "./lib/scale.mjs";

const args = Object.fromEntries(
	process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const mode = args.mode ?? "local";
const ramp = (args.ramp ?? "10,100,500,1000,2000").split(",").map(Number);
const concurrency = Number(args.concurrency ?? 50);
const DO_VALUE_LIMIT = 2 * 1024 * 1024;

async function runLive(n) {
	const base = process.env.MADGRIX_BASE_URL.replace(/\/$/, "");
	const control = process.env.MADGRIX_CONTROL_SERVICE_TOKEN;
	const agentTok = process.env.MADGRIX_AGENT_SERVICE_TOKEN;
	const agents = planAgents(n, { prefix: `s${n}` });
	const t0 = Date.now();
	const created = await fetch(`${base}/tasks`, {
		method: "POST",
		headers: { authorization: `Bearer ${control}`, "content-type": "application/json" },
		body: JSON.stringify({
			intent: `scale test N=${n}`,
			baseline_repo: process.env.MADGRIX_BASELINE_REPO,
			baseline_commit: process.env.MADGRIX_BASELINE_COMMIT,
			agent_ids: agents.map((a) => a.id),
		}),
	});
	const createMs = Date.now() - t0;
	if (created.status !== 201) {
		return { n, mode: "live", error: `create_task ${created.status} ${(await created.text()).slice(0, 200)}`, error_rate: 1, rate_limited: created.status === 429 ? 1 : 0 };
	}
	const { task_id, task_hash, agent_secrets } = await created.json();
	const ctx = await (await fetch(`${base}/tasks/${task_id}/context`, { headers: { authorization: `Bearer ${agentTok}` } })).json();
	const task = { task_hash, baseline_commit: ctx.task?.baseline_commit ?? process.env.MADGRIX_BASELINE_COMMIT };

	const claimOne = async (agent) => {
		const s = performance.now();
		try {
			const r = await fetch(`${base}/tasks/${task_id}/claim`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${agentTok}`,
					"content-type": "application/json",
					"x-madgrix-agent-secret": agent_secrets[agent.id],
				},
				body: JSON.stringify({ claim: claimBody(agent, task) }),
			});
			const ms = performance.now() - s;
			const body = await r.json().catch(() => ({}));
			return { id: agent.id, ok: r.status === 200 && typeof body.work_id === "string", status: r.status, ms, work_id: body.work_id, conflicts: body.conflicts, error: body.error, detail: typeof body.detail === "string" ? body.detail.slice(0, 120) : undefined };
		} catch (e) {
			return { id: agent.id, ok: false, status: 0, ms: performance.now() - s, error: String(e?.cause?.code ?? e?.message ?? e).slice(0, 80) };
		}
	};
	const wall = Date.now();
	// Phase A: agents with only their own path. Phase B: the seeded overlappers,
	// after their neighbour's claim is registered.
	const a = await pool(agents.filter((x) => !x.overlapsWith), concurrency, claimOne);
	const b = await pool(agents.filter((x) => x.overlapsWith), concurrency, claimOne);
	const wallMs = Date.now() - wall;
	const results = [...a, ...b];
	const byId = Object.fromEntries(results.map((r) => [r.id, r]));
	let flagged = 0, falseFlags = 0;
	const seeded = agents.filter((x) => x.overlapsWith);
	for (const ag of seeded) {
		const r = byId[ag.id], other = byId[ag.overlapsWith];
		if (r?.ok && other?.ok && flaggedPathOverlap(r.conflicts, other.work_id)) flagged++;
		if (r?.ok) falseFlags += falseOverlapFlags(r.conflicts, other?.work_id);
	}
	for (const r of a) if (r.ok) falseFlags += falseOverlapFlags(r.conflicts, null);
	// Ledger integrity.
	let ledger = { ok: false };
	try {
		const lr = await fetch(`${base}/tasks/${task_id}/ledger`, { headers: { authorization: `Bearer ${agentTok}` } });
		const lj = await lr.json();
		const { verifyLedgerChain } = await import("../src/lib/ledger.ts");
		const { sha256Hex } = await import("../src/lib/canonical.ts");
		const v = await verifyLedgerChain(lj.ledger, sha256Hex);
		const claimEntries = (lj.ledger ?? []).filter((e) => e.kind === "claim_registered").length;
		ledger = { ok: v.ok && claimEntries === results.filter((r) => r.ok).length, chain_ok: v.ok, entries: lj.ledger?.length ?? 0, claim_entries: claimEntries };
	} catch (e) {
		ledger = { ok: false, detail: String(e?.message ?? e).slice(0, 120) };
	}
	return summarize(n, "live", results, {
		task_id,
		create_task_ms: createMs,
		wall_ms: wallMs,
		claims_per_s: Number((results.length / (wallMs / 1000)).toFixed(1)),
		seeded_overlaps: seeded.length,
		overlaps_flagged: flagged,
		false_overlap_flags: falseFlags,
		ledger,
		forks_created: 0,
	});
}

async function runLocal(n) {
	const ts = await import("../src/lib/task-state.ts");
	const { sha256Hex, randomHex } = await import("../src/lib/canonical.ts");
	const { verifyLedgerChain } = await import("../src/lib/ledger.ts");
	const ctx = { now: () => new Date().toISOString(), randomHex, sha256Hex, selectorPolicyHash: "0".repeat(64), policyVersion: "seam-policy/0.1.0" };
	const agents = planAgents(n, { prefix: `s${n}` });
	const task = { task_id: "task_local", task_hash: "h".repeat(64), intent: "scale", baseline_repo: "local", baseline_commit: "c".repeat(40), behavior_contract: "", policy_version: "seam-policy/0.1.0", frozen_at: ctx.now() };
	let state = ts.createAuthority(task);
	const secrets = {}, enroll = {};
	for (const a of agents) { secrets[a.id] = randomHex(32); enroll[a.id] = await sha256Hex(secrets[a.id]); }
	state = await ts.enrollAgents(state, enroll, ctx);
	const ordered = [...agents.filter((x) => !x.overlapsWith), ...agents.filter((x) => x.overlapsWith)];
	const results = [];
	let maxBytes = 0, firstOverLimitAt = null;
	const wall = Date.now();
	for (const ag of ordered) {
		const s = performance.now();
		try {
			const r = await ts.registerClaim(state, claimBody(ag, task), ctx, secrets[ag.id]);
			// What the DO does next: storage.put(STATE_KEY, state) — one value.
			const bytes = Buffer.byteLength(JSON.stringify(r.state));
			maxBytes = Math.max(maxBytes, bytes);
			const ms = performance.now() - s;
			if (bytes > DO_VALUE_LIMIT) {
				firstOverLimitAt ??= results.length + 1;
				results.push({ id: ag.id, ok: false, status: 500, ms, error: "state_value_over_2MiB" });
				continue; // the put would fail; state is not advanced
			}
			state = r.state;
			results.push({ id: ag.id, ok: true, status: 200, ms, work_id: r.claim.work_id, conflicts: r.reports.map((x) => ({ with: x.claim_b, explanation: x.explanation })) });
		} catch (e) {
			results.push({ id: ag.id, ok: false, status: 422, ms: performance.now() - s, error: String(e.message).slice(0, 60) });
		}
	}
	const wallMs = Date.now() - wall;
	const byId = Object.fromEntries(results.map((r) => [r.id, r]));
	let flagged = 0;
	const seeded = agents.filter((x) => x.overlapsWith);
	for (const ag of seeded) if (byId[ag.id]?.ok && flaggedPathOverlap(byId[ag.id].conflicts, byId[ag.overlapsWith]?.work_id)) flagged++;
	const v = await verifyLedgerChain(state.ledger, sha256Hex);
	return summarize(n, "local", results, {
		wall_ms: wallMs,
		seeded_overlaps: seeded.length,
		overlaps_flagged: flagged,
		state_bytes_max: maxBytes,
		first_claim_over_2MiB: firstOverLimitAt,
		conflict_reports_stored: (state.conflict_reports ?? []).length,
		ledger: { ok: v.ok, entries: state.ledger.length },
		forks_created: 0,
	});
}

const all = [];
for (const n of ramp) {
	const r = mode === "live" ? await runLive(n) : await runLocal(n);
	all.push(r);
	console.log(JSON.stringify(r));
	if (args.out) await writeFile(args.out, JSON.stringify(all, null, 2));
	if (r.error_rate > 0.02 || r.rate_limited > 0) {
		console.log(`stop: N=${n} error_rate=${(r.error_rate * 100).toFixed(1)}% rate_limited=${r.rate_limited ?? 0}`);
		break;
	}
}
