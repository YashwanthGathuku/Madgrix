/**
 * Resolution hardening, round 3: mandatory sandbox, replayer nondeterminism
 * repro, admission proof, CAS on main, run-ref cleanup, malicious sub-agent
 * config. Local only (git, bash, bubblewrap).
 * node --test test/resolution-hardening-v3.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import { MainMovedError, deleteRunRefs, loadForkCrew, pruneRunRefs, resolveComposition, runCrewOnFork } from "../scripts/lib/fork-crew.mjs";
import { governCrewResult } from "../scripts/lib/governed-resolution.mjs";
import { resolveWithLadder } from "../scripts/lib/resolve-ladder.mjs";
import { bubblewrapAvailable, setBubblewrapAvailableForTest } from "../scripts/lib/sandbox.mjs";
import { freezeWitnesses, loadWitnesses } from "../scripts/lib/witness.mjs";
import { sha256Hex } from "../src/lib/canonical.ts";
import { generateKeyPairSync } from "node:crypto";
import { witnessSignerFromKey } from "../scripts/lib/admission.mjs";
const createEd25519Signer = () => witnessSignerFromKey(generateKeyPairSync("ed25519").privateKey);
import { createAuthority, recordComposition, type Ctx } from "../src/lib/task-state.ts";
import type { AuthorityState, CompositionRecord } from "../src/lib/types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const dirs: string[] = [];
after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
function tmp(prefix: string) {
	const dir = mkdtempSync(path.join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}
const ENV = { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@x.invalid", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@x.invalid" };
for (const [k, v] of Object.entries(ENV)) if (k.startsWith("GIT_")) process.env[k] ??= v;
function git(repo: string, args: string[], allowFail = false) {
	const r = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: ENV });
	if (r.status !== 0 && !allowFail) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
	return (r.stdout ?? "").trim();
}
function mkRepo(files: Record<string, string>) {
	const repo = tmp("v3-repo-");
	git(repo, ["init", "--quiet", "--initial-branch=main"]);
	for (const [p, c] of Object.entries(files)) {
		mkdirSync(path.dirname(path.join(repo, p)), { recursive: true });
		writeFileSync(path.join(repo, p), c);
	}
	git(repo, ["add", "-A"]);
	git(repo, ["commit", "--quiet", "-m", "baseline"]);
	return repo;
}
type Sub = { id: string; command: string; witness?: string };
function mkCrew(subs: Sub[]) {
	const dir = tmp("v3-crew-");
	const cfg = {
		parent: { id: "parent", role: "parent", intent: "host" },
		subs: subs.map((s) => {
			const entry: Record<string, unknown> = { id: s.id, role: s.id, intent: `intent of ${s.id}`, paths: ["**/*", "*"], command: s.command };
			if (s.witness) {
				mkdirSync(path.join(dir, "w"), { recursive: true });
				writeFileSync(path.join(dir, `w/${s.id}.sh`), s.witness);
				entry.witnesses = [{ id: "w", script: `w/${s.id}.sh` }];
			}
			return entry;
		}),
	};
	writeFileSync(path.join(dir, "crew.json"), JSON.stringify(cfg));
	return path.join(dir, "crew.json");
}
const noGate = () => ({ final: "FINAL STUB", exit: 0 });
const AB = (tag = "") => [
	{ id: `s1${tag}`, command: `printf "x = 'A${tag}'\\n" > a.js`, witness: `grep -q "A${tag}" a.js` },
	{ id: `s2${tag}`, command: `printf "x = 'B${tag}'\\n" > a.js`, witness: `grep -q "B${tag}" a.js` },
];
async function conflict(repo: string, subs: Sub[] = AB()) {
	const cfg = mkCrew(subs);
	const crew = loadForkCrew(cfg);
	const run = await runCrewOnFork(repo, crew, undefined, noGate);
	const witnesses = loadWitnesses(cfg, crew);
	assert.ok(witnesses);
	const frozen = freezeWitnesses(repo, run.baseline, run.commits, witnesses);
	return { run, witnesses, frozen };
}
const GOOD = `printf "x = 'AB'\\n" > a.js`;
const TASK = "t".repeat(64);
const govern = (repo: string, c: Awaited<ReturnType<typeof conflict>>, extra: Record<string, unknown> = {}) =>
	governCrewResult(repo, c.run, { taskHash: TASK, contenderId: "c1", witnesses: c.witnesses, frozen: c.frozen, mode: "command", command: GOOD, ...extra });

