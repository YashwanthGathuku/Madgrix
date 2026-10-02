/**
 * Pure rules of the independent evaluator (scripts/evaluate-candidate.ts):
 * which paths are runner configuration or test material, which candidate
 * changes are evaluation tampering, which files make up the directory the
 * evaluation commands run in, and how the agent's tool-status log decides
 * valid_tool_states and provenance_complete (spec 1 §6;
 * specs/amendments/evidence-integrity-v1.md, specs/amendments/tool-status-v1.md).
 *
 * No I/O: the evaluator lists the baseline and candidate trees with git and
 * passes them in, so every rule here is unit-tested without a repository.
 */

import { globMatchesPath, isUnboundedGlob } from "./claims.ts";
import type { AdmissionGates } from "./types.ts";

/** Where an agent's tool-status log sits in its candidate tree. */
export const TOOL_STATUS_LOG_PATH = ".madgrix/tool-status.jsonl";
/** First-line `format` of a tool-status log. */
export const TOOL_STATUS_FORMAT = "madgrix-tool-status/v1";
/** A larger log is not read. */
export const TOOL_STATUS_LOG_MAX_BYTES = 1024 * 1024;

/**
 * Test material wherever it sits in a tree. A deployment can add globs
 * (MADGRIX_TEST_GLOBS); it cannot remove these.
 */
export const DEFAULT_TEST_GLOBS: readonly string[] = Object.freeze([
	"**/test/**",
	"**/tests/**",
	"**/__tests__/**",
	"**/spec/**",
	"**/__mocks__/**",
	"**/__snapshots__/**",
	"**/testdata/**",
	"**/*.test.*",
	"**/*.spec.*",
	"**/test_*.py",
	"**/*_test.py",
	"**/*_test.go",
]);

/**
 * Runner configuration, matched by file name at any depth: files a test
 * runner reads to decide what runs and how, plus the package-manager files
 * that decide which shell runs a test script and which test framework is
 * installed.
 */
const RUNNER_CONFIG_NAMES: ReadonlySet<string> = new Set([
	// npm / yarn / pnpm: scripts, the "jest" and "mocha" keys, script-shell, lockfiles
	"package.json",
	"package-lock.json",
	"npm-shrinkwrap.json",
	"yarn.lock",
	"pnpm-lock.yaml",
	".npmrc",
	".yarnrc",
	".yarnrc.yml",
	// pytest / tox
	"conftest.py",
	"pytest.ini",
	"pyproject.toml",
	"tox.ini",
	"setup.cfg",
	// make
	"Makefile",
	"makefile",
	"GNUmakefile",
	// mocha
	".mocharc",
]);

/** Runner configuration matched by file-name prefix (`jest.config.ts`, `.mocharc.yml`, ...). */
const RUNNER_CONFIG_PREFIXES: readonly string[] = Object.freeze([
	"jest.config.",
	"vitest.config.",
	"vitest.workspace.",
	"vite.config.",
	".mocharc.",
]);

