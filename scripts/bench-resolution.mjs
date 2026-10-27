#!/usr/bin/env node
/**
 * Governed-resolution benchmark (bench/resolution/README.md).
 *
 *   node scripts/bench-resolution.mjs [--out bench/resolution/results]
 *
 * For every scenario in bench/resolution/scenarios it runs a real fork crew
 * (two agents on a real MIT package) and then:
 *
 *   conflicting scenarios (textual, list): every resolver behaviour in
 *   scripts/bench/resolution-strategy.mjs through three admission pipelines —
 *     P0  pre-lease   the resolve path of commit ee421f0, loaded from git
 *                     history unchanged: marker check only
 *     P1  lease       resolution-lease-v1 + hunk leases: bounds where a
 *                     resolver writes
 *     P2  governed    P1 + the frozen witness gate (governed-resolution-v1)
 *
 *   clean-merging scenarios (semantic, control): the COMPOSED candidate with
 *   no gate (what P0 and P1 do) and with the witness gate (P2).
 *
 * Every admitted candidate is judged by the scenario's held-out acceptance
 * test, which the pipelines never see. TheUstad's frozen-baseline gate is
 * stubbed. Requires the commit ee421f0 in local history; Mergiraf is used when
 * installed.
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadForkCrew, resolveComposition, runCrewOnFork } from "./lib/fork-crew.mjs";
import { governCrewResult } from "./lib/governed-resolution.mjs";
import { findMergiraf } from "./lib/resolve-ladder.mjs";
import { freezeWitnesses, loadWitnesses, witnessReport } from "./lib/witness.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BENCH = path.join(repoRoot, "bench/resolution");
const STRATEGY = path.join(repoRoot, "scripts/bench/resolution-strategy.mjs");
const LEGACY_COMMIT = "ee421f092f15bcbec8f8e05bc0ea2e68bb2c3dc7";
const STRATEGIES = ["ours", "theirs", "union", "markers", "reference", "tamper", "drop-clean", "mergiraf"];
const PIPELINES = ["P0", "P1", "P2"];
const stubGate = () => ({ final: "FINAL VERIFIED (stubbed for the benchmark)", exit: 0 });

/**
 * @typedef {{ id: string, intent: string, files: string[] }} Agent
 * @typedef {{ id: string, kind: string, package: string, title: string, agents: Agent[], reference: string[] }} Scenario
 * @typedef {{ scenario: string, kind: string, strategy: string, pipeline: string, candidate: string | null, admitted: boolean, outcome: string, reason: string, acceptance: boolean | null, acceptance_failures: string[], witness_ms: number | null }} Row
 * @typedef {{ rows: Row[], generated_at: string, node: string, mergiraf: string | null }} Results
 * @typedef {NonNullable<ReturnType<typeof loadWitnesses>>} Witnesses
 * @typedef {ReturnType<typeof freezeWitnesses>} Frozen
 */

const outArg = process.argv.indexOf("--out");
const outDir = path.resolve(outArg > 0 ? process.argv[outArg + 1] : path.join(BENCH, "results"));
const scratch = mkdtempSync(path.join(os.tmpdir(), "madgrix-bench-resolution-"));
const mergirafBin = findMergiraf();
const env = {
	...process.env,
	GIT_AUTHOR_NAME: "bench",
	GIT_AUTHOR_EMAIL: "bench@madgrix.invalid",
	GIT_COMMITTER_NAME: "bench",
	GIT_COMMITTER_EMAIL: "bench@madgrix.invalid",
};
Object.assign(process.env, env);

/** @param {string} cwd @param {string[]} args */
function git(cwd, args, allowFailure = false) {
	const r = spawnSync("git", args, { cwd, encoding: "utf8", env });
	if (r.status !== 0 && !allowFailure) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
	return (r.stdout ?? "").trim();
}

