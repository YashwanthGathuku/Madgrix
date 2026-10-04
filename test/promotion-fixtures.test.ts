/**
 * container/promote.sh and container/rebase.sh against the TypeScript model
 * of the same procedures, on one shared fixture table
 * (test/fixtures/promotion-cases.json; specs/amendments/rebase-ancestry-v1.md).
 *
 * Every case runs twice:
 *
 * - bash: the real script, under bash, against real git repositories built
 *   from the case's commit table (local bare repositories; GIT_ALLOW_PROTOCOL=file,
 *   so no remote can be reached);
 * - TS: src/lib/git-promotion.ts's model of the script against FakeArtifacts
 *   repositories built from the same table (src/harness/fake-container.ts).
 *
 * Both must print the case's fields and exit status, leave the expected refs,
 * map to the expected HTTP result through the mapping PromotionContainer.ts
 * uses, and drive the task authority to the expected outcome. The harnesses
 * (src/harness/head-move.ts, slice.ts) promote and rebase through the TS model,
 * so this table is what keeps them from accepting what the real container
 * refuses.
 *
 * The last suite runs src/do/PromotionContainer.ts itself with a container
 * whose exec runs the real scripts, so the environment the Durable Object
 * passes and the names the scripts read cannot drift apart.
 *
 * node --test test/promotion-fixtures.test.ts
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256Hex } from "../src/lib/canonical.ts";
import { FakeArtifacts } from "../src/lib/fake-artifacts.ts";
import * as taskState from "../src/lib/task-state.ts";
import type { Ctx } from "../src/lib/task-state.ts";
import { SELECTOR_POLICY_VERSION, type AuthorityState, type EvaluationBundle } from "../src/lib/types.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROMOTE_SH = path.join(REPO_ROOT, "container/promote.sh");
const REBASE_SH = path.join(REPO_ROOT, "container/rebase.sh");

type FileValue = string | { gitlink: string };
interface FixtureCase {
	name: string;
	commits: Record<string, { parents: string[]; files: Record<string, FileValue> }>;
	destination: string;
	fork: string;
	destination_rejects_push?: boolean;
	fork_rejects_push?: boolean;
	destination_moves_during_push_to?: string;
	fork_moves_during_push_to?: string;
	promote?: { candidate: string; expected_head: string; winning_tree: "candidate" | "other" };
	rebase?: { candidate: string; onto: string };
	expect: {
		exit: number;
		fields: Record<string, string | string[]>;
		destination_after?: string;
		fork_after?: string;
		new_commit?: { commits_above_onto: number; files: Record<string, string> };
		http: { status: number; outcome: string; paths?: string[] };
		authority?:
			| { fork_base: string; recorded: [string, string][]; permit: "ISSUED" | "REBASE_REQUIRED" }
			| { record: "RECORDED" | "ESCALATED" | null; permit_at_onto: "ISSUED" | "REBASE_REQUIRED" | "BLOCKED" };
	};
}

const table = JSON.parse(await readFile(path.join(REPO_ROOT, "test/fixtures/promotion-cases.json"), "utf8")) as {
	cases: FixtureCase[];
};

/** The model and its FakeArtifacts adapter; imported lazily so the bash
 *  half of every case still runs (and fails on its own) before they exist. */
async function model() {
	const gitPromotion = await import("../src/lib/git-promotion.ts");
	const fakeContainer = await import("../src/harness/fake-container.ts");
	const treeDigest = await import("../src/lib/tree-digest.ts");
	return { ...gitPromotion, ...fakeContainer, ...treeDigest };
}

/** What one run of a script (or its model) left behind, in the run's own SHAs. */
interface Run {
	exit: number;
	stdout: string;
	stderr: string;
	shaOf: Record<string, string>;
	destinationAfter: string | null;
	forkAfter: string | null;
	/** sha → first parent (null: root or unknown); and its files. */
	commit(sha: string): Promise<{ parent: string | null; files: Record<string, string> } | null>;
}