describe("item 1: the resolver sandbox is mandatory", () => {
	it("refuses (REVIEW) when bubblewrap is unavailable", async () => {
		const repo = mkRepo({ "a.js": "x = 0\n" });
		const c = await conflict(repo);
		setBubblewrapAvailableForTest(false);
		try {
			assert.throws(() => resolveComposition(repo, c.run, GOOD), /bubblewrap \(bwrap\) cannot create a sandbox/);
			const g = await govern(repo, c);
			assert.equal(g.status, "REVIEW");
			assert.match(g.review?.attempts[0]?.error ?? "", /refusing to run the resolver unsandboxed/);
			assert.equal(git(repo, ["rev-parse", "main"]), c.run.baseline);
		} finally {
			setBubblewrapAvailableForTest(null);
		}
	});

	it("'none' needs the explicit opt-in, warns loudly, and other values are refused", async () => {
		const repo = mkRepo({ "a.js": "x = 0\n" });
		const c = await conflict(repo);
		const saved = { ...process.env };
		try {
			process.env.MADGRIX_RESOLVER_SANDBOX = "none";
			delete process.env.MADGRIX_I_ACCEPT_UNSANDBOXED_RESOLVER;
			assert.throws(() => resolveComposition(repo, c.run, GOOD), /also needs MADGRIX_I_ACCEPT_UNSANDBOXED_RESOLVER=1/);
			process.env.MADGRIX_RESOLVER_SANDBOX = "auto";
			assert.throws(() => resolveComposition(repo, c.run, GOOD), /must be bwrap or none/);
		} finally {
			process.env.MADGRIX_RESOLVER_SANDBOX = saved.MADGRIX_RESOLVER_SANDBOX;
			if (saved.MADGRIX_RESOLVER_SANDBOX === undefined) delete process.env.MADGRIX_RESOLVER_SANDBOX;
		}
		const sandbox = path.join(here, "../scripts/lib/sandbox.mjs");
		const r = spawnSync(process.execPath, ["--input-type=module", "-e", `import { sandboxMode } from ${JSON.stringify(sandbox)}; console.log(sandboxMode());`], {
			encoding: "utf8",
			env: { PATH: process.env.PATH, MADGRIX_RESOLVER_SANDBOX: "none", MADGRIX_I_ACCEPT_UNSANDBOXED_RESOLVER: "1" },
		});
		assert.equal(r.stdout.trim(), "none");
		assert.match(r.stderr, /WARNING: MADGRIX_RESOLVER_SANDBOX=none/);
	});

	it("defaults to bubblewrap", { skip: !bubblewrapAvailable() && "bubblewrap is not available" }, async () => {
		const repo = mkRepo({ "a.js": "x = 0\n" });
		const c = await conflict(repo);
		// /proc/1 inside a fresh PID namespace is the sandbox's own init, not this host's init.
		const resolved = resolveComposition(repo, c.run, `[ "$(cat /proc/1/comm)" = bwrap ] || exit 9; ${GOOD}`);
		assert.match(resolved.sha, /^[0-9a-f]{40}$/);
	});
});

describe("item 2: the 1-in-N admitted random replayer is the union, witness-checked (deterministic repro)", () => {
	const replayer = (body: string) => {
		const file = path.join(tmp("v3-rep-"), "r.mjs");
		writeFileSync(file, `let s="";for await (const c of process.stdin) s+=c; const q=JSON.parse(s); ${body}`);
		return `node ${file}`;
	};
	it("both orders draw the union: ADMIT, labelled behavioral, both sides PRESERVED, text has both intents", async () => {
		const repo = mkRepo({ "a.js": "x = 0\n" });
		const c = await conflict(repo);
		const r = resolveWithLadder(repo, c.run, { witnesses: c.witnesses, frozen: c.frozen, mergiraf: null, replayer: replayer(`process.stdout.write(q.target.text + q.source.text);`) });
		assert.equal(r.status, "RESOLVED");
		if (r.status !== "RESOLVED") return;
		assert.equal(r.order_agreement, "behavioral");
		assert.deepEqual(r.witness.report.sides.map((s: { status: string }) => s.status), ["PRESERVED", "PRESERVED"]);
		assert.equal(git(repo, ["show", `${r.sha}:a.js`]), "x = 'A'\nx = 'B'");
	});
	it("one order draws the lazy text: REVIEW (order-dependent), nothing published", async () => {
		const repo = mkRepo({ "a.js": "x = 0\n" });
		const c = await conflict(repo);
		const r = resolveWithLadder(repo, c.run, {
			witnesses: c.witnesses,
			frozen: c.frozen,
			mergiraf: null,
			replayer: replayer(`process.stdout.write(q.order === "AB" ? q.target.text + q.source.text : q.target.text);`),
		});
		assert.equal(r.status, "REVIEW");
		assert.equal(git(repo, ["rev-parse", "main"]), c.run.baseline);
	});
});

