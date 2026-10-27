/**
 * Resolution lease (specs/amendments/resolution-lease-v1.md).
 * node --test test/resolve-lease.test.ts
 *
 * Before the lease, resolveComposition reset the checkout to the baseline and
 * trusted the resolver to rebuild the whole composition. It checked only the
 * conflicted files. A resolver could therefore drop every agent's clean work
 * (while the RESOLVED commit still named every agent commit as a parent),
 * rewrite files nobody had leased to it, and its inputs were committed into
 * the candidate tree. Each test here is one of those probes, run against the
 * real fork-crew code on a real git repository.
 *
 * TheUstad's frozen-baseline gate is stubbed: it is not under test here.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { RESOLUTION_LEASE_VERSION, loadForkCrew, resolveComposition, runCrewOnFork } from "../scripts/lib/fork-crew.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const demoConfig = path.join(root, "configs/demo-composition.json");
const demoResolver = path.join(root, "scripts/demo-resolve.mjs");
const dirs: string[] = [];
const stubGate = () => ({ final: "FINAL VERIFIED", exit: 0 });

function git(repo: string, args: string[]): string {
	const result = spawnSync("git", args, {
		cwd: repo,
		encoding: "utf8",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "Git4agents",
			GIT_AUTHOR_EMAIL: "git4agents@madgrix.invalid",
			GIT_COMMITTER_NAME: "Git4agents",
			GIT_COMMITTER_EMAIL: "git4agents@madgrix.invalid",
		},
	});
	assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
	return (result.stdout ?? "").trim();
}

function initFork(files: Record<string, string> = { "README.md": "baseline\n" }): string {
	const dir = mkdtempSync(path.join(tmpdir(), "madgrix-lease-"));
	dirs.push(dir);
	git(dir, ["init", "--quiet", "--initial-branch=main"]);
	for (const [name, body] of Object.entries(files)) {
		const full = path.join(dir, name);
		spawnSync("mkdir", ["-p", path.dirname(full)]);
		writeFileSync(full, body);
	}
	git(dir, ["add", "-A"]);
	git(dir, ["commit", "--quiet", "-m", "baseline"]);
	return dir;
}

function tree(repo: string, sha: string): string[] {
	return git(repo, ["ls-tree", "-r", "--name-only", sha]).split("\n").filter(Boolean);
}

/** The demo crew: sub-api and sub-ui overlap on src/contract.js; sub-test is disjoint. */
async function conflictedDemo() {
	const repo = initFork();
	const crew = loadForkCrew(demoConfig);
	const conflicted = await runCrewOnFork(repo, crew, undefined, stubGate);
	assert.equal(conflicted.status, "CONFLICTED");
	assert.deepEqual(conflicted.overlap, ["src/contract.js"]);
	return { repo, conflicted };
}