const SHA_FIELDS = ["PROMOTED_SHA", "BASE", "PARENT", "CURRENT_HEAD", "REBASED_SHA", "ONTO", "FORK_HEAD"];

function parseFields(stdout: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of stdout.split("\n")) {
		const i = line.indexOf("=");
		if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
	}
	return out;
}

function decodePaths(b64: string): string[] {
	const bytes = Buffer.from(b64, "base64");
	const out: string[] = [];
	let start = 0;
	for (let i = 0; i < bytes.length; i++) {
		if (bytes[i] === 0) {
			out.push(bytes.subarray(start, i).toString("utf8"));
			start = i + 1;
		}
	}
	return out;
}

/** The run's fields with SHAs replaced by fixture labels (`<new>` for a
 *  commit the run created), the candidate digest by `<candidate>`, and the
 *  conflict paths decoded. */
function normalize(run: Run, candidateDigest: string | null): Record<string, string | string[]> {
	const labelOf = new Map(Object.entries(run.shaOf).map(([label, sha]) => [sha, label]));
	const fields: Record<string, string | string[]> = {};
	for (const [key, value] of Object.entries(parseFields(run.stdout))) {
		if (SHA_FIELDS.includes(key)) fields[key] = labelOf.get(value) ?? (value === "" ? "" : "<new>");
		else if (key === "TREE_DIGEST") fields[key] = value === candidateDigest ? "<candidate>" : value;
		else if (key === "CONFLICT_PATHS") fields[key] = decodePaths(value);
		else fields[key] = value;
	}
	return fields;
}

function label(run: Run, sha: string | null): string | null {
	if (sha === null) return null;
	return Object.entries(run.shaOf).find(([, s]) => s === sha)?.[0] ?? "<new>";
}

/* ------------------------------------------------------------------ */
/* bash: real git repositories                                         */
/* ------------------------------------------------------------------ */

const roots: string[] = [];
after(async () => {
	for (const root of roots) await rm(root, { recursive: true, force: true });
});

function gitEnv(root: string): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: path.join(root, "home"),
		TMPDIR: path.join(root, "tmp"),
		LC_ALL: "C",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		// Local repositories only: no remote can be reached, whatever a script asks for.
		GIT_ALLOW_PROTOCOL: "file",
		GIT_TERMINAL_PROMPT: "0",
	};
}