function authority(baseline: string): AuthorityState {
	const state = createAuthority({ task_id: "t", task_hash: TASK, intent: "i", baseline_repo: "r", baseline_commit: baseline, behavior_contract: "b", policy_version: "seam-policy/0.1.0", frozen_at: "2026-10-20T00:00:00Z" });
	state.contenders.c1 = { contender_id: "c1", agent_id: "parent", fork_repo: "f", fork_lineage: { parent_repo: "r", parent_commit: baseline }, fork_base: baseline, token_id: "tok", status: "forked", claim_work_id: null, latest_commit: null };
	return state;
}
function ctxWith(key: string | null, insecure = false): Ctx {
	return { now: () => "2026-10-20T00:00:00.000Z", randomHex: (n) => "e".repeat(n * 2), sha256Hex, selectorPolicyHash: "p", policyVersion: "seam-policy/0.1.0", witnessRunnerPublicKey: key, insecureUnpinnedWitnessRunner: insecure };
}
async function recordAll(state: AuthorityState, records: CompositionRecord[], ctx: Ctx) {
	for (const r of records) state = await recordComposition(state, r, ctx);
	return state;
}

describe("item 3: admission proof binds the witness verdict and the candidate commit", () => {
	it("a signed, real candidate is accepted; forged digest, made-up SHA, missing proof and another key are refused", async () => {
		const repo = mkRepo({ "a.js": "x = 0\n" });
		const c = await conflict(repo);
		const runner = await createEd25519Signer();
		const g = await govern(repo, c, { witnessSigner: runner });
		assert.equal(g.status, "RESOLVED");
		const [conflicted, resolved] = g.compositions as CompositionRecord[];
		assert.ok(resolved.admission_proof?.attestation);
		const ctx = ctxWith(runner.publicKeySpkiHex);
		const ok = await recordAll(authority(c.run.baseline), [conflicted, resolved], ctx);
		assert.equal(ok.composition?.status, "RESOLVED");
		assert.ok(ok.composition?.admission_proof?.attestation, "the verified proof is stored (round 4)");

		const base = await recordComposition(authority(c.run.baseline), conflicted, ctx);
		const forged = structuredClone(resolved);
		forged.resolution!.witness.witness_report_sha256 = "f".repeat(64);
		await assert.rejects(recordComposition(base, forged, ctx), /attestation does not verify/);
		const madeUp = structuredClone(resolved);
		madeUp.candidate_sha = "7".repeat(40);
		await assert.rejects(recordComposition(base, madeUp, ctx), /commit object is not the candidate SHA/);
		const bare = structuredClone(resolved);
		delete bare.admission_proof;
		await assert.rejects(recordComposition(base, bare, ctx), /requires an admission_proof/);
		const noAtt = structuredClone(resolved);
		delete (noAtt.admission_proof as { attestation?: unknown }).attestation;
		await assert.rejects(recordComposition(base, noAtt, ctx), /carries no witness runner attestation/);
		const other = await createEd25519Signer();
		await assert.rejects(recordComposition(await recordComposition(authority(c.run.baseline), conflicted, ctxWith(other.publicKeySpkiHex)), resolved, ctxWith(other.publicKeySpkiHex)), /does not verify|not pinned/);
		// A real commit that is not this composition (the baseline's own commit object) fails on parents.
		const wrong = structuredClone(resolved);
		wrong.candidate_sha = c.run.commits[0].sha;
		wrong.admission_proof!.commit_object = Buffer.from(git(repo, ["cat-file", "commit", c.run.commits[0].sha]) + "\n").toString("base64");
		await assert.rejects(recordComposition(base, wrong, ctx), /must be new|parents/);
	});

	it("without a pinned key the authority refuses (round 4); only the insecure dev opt-in accepts", async () => {
		const repo = mkRepo({ "a.js": "x = 0\n" });
		const c = await conflict(repo);
		const g = await govern(repo, c);
		const [conflicted, resolved] = g.compositions as CompositionRecord[];
		const madeUp = { ...structuredClone(resolved), candidate_sha: "7".repeat(40) };
		await assert.rejects(recordAll(authority(c.run.baseline), [conflicted, madeUp], ctxWith(null)), /no witness runner key is pinned/);
		const state = await recordAll(authority(c.run.baseline), [conflicted, madeUp], ctxWith(null, true));
		assert.equal(state.composition?.status, "RESOLVED");
	});

	it("a COMPOSED candidate also needs its commit object under a pinned key", async () => {
		const repo = mkRepo({ "a.js": "a\n", "b.js": "b\n" });
		const cfg = mkCrew([
			{ id: "s1", command: "echo A > a.js" },
			{ id: "s2", command: "echo B > b.js" },
		]);
		const run = await runCrewOnFork(repo, loadForkCrew(cfg), undefined, noGate);
		const runner = await createEd25519Signer();
		const g = await governCrewResult(repo, run, { taskHash: TASK, contenderId: "c1", witnesses: null, frozen: null, mode: "command", witnessSigner: runner });
		const ctx = ctxWith(runner.publicKeySpkiHex);
		const [composed] = g.compositions as CompositionRecord[];
		assert.equal((await recordComposition(authority(run.baseline), composed, ctx)).composition?.status, "COMPOSED");
		await assert.rejects(recordComposition(authority(run.baseline), { ...composed, admission_proof: null }, ctx), /requires an admission_proof/);
	});
});

