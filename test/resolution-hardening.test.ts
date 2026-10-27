/**
 * Regression tests for the governed-resolution stress report
 * (/workspace/stress/REPORT.md, bugs 1–13, repros 01–14). Each describe names
 * the bug it pins. Local only: git, bash and, where present, bubblewrap.
 * node --test test/resolution-hardening.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { loadForkCrew, resolveComposition, runCrewOnFork, strayConflictMarkers, withRepoLock } from "../scripts/lib/fork-crew.mjs";
import { governCrewResult } from "../scripts/lib/governed-resolution.mjs";
import { bubblewrapAvailable } from "../scripts/lib/sandbox.mjs";
import { freezeWitnesses, loadWitnesses, witnessReport } from "../scripts/lib/witness.mjs";

const dirs: string[] = [];
after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});
function tmp(prefix: string) {
	const dir = mkdtempSync(path.join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}
const ENV = {
	...process.env,
	GIT_AUTHOR_NAME: "T",
	GIT_AUTHOR_EMAIL: "t@x.invalid",
	GIT_COMMITTER_NAME: "T",
	GIT_COMMITTER_EMAIL: "t@x.invalid",
};
for (const [k, v] of Object.entries(ENV)) if (k.startsWith("GIT_")) process.env[k] ??= v;
function git(repo: string, args: string[]) {
	const r = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: ENV, maxBuffer: 1 << 30 });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
	return r.stdout.trim();
}
function writeFiles(dir: string, files: Record<string, string>) {
	for (const [p, c] of Object.entries(files)) {
		mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
		writeFileSync(path.join(dir, p), c);
	}
}
function mkRepo(files: Record<string, string>, exec: string[] = []) {
	const repo = tmp("hard-repo-");
	git(repo, ["init", "--quiet", "--initial-branch=main"]);
	writeFiles(repo, files);
	for (const f of exec) chmodSync(path.join(repo, f), 0o755);
	git(repo, ["add", "-A"]);
	git(repo, ["commit", "--quiet", "--allow-empty", "-m", "baseline"]);
	return repo;
}
type Sub = { id: string; command: string; paths?: string[]; witness?: string };
function mkCrew(subs: Sub[]) {
	const dir = tmp("hard-crew-");
	const cfg = {
		parent: { id: "parent", role: "parent", intent: "host" },
		subs: subs.map((s) => {
			const entry: Record<string, unknown> = { id: s.id, role: s.id, intent: `intent of ${s.id}`, paths: s.paths ?? ["**/*", "*"], command: s.command };
			if (s.witness) {
				writeFiles(dir, { [`w/${s.id}.sh`]: s.witness });
				entry.witnesses = [{ id: "w", script: `w/${s.id}.sh` }];
			}
			return entry;
		}),
	};
	const file = path.join(dir, "crew.json");
	writeFileSync(file, JSON.stringify(cfg));
	return file;
}
const noGate = () => ({ final: "FINAL STUB", exit: 0 });
async function crewRun(repo: string, subs: Sub[]) {
	const cfg = mkCrew(subs);
	const crew = loadForkCrew(cfg);
	const run = await runCrewOnFork(repo, crew, undefined, noGate);
	return { cfg, crew, run };
}
/** Two agents rewriting a.js's only line: a CONFLICTED crew result with witnesses. */
async function abConflict(extra: Record<string, string> = {}) {
	const repo = mkRepo({ "a.js": "x = 0\n", "other.js": "o\n", ...extra });
	const { cfg, crew, run } = await crewRun(repo, [
		{ id: "s1", command: `printf "x = 'A'\\n" > a.js`, witness: "grep -q A a.js" },
		{ id: "s2", command: `printf "x = 'B'\\n" > a.js`, witness: "grep -q B a.js" },
	]);
	assert.equal(run.status, "CONFLICTED");
	const witnesses = loadWitnesses(cfg, crew);
	assert.ok(witnesses);
	const frozen = freezeWitnesses(repo, run.baseline, run.commits, witnesses);
	return { repo, run, witnesses, frozen };
}
const GOOD = `printf "x = 'AB'\\n" > a.js`;
const LAZY = `printf "x = 'A'\\n" > a.js`;
function withSandbox<T>(mode: string, fn: () => T): T {
	const saved = process.env.MADGRIX_RESOLVER_SANDBOX;
	process.env.MADGRIX_RESOLVER_SANDBOX = mode;
	process.env.MADGRIX_I_ACCEPT_UNSANDBOXED_RESOLVER = "1";
	try {
		return fn();
	} finally {
		delete process.env.MADGRIX_I_ACCEPT_UNSANDBOXED_RESOLVER;
		if (saved === undefined) delete process.env.MADGRIX_RESOLVER_SANDBOX;
		else process.env.MADGRIX_RESOLVER_SANDBOX = saved;
	}
}
const MODES = bubblewrapAvailable() ? ["bwrap", "none"] : ["none"];