function git(root: string, cwd: string, args: string[], extra: Record<string, string> = {}, input?: string | Buffer): string {
	const r = spawnSync("git", args, { cwd, env: { ...gitEnv(root), ...extra }, input: typeof input === "string" ? Buffer.from(input, "utf8") : input });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed (${r.status}): ${r.stderr.toString()}`);
	return r.stdout.toString().trim();
}

async function buildGitWorld(c: FixtureCase): Promise<{ root: string; shaOf: Record<string, string>; dest: string; fork: string }> {
	const root = await mkdtemp(path.join(os.tmpdir(), "madgrix-fixture-"));
	roots.push(root);
	for (const dir of ["home", "tmp", "builder"]) await mkdir(path.join(root, dir), { recursive: true });
	const builder = path.join(root, "builder");
	git(root, builder, ["init", "-q", "--bare"]);
	const shaOf: Record<string, string> = {};
	let i = 0;
	for (const [name, commit] of Object.entries(c.commits)) {
		const index = path.join(root, `index-${name}`);
		let entries = Buffer.alloc(0);
		for (const [p, value] of Object.entries(commit.files)) {
			const line =
				typeof value === "string"
					? `100644 ${git(root, builder, ["hash-object", "-w", "--stdin"], {}, value)}\t${p}\0`
					: `160000 ${shaOf[value.gitlink]}\t${p}\0`;
			entries = Buffer.concat([entries, Buffer.from(line, "utf8")]);
		}
		git(root, builder, ["update-index", "-z", "--index-info"], { GIT_INDEX_FILE: index }, entries);
		const tree = git(root, builder, ["write-tree"], { GIT_INDEX_FILE: index });
		const date = `2026-01-01T00:00:${String(i++).padStart(2, "0")}Z`;
		shaOf[name] = git(
			root,
			builder,
			["commit-tree", tree, ...commit.parents.flatMap((p) => ["-p", shaOf[p]]), "-m", name],
			{
				GIT_AUTHOR_NAME: "fixture",
				GIT_AUTHOR_EMAIL: "fixture@madgrix.invalid",
				GIT_AUTHOR_DATE: date,
				GIT_COMMITTER_NAME: "fixture",
				GIT_COMMITTER_EMAIL: "fixture@madgrix.invalid",
				GIT_COMMITTER_DATE: date,
			},
		);
	}
	const dest = path.join(root, "dest.git");
	const fork = path.join(root, "fork.git");
	for (const [repo, head, rejects, race] of [
		[dest, c.destination, c.destination_rejects_push, c.destination_moves_during_push_to],
		[fork, c.fork, c.fork_rejects_push, c.fork_moves_during_push_to],
	] as const) {
		git(root, root, ["init", "-q", "--bare", repo]);
		git(root, builder, ["push", "-q", repo, `${shaOf[head]}:refs/heads/main`]);
		// The racing writer's commit is in the repository already, off main.
		if (race) git(root, builder, ["push", "-q", repo, `${shaOf[race]}:refs/heads/race`]);
		if (rejects) {
			await writeFile(path.join(repo, "hooks/pre-receive"), "#!/bin/sh\necho 'push refused by fixture hook' >&2\nexit 1\n");
			await chmod(path.join(repo, "hooks/pre-receive"), 0o755);
		}
	}
	return { root, shaOf, dest, fork };
}

/**
 * A `git` first on PATH that, when the script runs `git ... push`, first moves
 * `repo`'s main to `sha` (another writer's push landing just before ours),
 * then runs the real git.
 */
async function raceShim(root: string, repo: string, sha: string): Promise<Record<string, string>> {
	const realGit = spawnSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
	const bin = path.join(root, "race-bin");
	await mkdir(bin, { recursive: true });
	await writeFile(
		path.join(bin, "git"),
		[
			"#!/bin/sh",
			'for arg in "$@"; do',
			'  if [ "$arg" = push ]; then',
			'    "$MADGRIX_TEST_REAL_GIT" --git-dir="$MADGRIX_TEST_RACE_REPO" update-ref refs/heads/main "$MADGRIX_TEST_RACE_SHA" || exit 99',
			"    break",
			"  fi",
			"done",
			'exec "$MADGRIX_TEST_REAL_GIT" "$@"',
			"",
		].join("\n"),
	);
	await chmod(path.join(bin, "git"), 0o755);
	return {
		PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
		MADGRIX_TEST_REAL_GIT: realGit,
		MADGRIX_TEST_RACE_REPO: repo,
		MADGRIX_TEST_RACE_SHA: sha,
	};
}

async function runBash(c: FixtureCase, candidateDigest: string | null): Promise<Run> {
	const { root, shaOf, dest, fork } = await buildGitWorld(c);
	let script: string;
	let inputs: Record<string, string>;
	if (c.promote) {
		script = PROMOTE_SH;
		inputs = {
			PERMIT_ID: "1".repeat(64),
			SOURCE_REMOTE: fork,
			SOURCE_TOKEN: "fixture-source-token",
			CANDIDATE_SHA: shaOf[c.promote.candidate],
			DESTINATION_REMOTE: dest,
			DESTINATION_TOKEN: "fixture-destination-token",
			EXPECTED_HEAD: shaOf[c.promote.expected_head],
			WINNING_TREE_SHA256: c.promote.winning_tree === "candidate" ? candidateDigest! : "0".repeat(64),
			ISSUED_AT: "2026-10-03T00:00:00Z",
		};
	} else {
		script = REBASE_SH;
		inputs = {
			OP_ID: "2".repeat(32),
			FORK_REMOTE: fork,
			FORK_TOKEN: "fixture-fork-token",
			CANDIDATE_SHA: shaOf[c.rebase!.candidate],
			DESTINATION_REMOTE: dest,
			DESTINATION_TOKEN: "fixture-destination-token",
			ONTO: shaOf[c.rebase!.onto],
		};
	}
	let race: Record<string, string> = {};
	if (c.destination_moves_during_push_to) race = await raceShim(root, dest, shaOf[c.destination_moves_during_push_to]);
	if (c.fork_moves_during_push_to) race = await raceShim(root, fork, shaOf[c.fork_moves_during_push_to]);
	const r = spawnSync("bash", [script], { env: { ...gitEnv(root), ...race, ...inputs }, encoding: "utf8" });
	const refOf = (repo: string): string | null => {
		const x = spawnSync("git", ["rev-parse", "-q", "--verify", "refs/heads/main"], { cwd: repo, env: gitEnv(root), encoding: "utf8" });
		return x.status === 0 ? x.stdout.trim() : null;
	};
	return {
		exit: r.status ?? -1,
		stdout: r.stdout,
		stderr: r.stderr,
		shaOf,
		destinationAfter: refOf(dest),
		forkAfter: refOf(fork),
		async commit(sha) {
			const parent = spawnSync("git", ["rev-parse", "-q", "--verify", `${sha}^`], { cwd: fork, env: gitEnv(root), encoding: "utf8" });
			const ls = spawnSync("git", ["ls-tree", "-r", "-z", sha], { cwd: fork, env: gitEnv(root) });
			if (ls.status !== 0) return null;
			const files: Record<string, string> = {};
			for (const entry of ls.stdout.toString("utf8").split("\0").filter(Boolean)) {
				const [meta, p] = [entry.slice(0, entry.indexOf("\t")), entry.slice(entry.indexOf("\t") + 1)];
				const blob = spawnSync("git", ["cat-file", "blob", meta.split(" ")[2]], { cwd: fork, env: gitEnv(root), encoding: "utf8" });
				files[p] = blob.stdout;
			}
			return { parent: parent.status === 0 ? parent.stdout.trim() : null, files };
		},
	};
}

/* ------------------------------------------------------------------ */
/* TS: the model on FakeArtifacts                                      */
/* ------------------------------------------------------------------ */

async function runModel(c: FixtureCase, candidateDigest: string | null): Promise<Run> {
	const m = await model();
	const fake = new FakeArtifacts({ now: () => Date.parse("2026-10-03T00:00:00Z") });
	await fake.create("builder");
	await fake.create("dest");
	await fake.create("fork");
	const shaOf: Record<string, string> = {};
	for (const [name, commit] of Object.entries(c.commits)) {
		const tree: Record<string, string> = {};
		for (const [p, value] of Object.entries(commit.files)) {
			tree[p] = typeof value === "string" ? value : m.FAKE_GITLINK_PREFIX + shaOf[value.gitlink];
		}
		shaOf[name] = await fake.writeCommit("builder", { parents: commit.parents.map((p) => shaOf[p]), tree, message: name });
	}
	for (const [repo, head, race] of [
		["dest", c.destination, c.destination_moves_during_push_to],
		["fork", c.fork, c.fork_moves_during_push_to],
	] as const) {
		fake.importHistory("builder", repo, shaOf[head]);
		if (race) fake.importHistory("builder", repo, shaOf[race]);
		assert.ok(fake.casRef(repo, "main", null, shaOf[head]));
	}
	const run = c.promote
		? await m.runPromoteModel(
				{
					candidate_sha: shaOf[c.promote.candidate],
					expected_head: shaOf[c.promote.expected_head],
					winning_tree_sha256: c.promote.winning_tree === "candidate" ? candidateDigest! : "0".repeat(64),
				},
				m.fakePromoteGit(fake, {
					source: "fork",
					destination: "dest",
					rejectPush: c.destination_rejects_push === true,
					concurrentPush: c.destination_moves_during_push_to && shaOf[c.destination_moves_during_push_to],
				}),
			)
		: await m.runRebaseModel(
				{ candidate_sha: shaOf[c.rebase!.candidate], onto: shaOf[c.rebase!.onto] },
				m.fakeRebaseGit(fake, {
					fork: "fork",
					destination: "dest",
					rejectPush: c.fork_rejects_push === true,
					concurrentPush: c.fork_moves_during_push_to && shaOf[c.fork_moves_during_push_to],
				}),
			);
	return {
		...run,
		shaOf,
		destinationAfter: await (await fake.get("dest")).getHead(),
		forkAfter: await (await fake.get("fork")).getHead(),
		async commit(sha) {
			const object = fake.readCommitObject("fork", sha);
			if (object === null) return null;
			return { parent: object.parents[0] ?? null, files: { ...object.tree } };
		},
	};
}

/* ------------------------------------------------------------------ */
/* The task authority, driven by a run's result                        */
/* ------------------------------------------------------------------ */

function ctx(): Ctx {
	let n = 0;
	return {
		now: () => `2026-10-03T00:00:${String(n++ % 60).padStart(2, "0")}.000Z`,
		randomHex: (bytes: number) => "7".repeat(bytes * 2),
		sha256Hex,
		selectorPolicyHash: "policyhash",
		policyVersion: SELECTOR_POLICY_VERSION,
	};
}

async function forkedAuthority(baseline: string, c: Ctx): Promise<AuthorityState> {
	const task_hash = await sha256Hex("fixture task");
	let state = taskState.createAuthority({
		task_id: "task-fixture",
		task_hash,
		intent: "fix",
		baseline_repo: "canonical",
		baseline_commit: baseline,
		behavior_contract: "",
		policy_version: SELECTOR_POLICY_VERSION,
		frozen_at: c.now(),
	});
	state = (
		await taskState.registerContender(
			state,
			{
				contender_id: "contender-1",
				agent_id: "agent-1",
				fork_repo: "fork",
				fork_lineage: { parent_repo: "canonical", parent_commit: baseline },
				fork_base: baseline,
				token_id: "tok-1",
				token_ids: ["tok-1"],
				status: "forked",
				claim_work_id: null,
				latest_commit: baseline,
			} as never,
			c,
		)
	).state;
	return state;
}

async function observe(state: AuthorityState, sha: string, c: Ctx): Promise<AuthorityState> {
	const before = state.contenders["contender-1"].latest_commit ?? "";
	if (before === sha) return state;
	return (await taskState.ingestQueueEvent(state, { namespace: "fixture", repo: "fork", ref: "refs/heads/main", before, after: sha }, c)).state;
}

async function acceptedEvidence(state: AuthorityState, sha: string, c: Ctx): Promise<AuthorityState> {
	const rest = {
		candidate_sha: sha,
		tree_sha256: await sha256Hex(`tree ${sha}`),
		contender_id: "contender-1",
		task_hash: state.task.task_hash,
		admission: { exact_baseline: true, scope_compliance: true, valid_tool_states: true, no_eval_tampering: true, provenance_complete: true },
		hidden_oracle: { passed: true, total: 1, failed: [] as string[] },
		regressions: { passed: true, total: 1, failed: [] as string[] },
		static_analysis: { passed: true, findings: [] as string[] },
		semantic_checks: { passed: true, total: 1, failed: [] as string[] },
		security_policy: { passed: true, findings: [] as string[] },
		evaluated_at: c.now(),
		tainted: false,
	};
	const bundle = { ...rest, bundle_hash: await sha256Hex(canonicalJson(rest)) } as EvaluationBundle;
	state = (await taskState.submitEvaluation(state, bundle, { zone: "evaluation_domain" }, c)).state;
	const verdict = await taskState.runVerdictSeam(
		state,
		[{ contender_id: "contender-1", candidate_sha: sha, blast_radius: 1, change_surface: 1 }],
		c,
	);
	assert.equal(verdict.record.state, "ACCEPT");
	return verdict.state;
}

async function permitOutcome(state: AuthorityState, sha: string, head: string, c: Ctx): Promise<string> {
	try {
		return ((await taskState.issuePermit(state, sha, "canonical", head, c)) as { outcome?: string }).outcome ?? "ISSUED(no outcome field)";
	} catch (err) {
		if (/escalated/.test((err as Error).message)) return "BLOCKED";
		throw err;
	}
}

async function checkAuthority(cse: FixtureCase, run: Run, http: { status: number; body: any }): Promise<void> {
	const expected = cse.expect.authority;
	if (!expected) return;
	const c = ctx();
	if ("permit" in expected) {
		let state = await forkedAuthority(run.shaOf[expected.fork_base], c);
		for (const [onto, sha] of expected.recorded) {
			state = (
				await (taskState as any).recordRebase(
					state,
					{ contender_id: "contender-1", outcome: "UP_TO_DATE", from_sha: run.shaOf[sha], onto: run.shaOf[onto] },
					c,
				)
			).state;
		}
		const candidate = run.shaOf[cse.promote!.candidate];
		state = await acceptedEvidence(await observe(state, candidate, c), candidate, c);
		assert.equal(await permitOutcome(state, candidate, run.shaOf[cse.promote!.expected_head], c), expected.permit, "permit decision");
		return;
	}
	const candidate = run.shaOf[cse.rebase!.candidate];
	const onto = run.shaOf[cse.rebase!.onto];
	let state = await acceptedEvidence(await observe(await forkedAuthority(run.shaOf.B, c), candidate, c), candidate, c);
	let target = candidate;
	let recorded: string | null = null;
	const body = http.body;
	if (http.status === 200 || body.outcome === "CONFLICT") {
		const report =
			body.outcome === "CONFLICT"
				? { contender_id: "contender-1", outcome: "CONFLICT", from_sha: candidate, onto: body.onto, paths: body.paths }
				: { contender_id: "contender-1", outcome: body.outcome, from_sha: candidate, onto: body.onto, new_sha: body.rebased_sha };
		if (report.outcome === "UP_TO_DATE") delete (report as { new_sha?: string }).new_sha;
		const r = await (taskState as any).recordRebase(state, report, c);
		recorded = r.outcome;
		state = r.state;
		if (body.outcome === "REBASED") {
			target = body.rebased_sha;
			assert.equal(state.contenders["contender-1"].latest_commit, target, "the rebased commit re-enters evaluation");
			state = await acceptedEvidence(state, target, c);
		}
		if (body.outcome === "CONFLICT") {
			assert.deepEqual((state.escalations.at(-1) as any)?.data?.paths, expected.record === "ESCALATED" ? cse.expect.http.paths : undefined);
		}
	}
	assert.equal(recorded, expected.record, "what the authority recorded");
	assert.equal(await permitOutcome(state, target, onto, c), expected.permit_at_onto, "permit at onto");
}

/* ------------------------------------------------------------------ */
/* The table                                                           */
/* ------------------------------------------------------------------ */

/**
 * tree-digest/v1 (specs/amendments/tree-digest-v1.md) of a candidate's files,
 * computed here from the definition: SHA-256 over `mode NUL path NUL
 * SHA256(bytes) NUL` per blob in git's path order (byte order of the full
 * path). promote.sh and the model must both print exactly this.
 */
function candidateDigestOf(c: FixtureCase): string | null {
	const candidate = c.promote?.candidate;
	if (!candidate) return null;
	const files = c.commits[candidate].files;
	if (Object.values(files).some((v) => typeof v !== "string")) return null;
	const entries = Object.entries(files as Record<string, string>)
		.map(([p, content]) => ({ path: Buffer.from(p, "utf8"), content }))
		.sort((a, b) => Buffer.compare(a.path, b.path));
	const digest = createHash("sha256");
	for (const e of entries) {
		digest.update("100644\0");
		digest.update(e.path);
		digest.update(`\0${createHash("sha256").update(e.content, "utf8").digest("hex")}\0`);
	}
	return digest.digest("hex");
}

async function checkRun(cse: FixtureCase, run: Run, candidateDigest: string | null, side: string): Promise<void> {
	const e = cse.expect;
	assert.equal(run.exit, e.exit, `${side}: exit status (stdout ${JSON.stringify(run.stdout)}, stderr ${JSON.stringify(run.stderr)})`);
	assert.deepEqual(normalize(run, candidateDigest), e.fields, `${side}: fields`);
	if (e.destination_after) assert.equal(label(run, run.destinationAfter), e.destination_after, `${side}: destination main after`);
	if (e.fork_after) assert.equal(label(run, run.forkAfter), e.fork_after, `${side}: fork main after`);
	if (e.new_commit) {
		const rebased = parseFields(run.stdout).REBASED_SHA;
		let sha: string | null = rebased;
		for (let i = 0; i < e.new_commit.commits_above_onto; i++) sha = (await run.commit(sha!))?.parent ?? null;
		assert.equal(sha, run.shaOf[cse.rebase!.onto], `${side}: the rebased commit sits ${e.new_commit.commits_above_onto} commit(s) above onto`);
		assert.deepEqual((await run.commit(rebased))?.files, e.new_commit.files, `${side}: the rebased commit's files`);
	}
	const m = await model();
	const http = cse.promote ? m.promotionHttpResult(run.exit, run.stdout, run.stderr) : m.rebaseHttpResult(run.exit, run.stdout, run.stderr);
	assert.equal(http.status, e.http.status, `${side}: HTTP status`);
	assert.equal(http.body.outcome, e.http.outcome, `${side}: HTTP outcome`);
	if (e.http.paths) assert.deepEqual((http.body as { paths?: string[] }).paths, e.http.paths, `${side}: HTTP conflict paths`);
	await checkAuthority(cse, run, http);
}

