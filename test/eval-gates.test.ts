/**
 * Pure evaluator rules (src/lib/eval-gates.ts): runner-configuration and
 * test-material classification, tamper and scope findings, the run-directory
 * tree, and the tool-status log check (specs/amendments/evidence-integrity-v1.md,
 * specs/amendments/tool-status-v1.md). The same rules run end to end in
 * test/evaluator-isolation.test.ts.
 *
 * node --test test/eval-gates.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	DEFAULT_TEST_GLOBS,
	TOOL_STATUS_FORMAT,
	TOOL_STATUS_LOG_PATH,
	changedPaths,
	checkToolStatusLog,
	composeRunTree,
	evaluatorGates,
	globToRegExp,
	isRunnerConfigPath,
	isSafeTreePath,
	isTestPath,
	scopeCompliant,
	tamperFindings,
	type ToolStatusCheck,
	type TreeEntry,
} from "../src/lib/eval-gates.ts";

const RUN = { task_id: "task_1", contender_id: "contender-1", agent_id: "agent-a", baseline_commit: "b".repeat(40) };

function blob(path: string, oid: string, mode = "100644"): TreeEntry {
	return { mode, type: "blob", oid, path };
}

function log(records: unknown[]): { text: string } {
	return { text: records.map((r) => JSON.stringify(r)).join("\n") + "\n" };
}

const SESSION = { format: TOOL_STATUS_FORMAT, ...RUN, model: "claude-test-1", harness: "test-harness/1.0" };
const ACTION = { seq: 1, action: "edit_file", tool_status: "OK" };

describe("runner configuration and test material", () => {
	it("the runner configuration the old regex missed is classified as runner configuration, at any depth", () => {
		for (const path of [
			"package.json",
			"packages/api/package.json",
			"conftest.py",
			"tests/unit/conftest.py",
			"jest.config.js",
			"jest.config.ts",
			"vitest.config.ts",
			"vitest.config.mjs",
			"pytest.ini",
			"Makefile",
			"tox.ini",
			"setup.cfg",
			".mocharc.yml",
			".mocharc.json",
			".mocharc.js",
		]) {
			assert.equal(isRunnerConfigPath(path), true, path);
		}
		for (const path of ["src/app.js", "README.md", "docs/package.json.md", "src/makefile.js", "jest.js"]) {
			assert.equal(isRunnerConfigPath(path), false, path);
		}
	});

	it("default test globs match test material, including __mocks__/, and not look-alike source", () => {
		for (const path of [
			"test/sum.test.js",
			"tests/test_api.py",
			"src/__tests__/a.js",
			"src/__mocks__/fs.js",
			"__mocks__/axios.js",
			"spec/models/user_spec.rb",
			"src/sum.test.ts",
			"src/sum.spec.tsx",
			"pkg/test_sum.py",
			"pkg/sum_test.py",
			"pkg/sum_test.go",
			"src/__snapshots__/a.snap",
			"pkg/testdata/input.txt",
		]) {
			assert.equal(isTestPath(path, DEFAULT_TEST_GLOBS), true, path);
		}
		for (const path of ["src/testing.js", "src/contest.js", "latest/x.js", "specs/README.md", "src/test", "attest/a.js"]) {
			assert.equal(isTestPath(path, DEFAULT_TEST_GLOBS), false, path);
		}
	});

	it("globToRegExp: ** spans whole segments, * and ? stay inside one, everything else is literal", () => {
		assert.equal(globToRegExp("**").test("any/path/at.all"), true);
		assert.equal(globToRegExp("a/**/b").test("a/b"), true);
		assert.equal(globToRegExp("a/**/b").test("a/x/y/b"), true);
		assert.equal(globToRegExp("a/**/b").test("a/xb"), false);
		assert.equal(globToRegExp("*.js").test("a.js"), true);
		assert.equal(globToRegExp("*.js").test("src/a.js"), false);
		assert.equal(globToRegExp("a?.js").test("ab.js"), true);
		assert.equal(globToRegExp("a?.js").test("a/.js"), false);
		assert.equal(globToRegExp("src/(x)+.js").test("src/(x)+.js"), true);
		assert.equal(globToRegExp("src/(x)+.js").test("src/xx.js"), false);
	});
});