describe("bug 1: the resolver never runs in the authority repo, and control-plane git runs no hooks (repro 01, 06)", () => {
	for (const mode of MODES) {
		it(`[${mode}] a resolver that plants .git/hooks/post-checkout is refused, and the hook never runs`, async () => {
			const { repo, run } = await abConflict();
			const marker = path.join(tmp("hard-mark-"), "hook-ran");
			const hook = `#!/bin/sh\\necho ran >> ${marker}\\nprintf "x = 'AB'\\\\n" > a.js\\n`;
			assert.throws(
				() => withSandbox(mode, () => resolveComposition(repo, run, `${LAZY}; mkdir -p .git/hooks && printf '${hook}' > .git/hooks/post-checkout && chmod +x .git/hooks/post-checkout`)),
				/outside its lease/,
			);
			assert.equal(existsSync(marker), false);
			assert.equal(existsSync(path.join(repo, ".git/hooks/post-checkout")), false);
		});
	}

	it("a hook and fsmonitor planted in the repo's own .git do not run in composition or the witness gate", async () => {
		const { repo, run, witnesses, frozen } = await abConflict();
		const marker = path.join(tmp("hard-mark-"), "ran");
		writeFileSync(path.join(repo, ".git/hooks/post-checkout"), `#!/bin/sh\necho hook >> ${marker}\n[ -f a.js ] && printf "x = 'AB'\\n" > a.js\nexit 0\n`);
		chmodSync(path.join(repo, ".git/hooks/post-checkout"), 0o755);
		git(repo, ["config", "core.fsmonitor", `echo fsm >> ${marker}; false`]);
		const resolved = resolveComposition(repo, run, LAZY);
		const report = witnessReport(repo, resolved.sha, witnesses, frozen, { requiredSides: ["s1", "s2"] });
		assert.equal(report.verdict, "REFUSE", "the witness sees the lazy text, not hook-rewritten text");
		assert.equal(existsSync(marker), false, "neither the hook nor fsmonitor ran");
	});

	it("a resolver that edits the authority repository by absolute path is refused (no bubblewrap)", async () => {
		const { repo, run } = await abConflict();
		assert.throws(
			() => withSandbox("none", () => resolveComposition(repo, run, `${GOOD}; git -C ${JSON.stringify(repo)} config core.fsmonitor evil`)),
			/modified the authority repository/,
		);
	});
});

describe("bug 2: non-ASCII and quoted paths are parsed NUL-separated (repro 08)", () => {
	it("a conflict on é.txt is CONFLICTED on that path, and disjoint unicode / quote paths compose", async () => {
		const repo = mkRepo({ "é.txt": "0\n", 'q"uote.txt': "q\n", "src/🎉.js": "e\n", "z": "z\n" });
		const { run } = await crewRun(repo, [
			{ id: "s1", command: "printf 'A\\n' > é.txt" },
			{ id: "s2", command: "printf 'B\\n' > é.txt" },
		]);
		assert.equal(run.status, "CONFLICTED");
		assert.deepEqual(run.overlap, ["é.txt"]);

		const repo2 = mkRepo({ 'q"uote.txt': "q\n", "src/🎉.js": "e\n", "z": "z\n" });
		const { run: composed } = await crewRun(repo2, [
			{ id: "s1", command: "printf 'Q\\n' > 'q\"uote.txt'" },
			{ id: "s2", command: "printf 'E\\n' > src/🎉.js" },
		]);
		assert.equal(composed.status, "COMPOSED");
		assert.equal(git(repo2, ["show", `${composed.sha}:q"uote.txt`]), "Q");
		assert.equal(git(repo2, ["show", `${composed.sha}:src/🎉.js`]), "E");
		const names = git(repo2, ["ls-tree", "-r", "-z", "--name-only", composed.sha ?? ""]).split("\0").filter(Boolean).sort();
		assert.deepEqual(names, ['.madgrix/subagent-intents.json', 'q"uote.txt', "src/🎉.js", "z"], "no C-quoted junk file");
	});
});

