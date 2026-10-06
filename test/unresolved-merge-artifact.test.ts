/**
 * A commit that contains unresolved merge markers is not a candidate, even
 * when nobody calls POST /tasks/:id/composition and run-fork-crew never runs.
 *
 * The commit is created directly. The trusted evaluator scans its blobs.
 * That bundle is what the authority admits. The promotion container scans
 * the same blobs again and does not fast-forward.
 *
 * This file does not import scripts/lib/fork-crew.mjs and does not record
 * a composition.
 *
 * node --test test/unresolved-merge-artifact.test.ts
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson, sha256Hex } from "../src/lib/canonical.ts";
import { eligibility } from "../src/lib/verdict-seam.ts";
import { FakeArtifacts } from "../src/lib/fake-artifacts.ts";
import { fakePromote } from "../src/harness/fake-container.ts";
import {
	MERGE_ARTIFACT_SCANNER_V1,
	blobHasConflictMarkers,
	completeMergeArtifactScan,
	hasUnresolvedMergeArtifacts,
	mergeArtifactScanComplete,
	mergeArtifactScanIssue,
	unmergedIndexPaths,
	unresolvedMergeArtifacts,
} from "../src/lib/merge-artifacts.ts";
import {
	attemptPromotion,
	createAuthority,
	issuePermit,
	runVerdictSeam,
	submitEvaluation,
	type Ctx,
} from "../src/lib/task-state.ts";
import { treeDigestOfFiles } from "../src/lib/tree-digest.ts";
import type { AuthorityState, EvaluationBundle, VerdictRecord } from "../src/lib/types.ts";
import {
	BASELINE_TREE,
	FIXED_TREE,
	TOKENS,
	authorityState,
	call,
	evidence,
	makeHarness,
	push,
} from "./helpers/worker-harness.ts";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MARKERS = "<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> topic\n";
const EQUALS_ONLY = "a rule\n=======\nstill a rule\n";
const END_ONLY = ">>>>>>> topic\n";

function utf8(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

describe("merge-artifact scan", () => {
	it("recognizes a marker pair, including diff3, and ignores a markdown rule and an end marker alone", () => {
		const hits = unresolvedMergeArtifacts({
			blobs: [
				{ path: "src/shared.js", bytes: utf8(MARKERS) },
				{ path: "src/diff3.js", bytes: utf8("<<<<<<< ours\nours\n||||||| base\nbase\n=======\ntheirs\n>>>>>>> theirs\n") },
				{ path: "docs/note.md", bytes: utf8(EQUALS_ONLY) },
				{ path: "src/end-only.js", bytes: utf8(END_ONLY) },
				{ path: "src/mid.js", bytes: utf8("prefix <<<<<<< HEAD\n>>>>>>> topic\n") },
				{ path: "src/width.js", bytes: utf8("<<<<<<< HEAD\nours\n>>>>>>>> topic\n") },
			],
		});
		assert.deepEqual(hits, ["src/diff3.js", "src/shared.js"]);
		assert.equal(blobHasConflictMarkers(utf8("")), false);
	});

	it("parses an unmerged index and ignores stage 0", () => {
		const listed = [
			"100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1\tsrc/shared.js",
			"100644 bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 2\tsrc/shared.js",
			"100644 cccccccccccccccccccccccccccccccccccccccc 3\tsrc/shared.js",
			"100644 dddddddddddddddddddddddddddddddddddddddd 0\tREADME.md",
		].join("\n");
		assert.deepEqual(unmergedIndexPaths(listed), ["src/shared.js"]);
		assert.equal(hasUnresolvedMergeArtifacts(undefined), false);
		assert.equal(hasUnresolvedMergeArtifacts({ unresolved_merge_artifacts: [] }), false);
		assert.equal(hasUnresolvedMergeArtifacts({ unresolved_merge_artifacts: ["src/shared.js"] }), true);
		const bound = completeMergeArtifactScan({ candidate_sha: "sha", tree_sha256: "tree", paths: [] });
		assert.equal(hasUnresolvedMergeArtifacts({ merge_artifact_scan: bound }), false);
		assert.equal(mergeArtifactScanComplete({ candidate_sha: "sha", tree_sha256: "tree", merge_artifact_scan: bound }), true);
		assert.equal(
			hasUnresolvedMergeArtifacts({
				merge_artifact_scan: completeMergeArtifactScan({ candidate_sha: "sha", tree_sha256: "tree", paths: ["src/shared.js"] }),
			}),
			true,
		);
		assert.equal(mergeArtifactScanIssue(undefined), "missing");
		assert.equal(mergeArtifactScanComplete({ candidate_sha: "sha", tree_sha256: "tree" }), false);
	});
});

describe("an unmerged index is not a candidate commit", () => {
	it("git will not commit the unmerged index, and the parser names the path", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "madgrix-unmerged-"));
		const git = (args: string[], cwd = root) =>
			spawnSync("git", ["-c", "user.name=madgrix-test", "-c", "user.email=test@madgrix.invalid", "-c", "commit.gpgsign=false", ...args], {
				cwd,
				encoding: "utf8",
				env: { PATH: process.env.PATH ?? "", HOME: root, GIT_CONFIG_NOSYSTEM: "1" },
			});
		assert.equal(git(["init", "--quiet", "--initial-branch=main"]).status, 0);
		await mkdir(path.join(root, "src"), { recursive: true });
		await writeFile(path.join(root, "src/shared.js"), "base\n");
		assert.equal(git(["add", "-A"]).status, 0);
		assert.equal(git(["commit", "--quiet", "-m", "baseline"]).status, 0);
		assert.equal(git(["checkout", "-q", "-b", "side"]).status, 0);
		await writeFile(path.join(root, "src/shared.js"), "side\n");
		assert.equal(git(["commit", "--quiet", "-am", "side"]).status, 0);
		assert.equal(git(["checkout", "-q", "main"]).status, 0);
		await writeFile(path.join(root, "src/shared.js"), "main\n");
		assert.equal(git(["commit", "--quiet", "-am", "main"]).status, 0);
		const merge = git(["merge", "--no-edit", "side"]);
		assert.notEqual(merge.status, 0, merge.stderr);
		const listed = git(["ls-files", "--unmerged"]);
		assert.equal(listed.status, 0, listed.stderr);
		assert.deepEqual(unmergedIndexPaths(listed.stdout), ["src/shared.js"]);
		const worktree = await readFile(path.join(root, "src/shared.js"));
		assert.equal(blobHasConflictMarkers(worktree), true);
		const committed = git(["commit", "--quiet", "-m", "should not commit an unmerged index"]);
		assert.notEqual(committed.status, 0, "git commit must refuse an unmerged index");
		await rm(root, { recursive: true, force: true });
	});
});

const TASK_ID = "task-unresolved-markers";
const TASK_HASH = "ab".repeat(32);
const EVAL_TOKEN = "eval-token-unresolved-markers";

function ctx(): Ctx {
	return {
		now: () => "2026-10-06T12:00:00.000Z",
		randomHex: (n: number) => "e".repeat(n * 2),
		sha256Hex,
		selectorPolicyHash: "policyhash",
		policyVersion: "seam-policy/0.1.0",
	};
}

function authorityFor(sha: string, baseline: string): AuthorityState {
	const state = createAuthority({
		task_id: TASK_ID,
		task_hash: TASK_HASH,
		intent: "do not admit an unresolved merge",
		baseline_repo: "acme/api",
		baseline_commit: baseline,
		behavior_contract: "the tree has no merge markers",
		policy_version: "seam-policy/0.1.0",
		frozen_at: "2026-10-06T11:00:00.000Z",
	});
	state.contenders["contender-markers"] = {
		contender_id: "contender-markers",
		agent_id: "agent-markers",
		fork_repo: "fork-markers",
		fork_lineage: { parent_repo: "acme/api", parent_commit: baseline },
		fork_base: baseline,
		token_id: "tok-markers",
		status: "forked",
		claim_work_id: null,
		latest_commit: sha,
	};
	return state;
}

describe("unrecorded conflict markers never become a candidate", () => {
	const roots: string[] = [];
	after(async () => {
		for (const root of roots) await rm(root, { recursive: true, force: true });
	});

	it("the evaluator scans a directly committed marker tree, and the authority admits no eligibility, permit, or canonical write", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "madgrix-markers-"));
		roots.push(root);
		const home = path.join(root, "home");
		const seed = path.join(root, "seed");
		const bare = path.join(root, "fork.git");
		const work = path.join(root, "work");
		await mkdir(home, { recursive: true });
		await mkdir(seed, { recursive: true });
		const git = (cwd: string, args: string[]) => {
			const result = spawnSync(
				"git",
				["-c", "user.name=madgrix-test", "-c", "user.email=test@madgrix.invalid", "-c", "commit.gpgsign=false", ...args],
				{ cwd, encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: home, GIT_CONFIG_NOSYSTEM: "1" } },
			);
			assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
			return (result.stdout ?? "").trim();
		};
		git(seed, ["init", "--quiet", "--initial-branch=main"]);
		await writeFile(path.join(seed, "README.md"), "base\n");
		git(seed, ["add", "-A"]);
		git(seed, ["commit", "--quiet", "-m", "baseline"]);
		const baseline = git(seed, ["rev-parse", "HEAD"]);
		git(root, ["clone", "--quiet", "--bare", seed, bare]);
		git(root, ["clone", "--quiet", bare, work]);
		await mkdir(path.join(work, "src"), { recursive: true });
		await writeFile(path.join(work, "src/shared.js"), MARKERS);
		await writeFile(path.join(work, "src/note.js"), EQUALS_ONLY);
		await writeFile(path.join(work, "src/end-only.js"), END_ONLY);
		const toolLog =
			[
				JSON.stringify({
					format: "madgrix-tool-status/v1",
					task_id: TASK_ID,
					contender_id: "contender-markers",
					agent_id: "agent-markers",
					baseline_commit: baseline,
					model: "test-model-7",
					harness: "test-harness/1.0",
				}),
				JSON.stringify({ seq: 1, action: "edit_file", tool_status: "OK" }),
			].join("\n") + "\n";
		await mkdir(path.join(work, ".madgrix"), { recursive: true });
		await writeFile(path.join(work, ".madgrix/tool-status.jsonl"), toolLog);
		git(work, ["add", "-A"]);
		git(work, ["commit", "--quiet", "-m", "candidate with unresolved markers"]);
		const sha = git(work, ["rev-parse", "HEAD"]);
		git(work, ["push", "--quiet", "origin", "HEAD:refs/heads/main"]);

		const names = git(bare, ["ls-tree", "-r", "--name-only", sha]).split("\n").filter(Boolean);
		const blobs = names.map((name) => ({
			path: name,
			bytes: spawnSync("git", ["cat-file", "blob", `${sha}:${name}`], { cwd: bare }).stdout as Buffer,
		}));
		assert.deepEqual(
			unresolvedMergeArtifacts({ blobs }),
			["src/shared.js"],
			"the committed tree itself, not a composition record, carries the marker pair",
		);
		const unmerged = git(work, ["ls-files", "--unmerged"]);
		assert.equal(unmerged, "", "a commit has no unmerged index; the blob scan is the signal");

		const seen: string[] = [];
		let posted: EvaluationBundle | null = null;
		const server: Server = createServer(async (req, res) => {
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(chunk as Buffer);
			const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
			const pathname = new URL(req.url ?? "/", "http://mock.invalid").pathname;
			seen.push(`${req.method} ${pathname}`);
			const send = (status: number, data: unknown) => {
				res.writeHead(status, { "content-type": "application/json" });
				res.end(JSON.stringify(data));
			};
			if (req.headers.authorization !== `Bearer ${EVAL_TOKEN}`) return send(401, { error: "evaluation_domain_auth_required" });
			if (req.method === "POST" && pathname === `/tasks/${TASK_ID}/evaluator-credentials`) {
				return send(200, {
					contender_id: "contender-markers",
					fork_repo: "fork-markers",
					remote: bare,
					token: "fake-fork-read-token",
					expires_at: "2026-10-06T13:00:00.000Z",
					task_hash: TASK_HASH,
					baseline_commit: baseline,
					claim: { agent: "agent-markers", scope: { paths: ["src/**"], symbols: [] } },
					latest_commit: sha,
					agent_id: "agent-markers",
					fork_lineage: { parent_repo: "acme/api", parent_commit: baseline },
					evaluation_bases: [baseline],
				});
			}
			if (req.method === "POST" && pathname === `/tasks/${TASK_ID}/evidence`) {
				posted = body.bundle as EvaluationBundle;
				return send(200, { recorded: true });
			}
			return send(404, { error: "no_such_route" });
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		try {
			const run = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
				// Node 22.18 and Node 24 strip types by default. 22.17, which is
				// what this machine runs, does not, and the flag does not cross
				// into a child started as `node script.ts`.
				const [major, minor] = process.versions.node.split(".").map(Number);
				const nodeArgs =
					major < 22 || (major === 22 && minor < 18)
						? ["--experimental-strip-types", "scripts/evaluate-candidate.ts"]
						: ["scripts/evaluate-candidate.ts"];
				const child = spawn(process.execPath, nodeArgs, {
					cwd: REPO_ROOT,
					env: {
						PATH: process.env.PATH ?? "",
						HOME: home,
						LANG: "C.UTF-8",
						TMPDIR: root,
						MADGRIX_BASE_URL: baseUrl,
						MADGRIX_TASK_ID: TASK_ID,
						MADGRIX_CONTENDER_ID: "contender-markers",
						MADGRIX_CANDIDATE_SHA: sha,
						MADGRIX_EVALUATION_SERVICE_TOKEN: EVAL_TOKEN,
						MADGRIX_HIDDEN_TEST_COMMAND: "exit 0",
					},
					stdio: ["ignore", "ignore", "pipe"],
				});
				let stderr = "";
				child.stderr.on("data", (buf) => (stderr += buf));
				child.on("error", reject);
				child.on("close", (code) => resolve({ code, stderr }));
			});
			assert.equal(run.code, 0, run.stderr);
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
		assert.ok(posted, "the evaluator submitted evidence");
		const bundle = posted as EvaluationBundle;
		assert.deepEqual(bundle.unresolved_merge_artifacts, ["src/shared.js"]);
		assert.deepEqual(bundle.merge_artifact_scan, {
			status: "COMPLETE",
			scanner: MERGE_ARTIFACT_SCANNER_V1,
			candidate_sha: sha,
			tree_sha256: bundle.tree_sha256,
			paths: ["src/shared.js"],
		});
		assert.equal(bundle.admission.exact_baseline, true);
		assert.equal(bundle.admission.scope_compliance, true);
		assert.equal(bundle.admission.no_eval_tampering, true);
		assert.equal(bundle.admission.valid_tool_states, true);
		assert.equal(bundle.admission.provenance_complete, true);
		assert.equal(bundle.hidden_oracle.passed, true);
		assert.equal(bundle.regressions.passed, true);
		assert.ok(!seen.some((line) => line.includes("composition")), `composition was not posted: ${seen.join(", ")}`);

		const c = ctx();
		let state = authorityFor(sha, baseline);
		assert.equal(state.composition, undefined);
		state = (await submitEvaluation(state, bundle, { zone: "evaluation_domain" }, c)).state;
		assert.equal(state.composition, undefined, "POST /composition was not part of this admission");
		const seam = await runVerdictSeam(
			state,
			[{ contender_id: "contender-markers", candidate_sha: sha, blast_radius: 1, change_surface: 1 }],
			c,
		);
		assert.equal(seam.record.state, "REJECT");
		assert.match(seam.record.reasons.join("\n"), /no_unresolved_merge_artifacts/);
		assert.equal(seam.record.winner_sha, null);
		assert.deepEqual(Object.keys(seam.state.permits), []);
		await assert.rejects(issuePermit(seam.state, sha, "acme/api", baseline, c), /no ACCEPT verdict/);
		const missing = await attemptPromotion(seam.state, "ab".repeat(32), baseline, bundle.tree_sha256, c);
		assert.equal(missing.outcome, "UNKNOWN_PERMIT");
		assert.equal(
			missing.effects.some((effect) => effect.kind === "canonical_write"),
			false,
		);
		assert.deepEqual(missing.effects, []);

		const forced: VerdictRecord = {
			state: "ACCEPT",
			candidate_shas: [sha],
			evidence_hashes: [bundle.bundle_hash],
			reasons: ["injected after the seam rejected the markers"],
			policy_hash: "policyhash",
			selector_policy_version: "seam-policy/0.1.0",
			timestamp: "2026-10-06T12:00:00.000Z",
			winner_sha: sha,
		};
		const refused = await issuePermit({ ...seam.state, verdicts: [...seam.state.verdicts, forced] }, sha, "acme/api", baseline, c);
		assert.equal(refused.outcome, "UNRESOLVED_CONFLICT");
		assert.equal(refused.permit, null);
		assert.deepEqual(Object.keys(refused.state.permits), []);
		const promoted = await attemptPromotion(refused.state, "cd".repeat(32), baseline, bundle.tree_sha256, c);
		assert.deepEqual(promoted.effects, []);
	});
});

describe("the worker authority path", () => {
	const conflicted = {
		...BASELINE_TREE,
		"src/shared.js": MARKERS,
		"src/note.js": EQUALS_ONLY,
		"src/end-only.js": END_ONLY,
	};

	it("evidence that reports the marker paths is not eligible, and promotion is not started", async () => {
		const h = await makeHarness();
		const sha = await push(h, conflicted, h.baseline);
		const artifacts = unresolvedMergeArtifacts({
			blobs: Object.entries(conflicted).map(([file, text]) => ({ path: file, bytes: utf8(text) })),
		});
		assert.deepEqual(artifacts, ["src/shared.js"]);
		const tree = h.fake.readCommitObject(h.forkRepo, sha)!.tree;
		const tree_sha256 = await treeDigestOfFiles(tree);
		await evidence(h, sha, "2026-10-06T12:00:00.000Z", {
			merge_artifact_scan: completeMergeArtifactScan({ candidate_sha: sha, tree_sha256, paths: artifacts }),
			unresolved_merge_artifacts: artifacts,
		});
		const verdict = await call(h, "POST", `/tasks/${h.taskId}/verdict`, {
			token: TOKENS.control,
			body: {
				candidates: [{ contender_id: h.contenderId, candidate_sha: sha, blast_radius: 1, change_surface: 1 }],
				destination_repo: "canonical",
			},
		});
		assert.equal(verdict.status, 200, JSON.stringify(verdict.body));
		assert.equal(verdict.body.verdict.state, "REJECT");
		assert.match(verdict.body.verdict.reasons.join("\n"), /no_unresolved_merge_artifacts/);
		assert.equal(verdict.body.permit, null);
		const state = await authorityState(h);
		assert.equal(state.composition, undefined);
		assert.deepEqual(Object.keys(state.permits), []);
		assert.equal(await (await h.fake.get("canonical")).getHead(), h.baseline);
		assert.equal(h.containerCalls.length, 0, "promotion was not started");
	});

	it("I: a false COMPLETE scan with no paths is trusted by the authority; the container still does not fast-forward", async () => {
		// The harness evidence helper does not read blobs. It states a
		// completed scan with paths: []. That is a lie about this tree.
		// The authority may permit it. The promotion container scans the
		// fetched blobs and is the check that catches the lie.
		const h = await makeHarness();
		const sha = await push(h, conflicted, h.baseline);
		await evidence(h, sha, "2026-10-06T12:00:00.000Z");
		const stored = (await authorityState(h)).evaluations[sha];
		assert.equal(stored.merge_artifact_scan?.status, "COMPLETE");
		assert.deepEqual(stored.merge_artifact_scan?.paths, []);
		assert.equal(stored.merge_artifact_scan?.candidate_sha, sha);
		const verdict = await call(h, "POST", `/tasks/${h.taskId}/verdict`, {
			token: TOKENS.control,
			body: {
				candidates: [{ contender_id: h.contenderId, candidate_sha: sha, blast_radius: 1, change_surface: 1 }],
				destination_repo: "canonical",
			},
		});
		assert.equal(verdict.status, 200, JSON.stringify(verdict.body));
		assert.equal(verdict.body.verdict.state, "ACCEPT", "the authority trusts the evaluation-zone statement");
		assert.ok(verdict.body.permit, "a permit can be issued from a completed empty scan");
		const permitId = verdict.body.permit.permit_id as string;
		const started = await call(h, "POST", `/tasks/${h.taskId}/promote`, { token: TOKENS.control, body: { permit_id: permitId } });
		assert.equal(started.status, 202, JSON.stringify(started.body));
		await h.workflow.drain();
		const done = await call(h, "GET", `/tasks/${h.taskId}/promotions/${permitId}`, { token: TOKENS.control });
		assert.equal(done.body.status, "complete", JSON.stringify(done.body));
		assert.equal(done.body.result.status, 409);
		assert.equal(done.body.result.body.outcome, "UNRESOLVED_CONFLICT");
		assert.equal(h.containerCalls.length, 1, "the promotion container scanned the blobs; the authority did not");
		assert.equal((await authorityState(h)).permits[permitId].consumed, false);
		assert.equal(await (await h.fake.get("canonical")).getHead(), h.baseline);
	});
});

const BOUND_SHA = "b".repeat(40);
const BOUND_TREE = "c".repeat(64);
const BOUND_BASE = "a".repeat(40);

function boundScan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		status: "COMPLETE",
		scanner: MERGE_ARTIFACT_SCANNER_V1,
		candidate_sha: BOUND_SHA,
		tree_sha256: BOUND_TREE,
		paths: [] as string[],
		...overrides,
	};
}

/** A bundle whose hash matches its body. `scan` of "OMIT" leaves the record off. */
async function scannedBundle(scan: unknown, legacy?: string[]): Promise<EvaluationBundle> {
	const rest: Record<string, unknown> = {
		candidate_sha: BOUND_SHA,
		tree_sha256: BOUND_TREE,
		contender_id: "contender-markers",
		task_hash: TASK_HASH,
		admission: {
			exact_baseline: true,
			scope_compliance: true,
			valid_tool_states: true,
			no_eval_tampering: true,
			provenance_complete: true,
		},
		hidden_oracle: { passed: true, total: 1, failed: [] as string[] },
		regressions: { passed: true, total: 1, failed: [] as string[] },
		static_analysis: { passed: true, findings: [] as string[] },
		semantic_checks: { passed: true, total: 1, failed: [] as string[] },
		security_policy: { passed: true, findings: [] as string[] },
		evaluated_at: "2026-10-06T12:00:00.000Z",
		tainted: false,
	};
	if (scan !== "OMIT") rest.merge_artifact_scan = scan;
	if (legacy !== undefined) rest.unresolved_merge_artifacts = legacy;
	return { ...rest, bundle_hash: await sha256Hex(canonicalJson(rest)) } as EvaluationBundle;
}