describe("tamper and scope findings", () => {
	const scope = ["src/**", "package.json"];

	it("a change to each runner configuration file or to __mocks__/ is tampering, even inside the claim scope", () => {
		const changed = ["package.json", "conftest.py", "jest.config.js", "vitest.config.ts", "pytest.ini", "Makefile", "tox.ini", "setup.cfg", ".mocharc.yml", "src/__mocks__/db.js"];
		const findings = tamperFindings(changed, ["**/*.js", ...changed], DEFAULT_TEST_GLOBS);
		for (const path of changed.slice(0, -1)) assert.ok(findings.includes(`runner configuration changed: ${path}`), path);
		assert.ok(findings.includes("test material changed: src/__mocks__/db.js"));
	});

	it("a path outside the claim scope is tampering and fails scope_compliance; the tool-status log is exempt", () => {
		const changed = [TOOL_STATUS_LOG_PATH, "docs/notes.md", "src/sum.js"];
		assert.deepEqual(tamperFindings(changed, ["src/**"], DEFAULT_TEST_GLOBS), ["outside the claim scope: docs/notes.md"]);
		assert.equal(scopeCompliant(changed, ["src/**"]), false);
		assert.deepEqual(tamperFindings([TOOL_STATUS_LOG_PATH, "src/sum.js"], ["src/**"], DEFAULT_TEST_GLOBS), []);
		assert.equal(scopeCompliant([TOOL_STATUS_LOG_PATH, "src/sum.js"], ["src/**"]), true);
	});

	it('an unbounded ("**") or missing claim scope never passes scope_compliance', () => {
		for (const bad of [["**"], ["src/**", "**"], [], null]) {
			assert.equal(scopeCompliant(["src/sum.js"], bad), false, JSON.stringify(bad));
		}
	});

	it("renaming a test file out of the test directory flags the test path; a mode change counts as a change", () => {
		const baseline = [blob("test/sum.test.js", "t1"), blob("src/sum.js", "s1"), blob("test/helper.js", "h1")];
		const candidate = [blob("src/sum.check.js", "t1"), blob("src/sum.js", "s1"), blob("test/helper.js", "h1", "100755")];
		const changed = changedPaths(baseline, candidate);
		assert.deepEqual(changed, ["src/sum.check.js", "test/helper.js", "test/sum.test.js"]);
		const findings = tamperFindings(changed, scope, DEFAULT_TEST_GLOBS);
		assert.ok(findings.includes("test material changed: test/sum.test.js"));
		assert.ok(findings.includes("test material changed: test/helper.js"));
	});

	it("unsafe tree paths are tampering", () => {
		for (const path of ["../escape.js", "a/../../b", ".git/config", "src/.GIT/hooks/x", "/abs.js", "a//b"]) {
			assert.equal(isSafeTreePath(path), false, path);
			assert.deepEqual(tamperFindings([path], ["**/*.js"], DEFAULT_TEST_GLOBS).length, 1, path);
		}
		assert.equal(isSafeTreePath("src/.github/x.yml"), true);
	});
});

describe("run directory tree", () => {
	it("takes runner configuration and tests from the baseline, source from the candidate, and leaves the tool log out", () => {
		const baseline = [
			blob("package.json", "pkg-base"),
			blob("test/sum.test.js", "test-base"),
			blob("src/sum.js", "src-base"),
		];
		const candidate = [
			blob("package.json", "pkg-cand"),
			blob("test/sum.test.js", "test-cand"),
			blob("test/extra.test.js", "extra-cand"),
			blob("src/sum.js", "src-cand"),
			blob("src/new.js", "new-cand", "100755"),
			blob(TOOL_STATUS_LOG_PATH, "log"),
			{ mode: "160000", type: "commit", oid: "sub", path: "vendor/lib" },
			blob("../escape.js", "evil"),
		];
		const files = composeRunTree(baseline, candidate, DEFAULT_TEST_GLOBS);
		assert.deepEqual(
			files.map((f) => [f.path, f.oid, f.from]),
			[
				["package.json", "pkg-base", "baseline"],
				["test/sum.test.js", "test-base", "baseline"],
				["src/sum.js", "src-cand", "candidate"],
				["src/new.js", "new-cand", "candidate"],
			],
		);
	});

	it("hidden-test paths and baseline files win collisions, including file/directory collisions", () => {
		const baseline = [blob("test/a.test.js", "base-a"), blob("test/hidden.test.js", "base-visible")];
		const candidate = [blob("test", "cand-file-named-test"), blob("hidden", "cand-file"), blob("src/x.js", "x")];
		const files = composeRunTree(baseline, candidate, DEFAULT_TEST_GLOBS, ["hidden/h.test.js", "test/hidden.test.js"]);
		assert.deepEqual(
			files.map((f) => f.path),
			["test/a.test.js", "src/x.js"],
			"the reserved hidden path replaces the baseline file; candidate files colliding with directories are left out",
		);
	});
});