describe("bug 3: the resolver cannot read the runner's environment through /proc (repro 02)", () => {
	it("with bubblewrap, /proc/$PPID/environ of the runner is out of reach", { skip: !bubblewrapAvailable() && "bubblewrap is not available" }, async () => {
		const { repo, run } = await abConflict();
		process.env.HARD_TEST_SECRET = "hard-test-secret-value";
		const out = tmp("hard-proc-");
		try {
			// The resolver records what it could read into the leased file's
			// neighbour... it cannot write outside its work dir, so it fails
			// closed when it finds the secret, and succeeds otherwise.
			const probe =
				`p=$PPID; for i in 1 2 3 4 5 6; do if tr '\\0' '\\n' < /proc/$p/environ 2>/dev/null | grep -q hard-test-secret-value; then exit 42; fi; ` +
				`p=$(awk '{print $4}' /proc/$p/stat 2>/dev/null) || break; [ -n "$p" ] && [ "$p" != 0 ] || break; done; ` +
				`if env | grep -q hard-test-secret-value; then exit 43; fi; ${GOOD}`;
			withSandbox("bwrap", () => resolveComposition(repo, run, probe));
		} finally {
			delete process.env.HARD_TEST_SECRET;
		}
		assert.ok(out);
	});
});

describe("bug 4: only regular files are accepted at leased paths (repro 03)", () => {
	for (const mode of MODES) {
		it(`[${mode}] a symlink at the leased path is refused`, async () => {
			const { repo, run } = await abConflict();
			assert.throws(() => withSandbox(mode, () => resolveComposition(repo, run, "rm a.js && ln -s /etc/hostname a.js")), /something other than a regular file/);
			assert.equal(git(repo, ["rev-parse", "HEAD"]), run.baseline);
		});
	}
});

describe("bug 5: nothing the resolver starts outlives it (repro 04)", () => {
	for (const mode of MODES) {
		it(`[${mode}] a setsid background process is killed when the resolver exits`, async () => {
			const { repo, run } = await abConflict();
			const marker = path.join(tmp("hard-daemon-"), "alive");
			// Under bubblewrap the marker dir is read-only; the daemon proves it
			// is alive by any write it can make, so check for its process too.
			resolveComposition(
				repo,
				run,
				`${GOOD}; (setsid bash -c 'sleep 1.5; echo alive > ${marker}; sleep 30' </dev/null >/dev/null 2>&1 &)`,
			);
			await new Promise((r) => setTimeout(r, 2500));
			assert.equal(existsSync(marker), false);
			const ps = spawnSync("pgrep", ["-f", `echo alive > ${marker}`], { encoding: "utf8" });
			assert.equal(ps.stdout.trim(), "", "no daemon left");
		});
	}
});