async function admitted(bundle: EvaluationBundle) {
	const c = ctx();
	const submitted = await submitEvaluation(authorityFor(BOUND_SHA, BOUND_BASE), bundle, { zone: "evaluation_domain" }, c);
	const seam = await runVerdictSeam(
		submitted.state,
		[{ contender_id: "contender-markers", candidate_sha: BOUND_SHA, blast_radius: 1, change_surface: 1 }],
		c,
	);
	return { c, state: seam.state, record: seam.record };
}

async function assertNoPermit(label: string, bundle: EvaluationBundle, gate: string): Promise<void> {
	const open = await eligibility(bundle, sha256Hex);
	assert.equal(open.eligible, false, label);
	assert.ok(open.failed.includes(gate), `${label}: ${open.failed.join(",")}`);
	const got = await admitted(bundle);
	assert.equal(got.record.state, "REJECT", label);
	assert.match(got.record.reasons.join("\n"), new RegExp(gate), label);
	assert.equal(got.record.winner_sha, null, label);
	assert.deepEqual(Object.keys(got.state.permits), [], label);
	await assert.rejects(issuePermit(got.state, BOUND_SHA, "acme/api", BOUND_BASE, got.c), /no ACCEPT verdict/);
	const forced: VerdictRecord = {
		state: "ACCEPT",
		candidate_shas: [BOUND_SHA],
		evidence_hashes: [bundle.bundle_hash],
		reasons: [`forged ACCEPT for ${label}`],
		policy_hash: "policyhash",
		selector_policy_version: "seam-policy/0.1.0",
		timestamp: "2026-10-06T12:00:00.000Z",
		winner_sha: BOUND_SHA,
	};
	const refused = await issuePermit(
		{ ...got.state, verdicts: [...got.state.verdicts, forced] },
		BOUND_SHA,
		"acme/api",
		BOUND_BASE,
		got.c,
	);
	assert.equal(refused.outcome, "UNRESOLVED_CONFLICT", label);
	assert.equal(refused.permit, null, label);
	assert.deepEqual(Object.keys(refused.state.permits), [], label);
	const promoted = await attemptPromotion(refused.state, "cd".repeat(32), BOUND_BASE, BOUND_TREE, got.c);
	assert.equal(promoted.outcome, "UNKNOWN_PERMIT", label);
	assert.equal(promoted.effects.some((effect) => effect.kind === "canonical_write"), false, label);
	assert.deepEqual(promoted.effects, [], label);
}