/** The pre-lease resolver, loaded from history next to its unchanged dependencies. */
async function loadLegacyResolver() {
	const dir = path.join(scratch, "legacy");
	mkdirSync(dir, { recursive: true });
	const show = spawnSync("git", ["show", `${LEGACY_COMMIT}:scripts/lib/fork-crew.mjs`], { cwd: repoRoot, encoding: "utf8" });
	if (show.status !== 0) throw new Error(`commit ${LEGACY_COMMIT} is not in local history (fetch it to run P0)`);
	writeFileSync(path.join(dir, "fork-crew.mjs"), show.stdout);
	for (const dep of ["child-env.mjs", "agentfleet-slots.mjs"]) {
		const r = spawnSync("git", ["show", `${LEGACY_COMMIT}:scripts/lib/${dep}`], { cwd: repoRoot, encoding: "utf8" });
		writeFileSync(path.join(dir, dep), r.stdout);
	}
	return (await import(pathToFileURL(path.join(dir, "fork-crew.mjs")).href)).resolveComposition;
}

/**
 * Run a node script with a checkout of `sha` as its working directory.
 * @param {string} repo @param {string} sha @param {string} script
 */
function runOnCommit(repo, sha, script) {
	const dir = path.join(scratch, `wt-${Math.random().toString(16).slice(2)}`);
	git(repo, ["worktree", "add", "--detach", "--quiet", dir, sha]);
	try {
		const r = spawnSync(process.execPath, [script], { cwd: dir, encoding: "utf8", timeout: 30_000 });
		return { pass: r.status === 0, detail: (r.stderr ?? "").trim().split("\n").filter(Boolean) };
	} finally {
		git(repo, ["worktree", "remove", "--force", dir], true);
	}
}

/** @param {string} repo @param {string} baseline */
function resetRepo(repo, baseline) {
	git(repo, ["checkout", "-B", "main", baseline]);
	git(repo, ["reset", "--hard", baseline]);
	git(repo, ["clean", "-fdx"]);
}

/**
 * A fresh repository holding the upstream package, and a crew config for the scenario.
 * @param {Scenario} scenario @param {string} dir
 */
function setup(scenario, dir) {
	const repo = path.join(scratch, `${scenario.id}-repo-${Math.random().toString(16).slice(2)}`);
	cpSync(path.join(BENCH, "upstream", scenario.package), repo, { recursive: true });
	git(repo, ["init", "--quiet", "--initial-branch=main"]);
	git(repo, ["add", "-A"]);
	git(repo, ["commit", "--quiet", "-m", `upstream ${scenario.package}`]);
	const config = {
		parent: { id: "parent", role: "parent", intent: "Host both agents on one fork." },
		subs: scenario.agents.map((/** @type {Agent} */ agent) => ({
			id: agent.id,
			role: agent.id,
			intent: agent.intent,
			paths: agent.files,
			command: agent.files
				.map((/** @type {string} */ file) => `mkdir -p ${JSON.stringify(path.dirname(file))} && cp ${JSON.stringify(path.join(dir, agent.id, file))} ${JSON.stringify(file)}`)
				.join(" && "),
			witnesses: [{ id: agent.id, script: path.join(dir, "witness", `${agent.id}.mjs`) }],
		})),
	};
	const configPath = path.join(scratch, `${scenario.id}-crew-${Math.random().toString(16).slice(2)}.json`);
	writeFileSync(configPath, JSON.stringify(config, null, 2));
	const crew = loadForkCrew(configPath);
	return { repo, crew, witnesses: /** @type {NonNullable<ReturnType<typeof loadWitnesses>>} */ (loadWitnesses(configPath, crew)) };
}

/**
 * Sanity: each witness discriminates its side, and the scenario conflicts or merges as its kind says.
 * @param {Scenario} scenario @param {any} run @param {Frozen} frozen
 */