describe("bug 6: renames and deletions (repro 09)", () => {
	it("a rename composes as a move, not a copy, and a delete-only agent composes", async () => {
		const repo = mkRepo({ "a.js": "1\n2\n3\n", "f": "f\n", "z.js": "z\n" });
		const { run } = await crewRun(repo, [
			{ id: "s1", command: "git mv a.js b.js && rm f" },
			{ id: "s2", command: "printf 'Z\\n' > z.js" },
		]);
		assert.equal(run.status, "COMPOSED");
		const names = git(repo, ["ls-tree", "-r", "--name-only", run.sha ?? ""]).split("\n");
		assert.equal(names.includes("a.js"), false);
		assert.equal(names.includes("f"), false);
		assert.equal(git(repo, ["show", `${run.sha}:b.js`]), "1\n2\n3");
	});

	it("rename source outside the agent's scope is refused", async () => {
		const repo = mkRepo({ "a/x.js": "x\n", "b/keep": "k\n" });
		const cfg = mkCrew([
			{ id: "s1", command: "mkdir -p b && git mv a/x.js b/x.js", paths: ["b/**"] },
			{ id: "s2", command: "printf 'K\\n' > b/keep", paths: ["b/**"] },
		]);
		await assert.rejects(runCrewOnFork(repo, loadForkCrew(cfg), undefined, noGate), /changed a\/x\.js, which is outside its role scope/);
	});

	it("rename by one agent plus edit by another is a conflict, not a silent copy", async () => {
		const repo = mkRepo({ "a.js": "1\n2\n3\n4\n5\n6\n7\n8\n" });
		const { run } = await crewRun(repo, [
			{ id: "s1", command: "git mv a.js b.js" },
			{ id: "s2", command: "printf '1\\n2\\n3\\n4\\n5\\n6\\n7\\nEIGHT\\n' > a.js" },
		]);
		assert.equal(run.status, "CONFLICTED");
		assert.deepEqual(run.overlap, ["a.js"]);
	});

	it("a crew re-run with the same agent ids on the same repo does not trip over leftover branches (repro 14)", async () => {
		const repo = mkRepo({ "a.js": "x\n", "b.js": "y\n" });
		const subs = [
			{ id: "s1", command: "printf 'X\\n' > a.js" },
			{ id: "s2", command: "printf 'Y\\n' > b.js" },
		];
		const first = await crewRun(repo, subs);
		const second = await crewRun(repo, subs.map((sub) => ({ ...sub, command: sub.command.replace("\\n", "2\\n") })));
		assert.equal(first.run.status, "COMPOSED");
		assert.equal(second.run.status, "COMPOSED");
	});
});