describe("item 4: main moves only by compare-and-swap", () => {
	it("two resolutions from one baseline: the first publishes, the second is refused and main keeps the first", async () => {
		const repo = mkRepo({ "a.js": "x = 0\n" });
		const first = await conflict(repo);
		const second = await conflict(repo, AB("2"));
		const g1 = await govern(repo, first);
		assert.equal(g1.status, "RESOLVED");
		const g2 = await govern(repo, second, { command: `printf "x = 'A2B2'\\n" > a.js` });
		assert.equal(g2.status, "REVIEW");
		assert.match(g2.review?.reason ?? "", /main moved: expected/);
		assert.equal(git(repo, ["rev-parse", "main"]), g1.candidateSha);
	});

	it("two concurrent COMPOSED crews with rebase-retry off: exactly one publishes, the other fails with MainMovedError", async () => {
		process.env.MADGRIX_MAIN_REBASE_RETRIES = "0";
		after(() => delete process.env.MADGRIX_MAIN_REBASE_RETRIES);
		const repo = mkRepo({ "a.js": "a\n", "b.js": "b\n", "c.js": "c\n", "d.js": "d\n" });
		const crewOf = (x: string, y: string) => loadForkCrew(mkCrew([{ id: `p${x}`, command: `sleep 0.2; echo ${x}${x} > ${x}.js` }, { id: `q${y}`, command: `echo ${y}${y} > ${y}.js` }]));
		const results = await Promise.allSettled([runCrewOnFork(repo, crewOf("a", "b"), undefined, noGate), runCrewOnFork(repo, crewOf("c", "d"), undefined, noGate)]);
		const ok = results.filter((r) => r.status === "fulfilled");
		const bad = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
		assert.equal(ok.length, 1, results.map((r) => (r.status === "rejected" ? String(r.reason) : "ok")).join(" | "));
		assert.equal(bad.length, 1);
		assert.ok(bad[0].reason instanceof MainMovedError, String(bad[0].reason));
		assert.equal(git(repo, ["rev-parse", "main"]), (ok[0] as PromiseFulfilledResult<{ sha: string }>).value.sha);
		delete process.env.MADGRIX_MAIN_REBASE_RETRIES;
	});

	it("a crew refuses to start when HEAD is not main", async () => {
		const repo = mkRepo({ "a.js": "a\n" });
		git(repo, ["commit", "--quiet", "--allow-empty", "-m", "second"]);
		git(repo, ["checkout", "--quiet", "--detach", "HEAD~1"]);
		await assert.rejects(runCrewOnFork(repo, loadForkCrew(mkCrew([{ id: "s1", command: "echo 1 > a.js" }, { id: "s2", command: "echo 2 > b.js" }])), undefined, noGate), /is not main/);
	});
});