describe("merge-artifact scan completeness is an evaluation-integrity input", () => {
	it("A: a COMPLETE scan with no paths stays eligible and can be permitted", async () => {
		const bundle = await scannedBundle(boundScan());
		const open = await eligibility(bundle, sha256Hex);
		assert.deepEqual(open, { eligible: true, failed: [] });
		const got = await admitted(bundle);
		assert.equal(got.record.state, "ACCEPT");
		const issued = await issuePermit(got.state, BOUND_SHA, "acme/api", BOUND_BASE, got.c);
		assert.equal(issued.outcome, "ISSUED");
		assert.ok(issued.permit);
		const promoted = await attemptPromotion(issued.state, issued.permit!.permit_id, BOUND_BASE, BOUND_TREE, got.c);
		assert.equal(promoted.outcome, "PROMOTED");
		assert.equal(promoted.effects.some((effect) => effect.kind === "canonical_write"), true);
	});

	it("B: a COMPLETE scan that names a path is REJECT with no permit", async () => {
		const bundle = await scannedBundle(boundScan({ paths: ["src/shared.js"] }), ["src/shared.js"]);
		await assertNoPermit("paths", bundle, "no_unresolved_merge_artifacts");
		const open = await eligibility(bundle, sha256Hex);
		assert.equal(open.failed.includes("evaluation_integrity_valid"), false);
	});

	it("C: a bundle that omits the scan is ineligible and gets no permit", async () => {
		const bundle = await scannedBundle("OMIT");
		await assertNoPermit("omitted", bundle, "evaluation_integrity_valid");
		const got = await admitted(bundle);
		const permitId = "cd".repeat(32);
		const promoted = await attemptPromotion(
			{
				...got.state,
				permits: {
					[permitId]: {
						permit_id: permitId,
						task_hash: TASK_HASH,
						baseline_commit: BOUND_BASE,
						winner_candidate_sha: BOUND_SHA,
						contender_id: "contender-markers",
						winning_tree_sha256: BOUND_TREE,
						evaluation_bundle_hash: bundle.bundle_hash,
						selector_policy_hash: "policyhash",
						destination_repo: "acme/api",
						expected_destination_head: BOUND_BASE,
						nonce: "n",
						issued_at: "2026-10-06T12:00:00.000Z",
						consumed: false,
						consumed_at: null,
					},
				},
			},
			permitId,
			BOUND_BASE,
			BOUND_TREE,
			got.c,
		);
		assert.equal(promoted.outcome, "UNRESOLVED_CONFLICT");
		assert.deepEqual(promoted.effects, []);
		assert.equal(promoted.state.permits[permitId].consumed, false);
	});

	it("D: a scan whose status is not COMPLETE is ineligible and gets no permit", async () => {
		await assertNoPermit("status", await scannedBundle(boundScan({ status: "PARTIAL" })), "evaluation_integrity_valid");
	});

	it("E: an unsupported scanner version is ineligible and gets no permit", async () => {
		await assertNoPermit(
			"scanner",
			await scannedBundle(boundScan({ scanner: "madgrix-merge-artifact/v0" })),
			"evaluation_integrity_valid",
		);
	});

	it("F: a candidate_sha that is not the bundle candidate is ineligible and gets no permit", async () => {
		await assertNoPermit(
			"candidate",
			await scannedBundle(boundScan({ candidate_sha: "d".repeat(40) })),
			"evaluation_integrity_valid",
		);
	});

	it("G: a tree_sha256 that is not the evaluated tree is ineligible and gets no permit", async () => {
		await assertNoPermit(
			"tree",
			await scannedBundle(boundScan({ tree_sha256: "e".repeat(64) })),
			"evaluation_integrity_valid",
		);
	});

	it("H: paths that are not an array of non-empty strings are ineligible and get no permit", async () => {
		await assertNoPermit("paths-string", await scannedBundle(boundScan({ paths: "src/shared.js" })), "evaluation_integrity_valid");
		await assertNoPermit("paths-number", await scannedBundle(boundScan({ paths: [1] })), "evaluation_integrity_valid");
		await assertNoPermit("paths-empty", await scannedBundle(boundScan({ paths: [""] })), "evaluation_integrity_valid");
		await assertNoPermit("paths-null", await scannedBundle(null), "evaluation_integrity_valid");
	});

	it("a legacy path list that disagrees with the scan fails evaluation integrity", async () => {
		const bundle = await scannedBundle(boundScan(), ["src/shared.js"]);
		const open = await eligibility(bundle, sha256Hex);
		assert.equal(open.eligible, false);
		assert.ok(open.failed.includes("evaluation_integrity_valid"));
		assert.equal(mergeArtifactScanIssue(bundle), "legacy");
	});

	it("A on the worker: a clean tree with a COMPLETE empty scan can promote", async () => {
		const h = await makeHarness();
		const sha = await push(h, FIXED_TREE, h.baseline);
		await evidence(h, sha, "2026-10-06T12:00:00.000Z");
		const stored = (await authorityState(h)).evaluations[sha];
		assert.equal(stored.merge_artifact_scan?.status, "COMPLETE");
		assert.equal(stored.merge_artifact_scan?.scanner, MERGE_ARTIFACT_SCANNER_V1);
		assert.equal(stored.merge_artifact_scan?.candidate_sha, sha);
		assert.deepEqual(stored.merge_artifact_scan?.paths, []);
		const verdict = await call(h, "POST", `/tasks/${h.taskId}/verdict`, {
			token: TOKENS.control,
			body: {
				candidates: [{ contender_id: h.contenderId, candidate_sha: sha, blast_radius: 1, change_surface: 1 }],
				destination_repo: "canonical",
			},
		});
		assert.equal(verdict.status, 200, JSON.stringify(verdict.body));
		assert.equal(verdict.body.verdict.state, "ACCEPT");
		assert.ok(verdict.body.permit);
		const permitId = verdict.body.permit.permit_id as string;
		const started = await call(h, "POST", `/tasks/${h.taskId}/promote`, { token: TOKENS.control, body: { permit_id: permitId } });
		assert.equal(started.status, 202, JSON.stringify(started.body));
		await h.workflow.drain();
		const done = await call(h, "GET", `/tasks/${h.taskId}/promotions/${permitId}`, { token: TOKENS.control });
		assert.equal(done.body.status, "complete", JSON.stringify(done.body));
		assert.equal(done.body.result.status, 200, JSON.stringify(done.body.result));
		assert.equal(done.body.result.body.outcome, "PROMOTED");
		assert.equal((await authorityState(h)).permits[permitId].consumed, true);
		assert.equal(await (await h.fake.get("canonical")).getHead(), sha);
	});

	it("C on the worker: omitting the scan is ineligible and does not start promotion", async () => {
		const h = await makeHarness();
		const sha = await push(h, FIXED_TREE, h.baseline);
		await evidence(h, sha, "2026-10-06T12:00:00.000Z", { merge_artifact_scan: undefined });
		const stored = (await authorityState(h)).evaluations[sha];
		assert.equal(stored.merge_artifact_scan, undefined);
		const verdict = await call(h, "POST", `/tasks/${h.taskId}/verdict`, {
			token: TOKENS.control,
			body: {
				candidates: [{ contender_id: h.contenderId, candidate_sha: sha, blast_radius: 1, change_surface: 1 }],
				destination_repo: "canonical",
			},
		});
		assert.equal(verdict.status, 200, JSON.stringify(verdict.body));
		assert.equal(verdict.body.verdict.state, "REJECT");
		assert.match(verdict.body.verdict.reasons.join("\n"), /evaluation_integrity_valid/);
		assert.equal(verdict.body.permit, null);
		assert.deepEqual(Object.keys((await authorityState(h)).permits), []);
		assert.equal(h.containerCalls.length, 0);
		assert.equal(await (await h.fake.get("canonical")).getHead(), h.baseline);
	});
});