describe("bug 7: timeout, output size, exec bit, leased-path list (repro 05, 10, 11, 12)", () => {
	it("a hanging resolver is killed at its timeout", async () => {
		const { repo, run } = await abConflict();
		const t0 = Date.now();
		assert.throws(() => resolveComposition(repo, run, "while :; do :; done", { timeoutMs: 800 }), /resolver timed out/);
		assert.ok(Date.now() - t0 < 15_000);
		assert.equal(git(repo, ["rev-parse", "HEAD"]), run.baseline);
	});

	it("a resolver that writes megabytes to stdout is not refused for it", async () => {
		const { repo, run } = await abConflict();
		const resolved = resolveComposition(repo, run, `${GOOD}; head -c 3000000 /dev/zero | tr '\\0' a`);
		assert.equal(git(repo, ["show", `${resolved.sha}:a.js`]), "x = 'AB'");
	});

	it("a shared file over 1 MiB composes", async () => {
		const big = Array.from({ length: 120_000 }, (_, i) => `line ${i}`).join("\n") + "\n";
		const repo = mkRepo({ "big.txt": big });
		const { run } = await crewRun(repo, [
			{ id: "s1", command: "sed -i 's/^line 10$/line 10 A/' big.txt" },
			{ id: "s2", command: "sed -i 's/^line 110000$/line 110000 B/' big.txt" },
		]);
		assert.equal(run.status, "COMPOSED");
		const out = git(repo, ["show", `${run.sha}:big.txt`]);
		assert.ok(out.includes("line 10 A\n") && out.includes("line 110000 B\n"));
	});

	it("a mode change on one side and a content edit on the other keep both", async () => {
		const repo = mkRepo({ "run.sh": "echo 1\necho 2\necho 3\necho 4\n" });
		const { run } = await crewRun(repo, [
			{ id: "s1", command: "chmod +x run.sh" },
			{ id: "s2", command: "printf 'echo 1\\necho 2\\necho 3\\necho FOUR\\n' > run.sh" },
		]);
		assert.equal(run.status, "COMPOSED");
		assert.match(git(repo, ["ls-tree", run.sha ?? "", "run.sh"]), /^100755 /);
		assert.ok(git(repo, ["show", `${run.sha}:run.sh`]).endsWith("echo FOUR"));
	});

	it("a leased executable keeps its exec bit, and a resolver may not change it", async () => {
		const repo = mkRepo({ "t.sh": "x = 0\n" }, ["t.sh"]);
		const { run } = await crewRun(repo, [
			{ id: "s1", command: `printf "x = 'A'\\n" > t.sh` },
			{ id: "s2", command: `printf "x = 'B'\\n" > t.sh` },
		]);
		const resolved = resolveComposition(repo, run, `printf "x = 'AB'\\n" > t.sh`);
		assert.match(git(repo, ["ls-tree", resolved.sha, "t.sh"]), /^100755 /);
		assert.throws(() => resolveComposition(repo, run, `printf "x = 'AB'\\n" > t.sh; chmod -x t.sh`), /changed the mode of t\.sh/);
	});

	it("the leased paths arrive in a file, whatever their size", async () => {
		const files: Record<string, string> = {};
		for (let i = 0; i < 200; i += 1) files[`d/${"p".repeat(180)}-${i}.txt`] = "0\n";
		const repo = mkRepo(files);
		const { run } = await crewRun(repo, [
			{ id: "s1", command: "for f in d/*; do echo A > \"$f\"; done" },
			{ id: "s2", command: "for f in d/*; do echo B > \"$f\"; done" },
		]);
		assert.equal(run.status, "CONFLICTED");
		const resolved = resolveComposition(
			repo,
			run,
			`node -e 'const fs=require("fs");for(const f of JSON.parse(fs.readFileSync(process.env.MADGRIX_LEASED_PATHS_FILE,"utf8")))fs.writeFileSync(f,"A B\\n")' && [ -z "$MADGRIX_LEASED_PATHS" ]`,
		);
		assert.equal(resolved.lease.paths.length, 200);
	});
});

describe("bug 8: conflict-marker check (lone =======, legit markers)", () => {
	it("flags marker lines the sides did not have, and keeps ones they did", () => {
		assert.deepEqual(strayConflictMarkers("x = 'AB'\n=======\n", ["x = 0\n", "x = 'A'\n"]), ["======="]);
		assert.deepEqual(strayConflictMarkers("a\n||||||| base\nb\n", ["a\n"]), ["||||||| base"]);
		assert.deepEqual(strayConflictMarkers("doc\n<<<<<<< HEAD\nmore\n", ["doc\n<<<<<<< HEAD\n", "x"]), []);
		assert.deepEqual(strayConflictMarkers("a ======= b\n", []), []);
	});

	it("a resolver that leaves a lone ======= line is refused", async () => {
		const { repo, run } = await abConflict();
		assert.throws(() => resolveComposition(repo, run, `printf "x = 'AB'\\n=======\\n" > a.js`), /conflict markers/);
	});
});

describe("repro 14: control-plane lock", () => {
	it("is re-entrant in one process and takes over a lock whose owner is gone", () => {
		const repo = mkRepo({ "a": "a\n" });
		const lock = path.join(repo, ".git", "madgrix-control.lock");
		mkdirSync(lock);
		writeFileSync(path.join(lock, "pid"), "999999999");
		const value = withRepoLock(repo, () => withRepoLock(repo, () => (existsSync(lock) ? readFileSync(path.join(lock, "pid"), "utf8") : "")));
		assert.equal(value, String(process.pid));
		assert.equal(existsSync(lock), false);
	});

	it("governed resolution end to end still ADMITs a good resolver and refuses a lazy one", async () => {
		for (const [command, want] of [[GOOD, "RESOLVED"], [LAZY, "REVIEW"]] as const) {
			const { repo, run, witnesses, frozen } = await abConflict();
			const g = await governCrewResult(repo, run, { taskHash: "t".repeat(64), contenderId: "c1", witnesses, frozen, mode: "command", command });
			assert.equal(g.status, want);
		}
	});
});