function sanity(scenario, run, frozen) {
	const problems = [];
	for (const agent of scenario.agents) {
		const o = frozen.outcomes[`${agent.id}/${agent.id}`];
		if (!(o.baseline === "fail" && o.own === "pass")) problems.push(`${agent.id}: witness does not discriminate (${JSON.stringify(o)})`);
	}
	const conflicts = run.status === "CONFLICTED";
	if ((scenario.kind === "textual" || scenario.kind === "list") !== conflicts) {
		problems.push(`expected ${scenario.kind} to ${conflicts ? "merge cleanly" : "conflict"}, got ${run.status}`);
	}
	return problems;
}

/**
 * @param {Scenario} scenario @param {string} dir
 * @param {(repo: string, run: any, command: string) => { sha: string }} legacyResolve
 */
async function conflictScenario(scenario, dir, legacyResolve) {
	const { repo, crew, witnesses } = setup(scenario, dir);
	const run = await runCrewOnFork(repo, crew, undefined, stubGate);
	const frozen = freezeWitnesses(repo, run.baseline, run.commits, witnesses);
	const problems = sanity(scenario, run, frozen);
	const requiredSides = scenario.agents.map((/** @type {Agent} */ a) => a.id);
	const acceptance = path.join(dir, "acceptance.mjs");
	/** @type {Row[]} */
	const rows = [];
	for (const strategy of STRATEGIES) {
		if (strategy === "mergiraf" && mergirafBin === null) continue;
		const command = `node ${JSON.stringify(STRATEGY)} ${strategy} ${JSON.stringify(dir)}`;
		for (const pipeline of PIPELINES) {
			resetRepo(repo, run.baseline);
			/** @type {Row} */
			const row = { scenario: scenario.id, kind: scenario.kind, strategy, pipeline, candidate: null, admitted: false, outcome: "", reason: "", acceptance: null, acceptance_failures: [], witness_ms: null };
			try {
				const resolved =
					pipeline === "P0"
						? legacyResolve(repo, run, command)
						: resolveComposition(repo, run, command, { env: mergirafBin ? { MERGIRAF_BIN: mergirafBin } : {} });
				row.candidate = resolved.sha;
				if (pipeline === "P2") {
					const started = performance.now();
					const report = witnessReport(repo, resolved.sha, witnesses, frozen, { requiredSides });
					row.witness_ms = Math.round(performance.now() - started);
					row.admitted = report.verdict === "ADMIT";
					row.outcome = report.verdict;
					row.reason = report.report.reasons.join("; ");
				} else {
					row.admitted = true;
					row.outcome = "ADMIT";
				}
			} catch (error) {
				row.outcome = "REFUSED";
				row.reason = String(/** @type {Error} */ (error).message).split("\n")[0];
			}
			if (row.candidate) {
				const judged = runOnCommit(repo, row.candidate, acceptance);
				row.acceptance = judged.pass;
				row.acceptance_failures = judged.detail;
			}
			rows.push(row);
		}
	}
	return { problems, rows };
}

/** @param {Scenario} scenario @param {string} dir */
async function composedScenario(scenario, dir) {
	const { repo, crew, witnesses } = setup(scenario, dir);
	const run = await runCrewOnFork(repo, crew, undefined, stubGate);
	const frozen = freezeWitnesses(repo, run.baseline, run.commits, witnesses);
	const problems = sanity(scenario, run, frozen);
	const acceptance = path.join(dir, "acceptance.mjs");
	const judged = run.sha ? runOnCommit(repo, run.sha, acceptance) : { pass: false, detail: ["no composed commit"] };
	/** @type {Row[]} */
	const rows = [];
	for (const pipeline of PIPELINES) {
		/** @type {Row} */
		const row = { scenario: scenario.id, kind: scenario.kind, strategy: "compose", pipeline, candidate: run.sha, admitted: true, outcome: "COMPOSED", reason: "", acceptance: judged.pass, acceptance_failures: judged.detail, witness_ms: null };
		if (pipeline === "P2") {
			const started = performance.now();
			const governed = await governCrewResult(repo, run, { taskHash: "bench", contenderId: "bench", witnesses, frozen, mode: "none" });
			row.witness_ms = Math.round(performance.now() - started);
			row.admitted = governed.status === "COMPOSED";
			row.outcome = governed.status;
			row.reason = "detail" in governed && governed.detail ? String(governed.detail) : "";
			git(repo, ["checkout", "-B", "main", /** @type {string} */ (run.sha)], true);
		}
		rows.push(row);
	}
	return { problems, rows };
}