after(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("resolution lease", () => {
	it("the authority writes the clean work, so a resolver that writes only the leased path cannot drop it", async () => {
		const { repo, conflicted } = await conflictedDemo();
		// The pre-lease probe: this resolver used to produce a RESOLVED commit
		// holding src/contract.js and nothing else from the crew.
		const resolved = resolveComposition(
			repo,
			conflicted,
			"mkdir -p src && printf '%s\\n' 'export const label = \"ui\";' > src/contract.js",
		);
		assert.equal(resolved.status, "RESOLVED");
		const files = tree(repo, resolved.sha);
		for (const clean of ["src/api/handler.js", "src/ui/view.js", "test/integration/check.js"]) {
			assert.ok(files.includes(clean), `${clean} survives resolution`);
		}
		assert.match(git(repo, ["show", `${resolved.sha}:src/api/handler.js`]), /"api"/);
		assert.match(git(repo, ["show", `${resolved.sha}:src/ui/view.js`]), /"ui"/);
		assert.match(git(repo, ["show", `${resolved.sha}:test/integration/check.js`]), /api\+ui/);
		// Choosing one side inside the leased hunk is still accepted at this layer.
		// The lease bounds where a resolver writes, not whether both intents
		// survive; that check belongs to evaluation (witness gate, not yet built).
		assert.equal(git(repo, ["show", `${resolved.sha}:src/contract.js`]), 'export const label = "ui";');
	});

	it("refuses a resolver that deletes a clean file and returns the checkout to the baseline", async () => {
		const { repo, conflicted } = await conflictedDemo();
		// The resolver's directory holds only the leased files, so a clean
		// file is not there to delete: the rm fails and the resolver is refused.
		assert.throws(
			() =>
				resolveComposition(
					repo,
					conflicted,
					"rm src/api/handler.js && printf '%s\\n' 'export const label = \"api+ui\";' > src/contract.js",
				),
			/resolver exited 1: rm: cannot remove 'src\/api\/handler\.js'/,
		);
		assert.equal(git(repo, ["rev-parse", "HEAD"]), conflicted.baseline);
		assert.equal(git(repo, ["status", "--porcelain"]), "");
	});

	it("refuses a resolver that rewrites another agent's test or an unrelated file", async () => {
		const { repo, conflicted } = await conflictedDemo();
		assert.throws(
			() =>
				resolveComposition(
					repo,
					conflicted,
					"printf '%s\\n' 'export const label = \"api+ui\";' > src/contract.js && " +
						"mkdir -p test/integration && printf '%s\\n' 'export function check() { return true; }' > test/integration/check.js && " +
						"printf 'edited by resolver\\n' > README.md",
				),
			(error: Error) =>
				/outside its lease/.test(error.message) &&
				error.message.includes("README.md") &&
				error.message.includes("test/integration/check.js"),
		);
		assert.equal(git(repo, ["rev-parse", "HEAD"]), conflicted.baseline);
	});

	it("refuses a resolver that adds a file outside the lease", async () => {
		const { repo, conflicted } = await conflictedDemo();
		assert.throws(
			() =>
				resolveComposition(
					repo,
					conflicted,
					"printf '%s\\n' 'export const label = \"api+ui\";' > src/contract.js && printf 'x\\n' > src/backdoor.js",
				),
			/resolver changed src\/backdoor\.js, outside its lease/,
		);
	});

	it("keeps resolver inputs out of the repository and out of the candidate tree", async () => {
		const { repo, conflicted } = await conflictedDemo();
		const resolved = resolveComposition(
			repo,
			conflicted,
			// Reads both sides from the input directory the authority provides.
			'test -f "$MADGRIX_CONFLICT_PATH" && case "$MADGRIX_CONFLICT_PATH" in "$PWD"/*) exit 9;; esac && ' +
				'cat "$MADGRIX_SIDES_DIR/sub-api/src/contract.js" "$MADGRIX_SIDES_DIR/sub-ui/src/contract.js" > src/contract.js',
		);
		const body = git(repo, ["show", `${resolved.sha}:src/contract.js`]);
		assert.match(body, /"api"/);
		assert.match(body, /"ui"/);
		const files = tree(repo, resolved.sha);
		assert.equal(files.includes(".madgrix/conflict.json"), false);
		assert.equal(files.some((file) => file.startsWith(".madgrix/sides/")), false);
		assert.ok(files.includes(".madgrix/subagent-intents.json"));
	});

	it("deletes the resolver input directory once the resolver exits", async () => {
		const { repo, conflicted } = await conflictedDemo();
		const probe = path.join(mkdtempSync(path.join(tmpdir(), "madgrix-lease-probe-")), "inputs.txt");
		dirs.push(path.dirname(probe));
		// The probe writes outside the work directory, which bubblewrap makes
		// read-only; this test checks cleanup, so it runs without bubblewrap.
		const saved = process.env.MADGRIX_RESOLVER_SANDBOX;
		process.env.MADGRIX_RESOLVER_SANDBOX = "none";
		process.env.MADGRIX_I_ACCEPT_UNSANDBOXED_RESOLVER = "1";
		try {
			resolveComposition(
				repo,
				conflicted,
				`printf '%s\\n' 'export const label = "api+ui";' > src/contract.js && dirname "$MADGRIX_CONFLICT_PATH" > ${JSON.stringify(probe)}`,
			);
		} finally {
			delete process.env.MADGRIX_I_ACCEPT_UNSANDBOXED_RESOLVER;
		if (saved === undefined) delete process.env.MADGRIX_RESOLVER_SANDBOX;
			else process.env.MADGRIX_RESOLVER_SANDBOX = saved;
		}
		const inputDir = spawnSync("cat", [probe], { encoding: "utf8" }).stdout.trim();
		assert.ok(inputDir.length > 0);
		assert.equal(existsSync(inputDir), false);
	});

	it("records the lease, and the repo's own demo resolver still resolves the demo", async () => {
		const { repo, conflicted } = await conflictedDemo();
		const resolved = resolveComposition(repo, conflicted, `node ${JSON.stringify(demoResolver)}`);
		assert.equal(git(repo, ["show", `${resolved.sha}:src/contract.js`]), 'export const label = "api+ui";');
		const record = JSON.parse(git(repo, ["show", `${resolved.sha}:.madgrix/subagent-intents.json`]));
		assert.equal(record.lease.format, RESOLUTION_LEASE_VERSION);
		assert.deepEqual(record.lease.paths, ["src/contract.js"]);
		assert.match(record.lease.precomposed_tree, /^[0-9a-f]{40}$/);
		// The resolved tree differs from the pre-composed tree only on the leased
		// path and the authority's own records.
		const diff = git(repo, ["diff", "--name-only", record.lease.precomposed_tree, resolved.sha]).split("\n").filter(Boolean);
		assert.deepEqual(diff.filter((file) => !file.startsWith(".madgrix/")), ["src/contract.js"]);
	});

	it("keeps two agents' disjoint edits to one file while their other file is leased", async () => {
		const shared = ["one", "two", "three", "four", "five", "six", "seven"].join("\n") + "\n";
		const repo = initFork({ "README.md": "baseline\n", "src/shared.txt": shared });
		const crew = loadForkCrew(demoConfig);
		const api = crew.subs.find((sub: { id: string }) => sub.id === "sub-api");
		const ui = crew.subs.find((sub: { id: string }) => sub.id === "sub-ui");
		assert.ok(api && ui);
		api.paths = [...api.paths, "src/shared.txt"];
		ui.paths = [...ui.paths, "src/shared.txt"];
		api.command += " && sed -i 's/^one$/ONE-api/' src/shared.txt";
		ui.command += " && sed -i 's/^seven$/SEVEN-ui/' src/shared.txt";
		const conflicted = await runCrewOnFork(repo, crew, undefined, stubGate);
		assert.equal(conflicted.status, "CONFLICTED");
		assert.deepEqual(conflicted.overlap, ["src/contract.js"]);
		const resolved = resolveComposition(repo, conflicted, `node ${JSON.stringify(demoResolver)}`);
		const merged = git(repo, ["show", `${resolved.sha}:src/shared.txt`]);
		assert.match(merged, /^ONE-api$/m);
		assert.match(merged, /^SEVEN-ui$/m);
	});

	it("refuses a conflict record that would widen or shrink the lease", async () => {
		const { repo, conflicted } = await conflictedDemo();
		const widened = structuredClone(conflicted);
		widened.conflict.files.push({ ...widened.conflict.files[0], path: "README.md" });
		assert.throws(
			() => resolveComposition(repo, widened, "printf 'owned\\n' > README.md"),
			/conflict record names README\.md, src\/contract\.js, but the crew's commits conflict on src\/contract\.js/,
		);
		const shrunk = structuredClone(conflicted);
		shrunk.conflict.files = [];
		assert.throws(() => resolveComposition(repo, shrunk, "true"), /conflict record names no paths/);
	});
});