describe("container scripts and the TS model agree on the shared fixture table", () => {
	for (const cse of table.cases) {
		describe(cse.name, () => {
			const digest = candidateDigestOf(cse);
			it("bash (real git)", async () => {
				await checkRun(cse, await runBash(cse, digest), digest, "bash");
			});
			it("TS model (FakeArtifacts)", async () => {
				await checkRun(cse, await runModel(cse, digest), digest, "TS");
			});
		});
	}
});

describe("PromotionContainer runs the real scripts with the environment they read", () => {
	/** A Cloudflare container whose exec runs container/<script> locally; the
	 *  https remotes the Durable Object accepts are rewritten to the local
	 *  bare repositories (git url.<path>.insteadOf), and GIT_ALLOW_PROTOCOL=file
	 *  refuses anything else. */
	function localContainer(root: string, remotes: Record<string, string>) {
		const rewrite: Record<string, string> = {};
		Object.entries(remotes).forEach(([url, local], i) => {
			rewrite[`GIT_CONFIG_KEY_${i}`] = `url.${local}.insteadOf`;
			rewrite[`GIT_CONFIG_VALUE_${i}`] = url;
		});
		rewrite.GIT_CONFIG_COUNT = String(Object.keys(remotes).length);
		const calls: string[][] = [];
		const container = {
			calls,
			running: false,
			destroyed: 0,
			start() {
				container.running = true;
			},
			async exec(argv: string[], opts: { env: Record<string, string> }) {
				calls.push(argv);
				const script = path.join(REPO_ROOT, "container", path.basename(argv[0]));
				const r = spawnSync("bash", [script], { env: { ...gitEnv(root), ...rewrite, ...opts.env } });
				return {
					output: async () => ({ exitCode: r.status ?? -1, stdout: new Uint8Array(r.stdout), stderr: new Uint8Array(r.stderr) }),
					kill() {},
				};
			},
			async destroy() {
				container.running = false;
				container.destroyed++;
			},
		};
		return container;
	}

	it("promote: the reviewed candidate fast-forwards; BASE and PARENT come back from git", async () => {
		const cse = table.cases.find((x) => x.name.startsWith("promote: PARENT is the candidate's own parent"))!;
		const digest = candidateDigestOf(cse);
		const { root, shaOf, dest, fork } = await buildGitWorld(cse);
		const container = localContainer(root, {
			"https://dest.artifacts.cloudflare.net/git/dest.git": dest,
			"https://fork.artifacts.cloudflare.net/git/fork.git": fork,
		});
		const { PromotionContainer } = await import("../src/do/PromotionContainer.ts");
		const res = await new PromotionContainer({ container } as never, {} as never).fetch(
			new Request("https://promotion/run", {
				method: "POST",
				body: JSON.stringify({
					permit_id: "3".repeat(64),
					source_remote: "https://fork.artifacts.cloudflare.net/git/fork.git",
					source_token: "t1",
					candidate_sha: shaOf.X,
					destination_remote: "https://dest.artifacts.cloudflare.net/git/dest.git",
					destination_token: "t2",
					expected_destination_head: shaOf.B,
					winning_tree_sha256: digest,
					issued_at: "2026-10-03T00:00:00Z",
				}),
			}),
		);
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), {
			outcome: "PROMOTED",
			promoted_sha: shaOf.X,
			tree_sha256: digest,
			base: shaOf.B,
			parent: shaOf.C1,
		});
		assert.deepEqual(container.calls, [["/opt/madgrix/promote.sh"]]);
		assert.equal(container.destroyed, 1, "the container is destroyed after the promotion");
	});

	it("rebase: a clean rebase is REBASED and a conflict is CONFLICT with its paths", async () => {
		const { PromotionContainer } = await import("../src/do/PromotionContainer.ts");
		for (const [prefix, status] of [
			["rebase: a clean replay onto the moved head", 200],
			["rebase: conflict paths are data", 409],
		] as const) {
			const cse = table.cases.find((x) => x.name.startsWith(prefix))!;
			const { root, shaOf, dest, fork } = await buildGitWorld(cse);
			const container = localContainer(root, {
				"https://dest.artifacts.cloudflare.net/git/dest.git": dest,
				"https://fork.artifacts.cloudflare.net/git/fork.git": fork,
			});
			const res = await new PromotionContainer({ container } as never, {} as never).fetch(
				new Request("https://promotion/rebase", {
					method: "POST",
					body: JSON.stringify({
						action: "rebase",
						op_id: "4".repeat(32),
						fork_remote: "https://fork.artifacts.cloudflare.net/git/fork.git",
						fork_token: "t1",
						candidate_sha: shaOf.X,
						destination_remote: "https://dest.artifacts.cloudflare.net/git/dest.git",
						destination_token: "t2",
						onto: shaOf.H2,
					}),
				}),
			);
			assert.equal(res.status, status, prefix);
			const body = (await res.json()) as Record<string, unknown>;
			assert.deepEqual(container.calls, [["/opt/madgrix/rebase.sh"]]);
			assert.equal(container.destroyed, 1, "the container is destroyed after the rebase");
			if (status === 200) {
				assert.equal(body.outcome, "REBASED");
				assert.equal(body.onto, shaOf.H2);
				assert.match(String(body.rebased_sha), /^[0-9a-f]{40}$/);
				assert.notEqual(body.rebased_sha, shaOf.X);
			} else {
				assert.deepEqual(body, { outcome: "CONFLICT", onto: shaOf.H2, paths: cse.expect.http.paths, paths_total: 3 });
			}
		}
	});
});