function baseName(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

export function isRunnerConfigPath(path: string): boolean {
	const name = baseName(path);
	return RUNNER_CONFIG_NAMES.has(name) || RUNNER_CONFIG_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * A test glob as an anchored RegExp: `**` is any number of whole path
 * segments, `*` any run of characters other than `/`, `?` one such
 * character; everything else is literal.
 */
export function globToRegExp(glob: string): RegExp {
	const segments = glob.split("/");
	let source = "";
	segments.forEach((segment, i) => {
		const last = i === segments.length - 1;
		if (segment === "**") {
			source += last ? ".*" : "(?:[^/]*/)*";
			return;
		}
		for (const ch of segment) {
			if (ch === "*") source += "[^/]*";
			else if (ch === "?") source += "[^/]";
			else source += ch.replace(/[\\^$.|+()[\]{}]/, "\\$&");
		}
		if (!last) source += "/";
	});
	return new RegExp(`^${source}$`);
}

const compiledGlobs = new Map<string, RegExp>();

export function isTestPath(path: string, testGlobs: readonly string[]): boolean {
	return testGlobs.some((glob) => {
		let re = compiledGlobs.get(glob);
		if (re === undefined) compiledGlobs.set(glob, (re = globToRegExp(glob)));
		return re.test(path);
	});
}

/** A relative tree path with no empty, `.`, `..` or `.git` component. */
export function isSafeTreePath(path: string): boolean {
	return (
		path.length > 0 &&
		!path.startsWith("/") &&
		path.split("/").every((part) => part !== "" && part !== "." && part !== ".." && part.toLowerCase() !== ".git")
	);
}

/** One `git ls-tree -r` record. */
export interface TreeEntry {
	mode: string;
	type: string;
	oid: string;
	path: string;
}

/** Paths added, removed, or changed in content or mode between two trees (renames count as both paths). */
export function changedPaths(baseline: readonly TreeEntry[], candidate: readonly TreeEntry[]): string[] {
	const before = new Map(baseline.map((e) => [e.path, `${e.mode} ${e.oid}`]));
	const after = new Map(candidate.map((e) => [e.path, `${e.mode} ${e.oid}`]));
	const changed = new Set<string>();
	for (const [path, id] of after) if (before.get(path) !== id) changed.add(path);
	for (const path of before.keys()) if (!after.has(path)) changed.add(path);
	return [...changed].sort();
}

/** Why a claim scope cannot judge a diff, or null when it can. */
export function scopeProblem(scope: readonly unknown[] | null | undefined): string | null {
	if (!Array.isArray(scope) || scope.length === 0) return "the claim has no scope.paths";
	if (!scope.every((glob) => typeof glob === "string" && glob !== "")) return "the claim has a malformed scope path";
	if (scope.some((glob) => isUnboundedGlob(glob as string))) return 'the claim scope is unbounded ("**")';
	return null;
}

function inScope(scope: readonly string[], path: string): boolean {
	return scope.some((glob) => globMatchesPath(glob, path));
}

/**
 * Evaluation-tampering findings for a candidate's changed paths: a changed
 * runner-configuration file, a changed path matched by a test glob, and a
 * changed path outside the claim scope. The tool-status log is exempt.
 */
export function tamperFindings(
	changed: readonly string[],
	scope: readonly string[] | null,
	testGlobs: readonly string[],
): string[] {
	const scopeUsable = scopeProblem(scope) === null;
	const findings: string[] = [];
	for (const path of changed) {
		if (path === TOOL_STATUS_LOG_PATH) continue;
		if (!isSafeTreePath(path)) {
			findings.push(`unsafe path in candidate tree: ${JSON.stringify(path)}`);
			continue;
		}
		if (isRunnerConfigPath(path)) findings.push(`runner configuration changed: ${path}`);
		if (isTestPath(path, testGlobs)) findings.push(`test material changed: ${path}`);
		if (scopeUsable && !inScope(scope!, path)) findings.push(`outside the claim scope: ${path}`);
	}
	return findings;
}

/** Every changed path (but the tool-status log) lies inside a bounded claim scope. */
export function scopeCompliant(changed: readonly string[], scope: readonly string[] | null): boolean {
	if (scopeProblem(scope) !== null) return false;
	return changed.every((path) => path === TOOL_STATUS_LOG_PATH || inScope(scope!, path));
}

/** A file of the run directory and the tree it is taken from. */
export interface RunFile extends TreeEntry {
	from: "baseline" | "candidate";
}

function parentDirs(path: string): string[] {
	const parts = path.split("/");
	return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
}

/**
 * The files the evaluation commands run against: the BASELINE's runner
 * configuration and test material, then the candidate's other files. The
 * `reserved` paths (the hidden tests, copied in by the caller) come first.
 * A later file that collides with an earlier one (the same path, or one is
 * the other's directory) is left out, as are the tool-status log, non-blob
 * entries (submodules) and unsafe paths.
 */
export function composeRunTree(
	baseline: readonly TreeEntry[],
	candidate: readonly TreeEntry[],
	testGlobs: readonly string[],
	reserved: readonly string[] = [],
): RunFile[] {
	const files = new Set<string>();
	const dirs = new Set<string>();
	const take = (path: string) => {
		files.add(path);
		for (const dir of parentDirs(path)) dirs.add(dir);
	};
	const collides = (path: string) =>
		files.has(path) || dirs.has(path) || parentDirs(path).some((dir) => files.has(dir));
	reserved.forEach(take);

	const authoritative = (path: string) => isRunnerConfigPath(path) || isTestPath(path, testGlobs);
	const out: RunFile[] = [];
	const add = (entry: TreeEntry, from: RunFile["from"]) => {
		if (entry.type !== "blob" || !isSafeTreePath(entry.path) || collides(entry.path)) return;
		take(entry.path);
		out.push({ ...entry, from });
	};
	for (const entry of baseline) if (authoritative(entry.path)) add(entry, "baseline");
	for (const entry of candidate) {
		if (!authoritative(entry.path) && entry.path !== TOOL_STATUS_LOG_PATH) add(entry, "candidate");
	}
	return out;
}

/** The run a tool-status log must belong to. */
export interface ToolStatusRun {
	task_id: string;
	contender_id: string;
	/** The agent the authority bound to the contender; null when unknown (fails closed). */
	agent_id: string | null;
	baseline_commit: string;
}

export interface ToolStatusCheck {
	/** valid_tool_states: the log belongs to this run and every action carries OK or FAILED(<category>). */
	receipts_valid: boolean;
	/** The session record's identity fields, when they belong to this run and are well-formed. */
	session: { agent_id: string; model: string; harness: string } | null;
	actions: number;
	errors: string[];
}

/** Model and harness identifiers: `claude-x-1`, `org/model@2`, `aider/0.86.0`, ... */
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,127}$/;
const TOOL_STATUS = /^(?:OK|FAILED\([a-z][a-z0-9_.-]{0,63}\))$/;
const MAX_ACTION_LENGTH = 200;
const MAX_ERRORS = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Check a tool-status log (specs/amendments/tool-status-v1.md): JSON Lines,
 * a session record first, then one record per tool action. `log` is the
 * file's text, or why there is none to read.
 */
export function checkToolStatusLog(log: { text: string } | { absent: string }, run: ToolStatusRun): ToolStatusCheck {
	if ("absent" in log) return { receipts_valid: false, session: null, actions: 0, errors: [log.absent] };
	const lines = log.text.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	const records: unknown[] = [];
	for (let i = 0; i < lines.length; i++) {
		try {
			records.push(JSON.parse(lines[i]));
		} catch {
			return { receipts_valid: false, session: null, actions: 0, errors: [`line ${i + 1}: not JSON`] };
		}
	}

	const errors: string[] = [];
	const head = records[0];
	let bound = false;
	let session: ToolStatusCheck["session"] = null;
	if (!isRecord(head) || head.format !== TOOL_STATUS_FORMAT) {
		errors.push(`line 1: not a ${TOOL_STATUS_FORMAT} session record`);
	} else {
		const expected: Record<string, string | null> = {
			task_id: run.task_id,
			contender_id: run.contender_id,
			agent_id: run.agent_id,
			baseline_commit: run.baseline_commit,
		};
		const mismatched = Object.keys(expected).filter((k) => expected[k] === null || head[k] !== expected[k]);
		for (const k of mismatched) errors.push(`line 1: ${k} does not match this run`);
		bound = mismatched.length === 0;
		const malformed = ["model", "harness"].filter((k) => typeof head[k] !== "string" || !IDENTIFIER.test(head[k] as string));
		for (const k of malformed) errors.push(`line 1: ${k} is missing or malformed`);
		if (bound && malformed.length === 0) {
			session = { agent_id: head.agent_id as string, model: head.model as string, harness: head.harness as string };
		}
	}

	const actions = records.slice(1);
	if (actions.length === 0) errors.push("no action records");
	let actionsValid = true;
	actions.forEach((record, i) => {
		const line = i + 2;
		const problems: string[] = [];
		if (!isRecord(record)) problems.push("not an object");
		else {
			if (record.seq !== i + 1) problems.push(`seq is not ${i + 1}`);
			if (typeof record.action !== "string" || record.action === "" || record.action.length > MAX_ACTION_LENGTH) {
				problems.push("action is missing or malformed");
			}
			if (typeof record.tool_status !== "string" || !TOOL_STATUS.test(record.tool_status)) {
				problems.push("tool_status is not OK or FAILED(<category>)");
			}
		}
		if (problems.length > 0) {
			actionsValid = false;
			errors.push(`line ${line}: ${problems.join("; ")}`);
		}
	});

	return {
		receipts_valid: bound && actions.length > 0 && actionsValid,
		session,
		actions: actions.length,
		errors: errors.length > MAX_ERRORS ? [...errors.slice(0, MAX_ERRORS), `... ${errors.length - MAX_ERRORS} more`] : errors,
	};
}

export interface EvaluatorGateInput {
	/** The baseline commit is present in the candidate repository. */
	baselineAvailable: boolean;
	/** ...and is an ancestor of the candidate commit. */
	descendsFromBaseline: boolean;
	baselineCommit: string;
	changed: readonly string[];
	/** The bound claim's scope.paths (null when the claim has none). */
	scope: readonly string[] | null;
	testGlobs: readonly string[];
	toolStatus: ToolStatusCheck;
	/** The contender's fork lineage, as the authority recorded it. */
	forkLineage: { parent_repo?: unknown; parent_commit?: unknown } | null | undefined;
}

/** The five admission gates (spec 1 §6) as the evaluator measures them, with its tamper findings. */
export function evaluatorGates(input: EvaluatorGateInput): { admission: AdmissionGates; findings: string[] } {
	const findings = input.baselineAvailable
		? tamperFindings(input.changed, input.scope, input.testGlobs)
		: [`baseline commit ${input.baselineCommit} is not in the candidate repository`];
	const lineage = input.forkLineage;
	const lineageComplete =
		isRecord(lineage) &&
		typeof lineage.parent_repo === "string" &&
		lineage.parent_repo !== "" &&
		lineage.parent_commit === input.baselineCommit;
	return {
		findings,
		admission: {
			exact_baseline: input.baselineAvailable && input.descendsFromBaseline,
			scope_compliance: input.baselineAvailable && scopeCompliant(input.changed, input.scope),
			valid_tool_states: input.toolStatus.receipts_valid,
			no_eval_tampering: findings.length === 0,
			provenance_complete: input.toolStatus.session !== null && lineageComplete,
		},
	};
}