describe("item 5: run refs", () => {
	const runRefs = (repo: string) => git(repo, ["for-each-ref", "--format=%(refname)", "refs/madgrix/runs/"]);
	it("are deleted once the candidate is published, kept (and reported) when it is not, and prunable", async () => {
		const repo = mkRepo({ "a.js": "x = 0\n" });
		const g = await govern(repo, await conflict(repo));
		assert.equal(g.run_refs, "deleted");
		assert.equal(runRefs(repo), "");
		const lazy = await govern(repo, await conflict(repo, AB("3")), { command: `printf "x = 'A3'\\n" > a.js` });
		assert.equal(lazy.status, "REVIEW");
		assert.equal(lazy.run_refs, "kept");
		assert.ok(lazy.forensic_ref && runRefs(repo).startsWith(`${lazy.forensic_ref}/`));
		assert.deepEqual(pruneRunRefs(repo, { olderThanMs: 3_600_000 }), [], "a fresh run is younger than an hour");
		assert.equal(pruneRunRefs(repo).length, 2);
		assert.equal(runRefs(repo), "");
		assert.throws(() => deleteRunRefs(repo, "refs/heads/main"), /not a run ref/);
	});
});

describe("item 6: a malicious sub-agent cannot make control-plane git run its code", () => {
	const cases: Array<[string, (m: string) => string]> = [
		["clean filter + .gitattributes", (m) => `git config filter.evil.clean "sh -c 'echo ran >> ${m}; cat'" && echo '* filter=evil' > .gitattributes && echo A > a.js`],
		["hook in the common hooks dir", (m) => `h="$(git rev-parse --git-common-dir)/hooks/pre-commit"; printf '#!/bin/sh\\necho ran >> ${m}\\n' > "$h"; chmod +x "$h"; echo A > a.js`],
		["include.path", (m) => `printf '[core]\\n\\tfsmonitor = echo ran >> ${m}; false\\n' > ${m}.cfg && git config include.path ${m}.cfg && echo A > a.js`],
		["core.fsmonitor", (m) => `git config core.fsmonitor "echo ran >> ${m}; false" && echo A > a.js`],
		["per-worktree config", (m) => `git config extensions.worktreeConfig true && git config --worktree core.fsmonitor "echo ran >> ${m}; false" && echo A > a.js`],
		["info/attributes", (m) => `echo '* filter=evil' > "$(git rev-parse --git-common-dir)/info/attributes" && echo A > a.js`],
	];
	for (const [name, plant] of cases) {
		it(`${name}: the crew is refused, nothing ran, and the files are restored`, async () => {
			const repo = mkRepo({ "a.js": "a\n", "b.js": "b\n" });
			const configBefore = git(repo, ["config", "--local", "--list"]);
			const marker = path.join(tmp("v3-mark-"), "ran");
			const cfg = mkCrew([{ id: "s1", command: plant(marker) }, { id: "s2", command: "echo B > b.js" }]);
			await assert.rejects(runCrewOnFork(repo, loadForkCrew(cfg), undefined, noGate), /a sub-agent changed repository control files/);
			assert.equal(existsSync(marker), false, "the planted code never ran");
			assert.equal(git(repo, ["config", "--local", "--list"]), configBefore);
			assert.equal(existsSync(path.join(repo, ".git/hooks/pre-commit")), false);
			assert.equal(existsSync(path.join(repo, ".git/info/attributes")), false);
		});
	}

	it("a rewritten worktree .git pointer is ignored: the commit uses the real worktree git dir", async () => {
		const evil = mkRepo({ "z": "z\n" });
		const marker = path.join(tmp("v3-mark-"), "ran");
		git(evil, ["config", "core.fsmonitor", `echo ran >> ${marker}; false`]);
		git(evil, ["config", "filter.evil.clean", `sh -c 'echo ran >> ${marker}; cat'`]);
		const repo = mkRepo({ "a.js": "a\n", "b.js": "b\n" });
		const cfg = mkCrew([
			{ id: "s1", command: `echo '* filter=evil' > .gitattributes; echo A > a.js; echo "gitdir: ${evil}/.git" > .git` },
			{ id: "s2", command: "echo B > b.js" },
		]);
		const run = await runCrewOnFork(repo, loadForkCrew(cfg), undefined, noGate);
		assert.equal(run.status, "COMPOSED");
		assert.equal(existsSync(marker), false);
		assert.equal(git(evil, ["rev-list", "--count", "HEAD"]), "1", "nothing was committed into the other repo");
		assert.equal(git(repo, ["show", `${run.sha}:a.js`]), "A");
	});
});