describe("tool-status log", () => {
	it("a well-formed log bound to this run gives valid receipts and the session's model", () => {
		const check = checkToolStatusLog(
			log([SESSION, ACTION, { seq: 2, action: "run_tests", tool_status: "FAILED(nonzero_exit)", detail: "1 failing" }]),
			RUN,
		);
		assert.deepEqual(check, {
			receipts_valid: true,
			session: { agent_id: "agent-a", model: "claude-test-1", harness: "test-harness/1.0" },
			actions: 2,
			errors: [],
		});
	});

	it("no log, unparseable lines, or no actions → valid_tool_states fails", () => {
		assert.equal(checkToolStatusLog({ absent: "no tool-status log" }, RUN).receipts_valid, false);
		assert.equal(checkToolStatusLog({ text: "" }, RUN).receipts_valid, false);
		assert.equal(checkToolStatusLog({ text: `${JSON.stringify(SESSION)}\ntool ran fine\n` }, RUN).receipts_valid, false);
		assert.equal(checkToolStatusLog(log([SESSION]), RUN).receipts_valid, false);
		assert.equal(checkToolStatusLog(log([ACTION]), RUN).receipts_valid, false, "no session record");
	});

	it("tool_status must be OK or FAILED(<category>) on every action, with consecutive seq", () => {
		for (const bad of [
			{ ...ACTION, tool_status: "SKIPPED" },
			{ ...ACTION, tool_status: "FAILED" },
			{ ...ACTION, tool_status: "FAILED()" },
			{ ...ACTION, tool_status: "FAILED(Timeout)" },
			{ ...ACTION, tool_status: "ok" },
			{ ...ACTION, tool_status: undefined, status: "OK" },
			{ ...ACTION, seq: 2 },
			{ ...ACTION, action: "" },
			["edit_file", "OK"],
		]) {
			const check = checkToolStatusLog(log([SESSION, bad]), RUN);
			assert.equal(check.receipts_valid, false, JSON.stringify(bad));
		}
	});

	it("a session record for another run, or with no agent bound by the authority, fails both gates' inputs", () => {
		for (const field of ["task_id", "contender_id", "agent_id", "baseline_commit"] as const) {
			const check = checkToolStatusLog(log([{ ...SESSION, [field]: "other" }, ACTION]), RUN);
			assert.equal(check.receipts_valid, false, field);
			assert.equal(check.session, null, field);
			assert.deepEqual(check.errors, [`line 1: ${field} does not match this run`]);
		}
		const unbound = checkToolStatusLog(log([SESSION, ACTION]), { ...RUN, agent_id: null });
		assert.equal(unbound.receipts_valid, false);
		assert.equal(unbound.session, null);
		const wrongFormat = checkToolStatusLog(log([{ ...SESSION, format: "madgrix-tool-status/v0" }, ACTION]), RUN);
		assert.equal(wrongFormat.receipts_valid, false);
	});

	it("a missing or malformed model id leaves receipts valid but gives no session (provenance fails)", () => {
		for (const model of [undefined, "", " claude", "model with spaces", "x".repeat(200), 7]) {
			const check = checkToolStatusLog(log([{ ...SESSION, model }, ACTION]), RUN);
			assert.equal(check.receipts_valid, true, String(model));
			assert.equal(check.session, null, String(model));
		}
	});
});

describe("evaluatorGates", () => {
	const valid: ToolStatusCheck = checkToolStatusLog(log([SESSION, ACTION]), RUN);
	const input = {
		baselineAvailable: true,
		descendsFromBaseline: true,
		baselineCommit: RUN.baseline_commit,
		changed: ["src/sum.js", TOOL_STATUS_LOG_PATH],
		scope: ["src/**"],
		testGlobs: DEFAULT_TEST_GLOBS,
		toolStatus: valid,
		forkLineage: { parent_repo: "acme/api", parent_commit: RUN.baseline_commit },
	};

	it("an in-scope source change with a bound tool log passes all five gates", () => {
		assert.deepEqual(evaluatorGates(input), {
			findings: [],
			admission: {
				exact_baseline: true,
				scope_compliance: true,
				valid_tool_states: true,
				no_eval_tampering: true,
				provenance_complete: true,
			},
		});
	});

	it("provenance needs the log's session and the authority's fork lineage of this baseline", () => {
		assert.equal(evaluatorGates({ ...input, forkLineage: { parent_repo: "acme/api", parent_commit: "other" } }).admission.provenance_complete, false);
		assert.equal(evaluatorGates({ ...input, forkLineage: undefined }).admission.provenance_complete, false);
		assert.equal(evaluatorGates({ ...input, toolStatus: checkToolStatusLog({ absent: "none" }, RUN) }).admission.provenance_complete, false);
	});

	it("a baseline missing from the candidate repository fails closed", () => {
		const r = evaluatorGates({ ...input, baselineAvailable: false, descendsFromBaseline: false });
		assert.deepEqual(r.findings, [`baseline commit ${RUN.baseline_commit} is not in the candidate repository`]);
		assert.equal(r.admission.exact_baseline, false);
		assert.equal(r.admission.scope_compliance, false);
		assert.equal(r.admission.no_eval_tampering, false);
	});
});