describe("promotion container", () => {
	it("refuses a matching tree digest before fast-forward and does not report an already-written conflict as shipped", async () => {
		const fake = new FakeArtifacts();
		await fake.create("canonical");
		await fake.create("fork");
		const baseTree = { "README.md": "base\n", "src/note.js": EQUALS_ONLY };
		const base = await fake.adminPush({ repo: "canonical", ref: "main", tree: baseTree, message: "base", parents: [] });
		await fake.adminPush({ repo: "fork", ref: "main", tree: baseTree, message: "base", parents: [] });
		const tree = { ...baseTree, "src/end-only.js": END_ONLY, "src/shared.js": MARKERS };
		const sha = await fake.adminPush({
			repo: "fork",
			ref: "main",
			tree,
			message: "markers",
			parents: [base],
		});
		const digest = await treeDigestOfFiles(tree);
		const refused = await fakePromote(fake, {
			source: "fork",
			destination: "canonical",
			candidate_sha: sha,
			expected_head: base,
			winning_tree_sha256: digest,
		});
		assert.equal(refused.status, 409);
		assert.equal(refused.body.outcome, "UNRESOLVED_CONFLICT");
		assert.equal(refused.run.exit, 48);
		assert.match(refused.run.stdout, /PATHS=src\/shared\.js/);
		assert.equal(await (await fake.get("canonical")).getHead("main"), base);

		await fake.adminPush({ repo: "canonical", ref: "main", tree, message: "markers", parents: [base] });
		const already = await fakePromote(fake, {
			source: "fork",
			destination: "canonical",
			candidate_sha: sha,
			expected_head: base,
			winning_tree_sha256: digest,
		});
		assert.equal(already.body.outcome, "UNRESOLVED_CONFLICT");
		assert.notEqual(already.body.outcome, "ALREADY_WRITTEN");
		assert.equal(await (await fake.get("canonical")).getHead("main"), sha);
	});
});