/**
 * Whether a refused attempt's resolution was in fact correct. With a commit,
 * the acceptance test decides. A lease refusal leaves no commit; then the same
 * strategy's pre-lease (P0) candidate, which carries the same resolver output
 * plus the clean work the resolver rebuilt, stands in for it.
 */
/** @param {Row} row @param {Row[]} rows */
function refusedButCorrect(row, rows) {
	if (row.admitted) return false;
	if (row.acceptance !== null) return row.acceptance === true;
	if (row.pipeline === "P0") return false;
	const p0 = rows.find((r) => r.scenario === row.scenario && r.strategy === row.strategy && r.pipeline === "P0");
	return p0?.acceptance === true;
}

/** @param {Row[]} rows */
function summarise(rows) {
	/** @type {Record<string, any>} */
	const byPipeline = {};
	for (const pipeline of PIPELINES) {
		const mine = rows.filter((r) => r.pipeline === pipeline);
		const admitted = mine.filter((r) => r.admitted);
		byPipeline[pipeline] = {
			attempts: mine.length,
			admitted: admitted.length,
			admitted_correct: admitted.filter((r) => r.acceptance === true).length,
			false_accepts: admitted.filter((r) => r.acceptance !== true).length,
			refused: mine.length - admitted.length,
			refused_but_correct: mine.filter((r) => refusedButCorrect(r, rows)).length,
		};
	}
	return byPipeline;
}

/** @param {number} n @param {number} d */
function pct(n, d) {
	return d === 0 ? "–" : `${Math.round((100 * n) / d)}%`;
}

/** @param {Results} results */
function markdown(results) {
	const lines = [];
	lines.push("# Governed-resolution benchmark — results", "");
	lines.push(`Generated ${results.generated_at} · Node ${results.node} · Mergiraf ${results.mergiraf ?? "not installed"} · legacy resolver ${LEGACY_COMMIT.slice(0, 7)}`, "");
	lines.push("Correct = the held-out acceptance test passes on the admitted tree. The pipelines never see that test.", "");
	for (const [label, kinds] of [["Conflicting scenarios (textual + list)", ["textual", "list"]], ["Clean-merging scenarios (semantic + control)", ["semantic", "control"]]]) {
		const rows = results.rows.filter((r) => kinds.includes(r.kind));
		const s = summarise(rows);
		lines.push(`## ${label}`, "");
		lines.push("| Pipeline | Attempts | Admitted | Admitted & correct | False accepts | Refused | Refused but correct |");
		lines.push("| --- | --- | --- | --- | --- | --- | --- |");
		for (const p of PIPELINES) {
			const x = s[p];
			lines.push(`| ${p} | ${x.attempts} | ${x.admitted} | ${x.admitted_correct} | ${x.false_accepts} (${pct(x.false_accepts, x.admitted)} of admitted) | ${x.refused} | ${x.refused_but_correct} |`);
		}
		lines.push("");
	}
	lines.push("## Every attempt", "");
	lines.push("| Scenario | Strategy | P0 | P1 | P2 |");
	lines.push("| --- | --- | --- | --- | --- |");
	const keys = [...new Set(results.rows.map((r) => `${r.scenario}\u0000${r.strategy}`))];
	const cell = (/** @type {Row | undefined} */ r) => {
		if (!r) return "–";
		const verdict = r.admitted ? "admit" : r.outcome === "REFUSED" ? "refused" : r.outcome.toLowerCase();
		const truth = r.acceptance === null ? "" : r.acceptance ? " ✓" : " ✗";
		return `${verdict}${truth}`;
	};
	for (const key of keys) {
		const [scenario, strategy] = key.split("\u0000");
		const get = (/** @type {string} */ p) => results.rows.find((r) => r.scenario === scenario && r.strategy === strategy && r.pipeline === p);
		lines.push(`| ${scenario} | ${strategy} | ${cell(get("P0"))} | ${cell(get("P1"))} | ${cell(get("P2"))} |`);
	}
	lines.push(
		"",
		"✓ / ✗: the held-out acceptance test passes / fails on the candidate (shown even when the pipeline refused it, if a commit exists).",
		"A lease refusal leaves no commit; \"Refused but correct\" then uses the same strategy's P0 candidate as a stand-in.",
		"",
	);
	lines.push("## By resolver behaviour (conflicting scenarios)", "");
	lines.push("| Strategy | P0 admitted (false) | P1 admitted (false) | P2 admitted (false) |");
	lines.push("| --- | --- | --- | --- |");
	for (const strategy of STRATEGIES) {
		const mine = results.rows.filter((r) => r.strategy === strategy);
		if (mine.length === 0) continue;
		const cellFor = (/** @type {string} */ p) => {
			const rs = mine.filter((r) => r.pipeline === p && r.admitted);
			return `${rs.length} (${rs.filter((r) => r.acceptance !== true).length})`;
		};
		lines.push(`| ${strategy} | ${cellFor("P0")} | ${cellFor("P1")} | ${cellFor("P2")} |`);
	}
	lines.push("");
	return lines.join("\n");
}

