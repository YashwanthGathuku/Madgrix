/**
 * Admission gates (spec 1 §6) + the deterministic evaluation-domain
 * harness (spec 1 §7).
 *
 * This module is the slice's deterministic oracle: it runs the same pure
 * checks the production evaluation domain runs. Per spec 3 §4, production
 * executes these in isolated evaluation sandboxes (fresh, credential-free,
 * destroyed afterwards); white-box mode does NOT claim test secrecy.
 *
 * All gates are boolean and evaluated by the control plane — never by the
 * contender, never by model judgment (spec 1 §6). Where a gate needs
 * interpretation (scope), deterministic rules decide; an LLM may only
 * explain a deterministic finding.
 */

import { canonicalJson } from "./canonical.ts";
import { globMatchesPath } from "./claims.ts";
import type {
	AdmissionGates,
	EvaluationBundle,
	StaticAnalysisResult,
	TestSuiteResult,
	WorkClaim,
} from "./types.ts";

/** A deterministic test over a candidate tree (path → file content). */
export type TreeTest = (tree: Record<string, string>) => {
	name: string;
	pass: boolean;
	detail?: string;
};

export type StaticAnalyzer = (tree: Record<string, string>) => {
	passed: boolean;
	findings: string[];
};

export type Sha256Hex = (input: string | Uint8Array) => Promise<string>;

export interface AdmissionInput {
	claim: WorkClaim;
	/** Repo-relative paths touched by the candidate diff. */
	candidateFiles: string[];
	/** Symbols touched by the candidate diff. */
	candidateSymbols: string[];
	forkLineage: { parent_repo: string; parent_commit: string };
	baselineCommit: string;
	toolReceipts: { action: string; status: "OK" | "FAILED" | "SKIPPED" }[];
	/** Mechanically detected tampering signals (spec 1 §6: any → fail AND quarantine). */
	tamperSignals: string[];
	provenance: { agent_id: string; model: string; harness_version: string } | null;
}

/**
 * Evaluate the five admission gates (spec 1 §6). Fail fast, fail closed:
 * a candidate failing any gate MUST NOT proceed to evaluation, and a
 * no_eval_tampering failure additionally moves the contender to
 * QUARANTINE (handled by the task authority, task-state.ts).
 */
export function checkAdmissionGates(input: AdmissionInput): AdmissionGates {
	const exact_baseline =
		input.forkLineage.parent_commit.length > 0 &&
		input.forkLineage.parent_commit === input.baselineCommit;

	// Scope gate (spec 2): the diff touches only claimed paths/symbols.
	// Unclaimed changes → fail.
	const scope_compliance =
		input.candidateFiles.every((f) => input.claim.scope.paths.some((g) => globMatchesPath(g, f))) &&
		input.candidateSymbols.every((s) => input.claim.scope.symbols.includes(s));

	// Every claimed tool action carries a machine-readable receipt with a
	// named status; narration without receipts → fail. Fail closed: no
	// receipts at all is not evidence of tool work.
	const valid_tool_states =
		input.toolReceipts.length > 0 &&
		input.toolReceipts.every(
			(r) =>
				typeof r.action === "string" &&
				r.action.length > 0 &&
				(r.status === "OK" || r.status === "FAILED" || r.status === "SKIPPED"),
		);

	const no_eval_tampering = input.tamperSignals.length === 0;

	const provenance_complete =
		input.provenance !== null &&
		input.provenance.agent_id.length > 0 &&
		input.provenance.model.length > 0 &&
		input.provenance.harness_version.length > 0;

	return {
		exact_baseline,
		scope_compliance,
		valid_tool_states,
		no_eval_tampering,
		provenance_complete,
	};
}

function runSuite(tests: TreeTest[], tree: Record<string, string>): TestSuiteResult {
	const failed: string[] = [];
	for (const t of tests) {
		const r = t(tree);
		if (!r.pass) failed.push(r.name);
	}
	return { passed: failed.length === 0, total: tests.length, failed };
}

function runAnalyzers(
	analyzers: StaticAnalyzer[],
	tree: Record<string, string>,
): StaticAnalysisResult {
	const findings: string[] = [];
	let passed = true;
	for (const a of analyzers) {
		const r = a(tree);
		if (!r.passed) passed = false;
		findings.push(...r.findings);
	}
	return { passed, findings };
}

export interface EvaluateCandidateInput {
	candidateSha: string;
	treeSha256: string;
	contenderId: string;
	taskHash: string;
	/** Immutable candidate tree: repo-relative path → file content. */
	candidateTree: Record<string, string>;
	hiddenTests: TreeTest[];
	regressionTests: TreeTest[];
	semanticChecks: TreeTest[];
	staticAnalyzers: StaticAnalyzer[];
	securityPolicy: StaticAnalyzer;
	baselineTestManifestHash: string;
	candidateTestManifestHash: string;
	gates: AdmissionGates;
	sha256Hex: Sha256Hex;
	evaluatedAt?: string;
}

/**
 * Run the full independent evaluation over a candidate and build its
 * content-addressed evaluation bundle (spec 1 §§6–7).
 *
 * Attack #1 (spec 3 §6): candidate deletes or modifies visible tests.
 * Detected via baseline vs candidate test-manifest hash mismatch → a
 * tamper finding is recorded in security_policy.findings and
 * admission.no_eval_tampering is forced false on the bundle's admission
 * copy (the passed-in gates object is never mutated).
 */
export async function evaluateCandidate(input: EvaluateCandidateInput): Promise<EvaluationBundle> {
	const admission: AdmissionGates = { ...input.gates };
	const securityFindings: string[] = [];

	if (input.candidateTestManifestHash !== input.baselineTestManifestHash) {
		admission.no_eval_tampering = false;
		securityFindings.push(
			`tamper: test manifest hash mismatch — baseline ${input.baselineTestManifestHash} ` +
				`vs candidate ${input.candidateTestManifestHash} (attack #1: test deletion/modification)`,
		);
	}

	const tree = input.candidateTree;
	const hidden_oracle = runSuite(input.hiddenTests, tree);
	const regressions = runSuite(input.regressionTests, tree);
	const semantic_checks = runSuite(input.semanticChecks, tree);
	const static_analysis = runAnalyzers(input.staticAnalyzers, tree);
	const policy = input.securityPolicy(tree);
	const security_policy: StaticAnalysisResult = {
		passed: policy.passed && securityFindings.length === 0,
		findings: [...securityFindings, ...policy.findings],
	};

	const bundleWithoutHash = {
		candidate_sha: input.candidateSha,
		tree_sha256: input.treeSha256,
		contender_id: input.contenderId,
		task_hash: input.taskHash,
		admission,
		hidden_oracle,
		regressions,
		static_analysis,
		semantic_checks,
		security_policy,
		evaluated_at: input.evaluatedAt ?? new Date().toISOString(),
		tainted: false,
	};
	const bundle_hash = await input.sha256Hex(canonicalJson(bundleWithoutHash));
	return { ...bundleWithoutHash, bundle_hash };
}