async function main() {
	const legacyResolve = await loadLegacyResolver();
	const scenarioIds = readdirSync(path.join(BENCH, "scenarios")).sort();
	/** @type {Row[]} */
	const rows = [];
	/** @type {Record<string, string[]>} */
	const problems = {};
	const started = Date.now();
	for (const id of scenarioIds) {
		const dir = path.join(BENCH, "scenarios", id);
		const scenario = JSON.parse(readFileSync(path.join(dir, "scenario.json"), "utf8"));
		const result =
			scenario.kind === "textual" || scenario.kind === "list"
				? await conflictScenario(scenario, dir, legacyResolve)
				: await composedScenario(scenario, dir);
		rows.push(...result.rows);
		if (result.problems.length > 0) problems[id] = result.problems;
		console.error(`[bench] ${id} (${scenario.kind}): ${result.rows.length} attempts${result.problems.length ? `, PROBLEMS: ${result.problems.join("; ")}` : ""}`);
	}
	const witnessTimes = rows.map((r) => r.witness_ms).filter((x) => typeof x === "number").sort((a, b) => a - b);
	const results = {
		generated_at: new Date().toISOString(),
		node: process.version,
		mergiraf: mergirafBin ? (spawnSync(mergirafBin, ["--version"], { encoding: "utf8" }).stdout ?? "").trim() : null,
		legacy_commit: LEGACY_COMMIT,
		duration_s: Math.round((Date.now() - started) / 1000),
		witness_check_ms: witnessTimes.length ? { median: witnessTimes[Math.floor(witnessTimes.length / 2)], max: witnessTimes.at(-1), n: witnessTimes.length } : null,
		problems,
		summary: {
			conflicting: summarise(rows.filter((r) => r.kind === "textual" || r.kind === "list")),
			clean_merging: summarise(rows.filter((r) => r.kind === "semantic" || r.kind === "control")),
		},
		rows,
	};
	mkdirSync(outDir, { recursive: true });
	writeFileSync(path.join(outDir, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
	writeFileSync(path.join(outDir, "results.md"), markdown(results));
	console.error(`[bench] wrote ${path.join(outDir, "results.md")} in ${results.duration_s}s`);
	if (Object.keys(problems).length > 0) process.exitCode = 1;
}

try {
	await main();
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
