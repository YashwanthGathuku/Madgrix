/**
 * VERTICAL SLICE — the complete governed-promotion loop, locally runnable.
 * (Internal codename: seam — NOT a public brand.)
 *
 * Run: `node src/harness/slice.ts` (Node 24 type-stripping; no build step).
 *
 * What this exercises, in order:
 *   0. Fake substrate: canonical repo + buggy baseline commit.
 *   1. Task freeze → task authority (pure task-state machine, driven
 *      directly — the same functions the Durable Object wrapper calls).
 *   2. WorkClaim registration + RED contract-conflict classification.
 *   3. Idempotent contender forks + write tokens (double-fork converges).
 *   4. Simulated contender pushes (correct / off-by-one / test tampering).
 *   5. Queue ingestion: dedupe (ACK_DUP) + unknown-repo rejection.
 *   6. Evaluation domain: admission gates, hidden oracle, tamper →
 *      quarantine, token revocation enforced on the fake. Evidence is
 *      admitted only from the evaluation domain (zone check inside the
 *      authority); contender-zone callers are rejected.
 *   7. Blind verifiers: keys registered at freeze → commit → judge
 *      (anonymized) → reveal → report; every report carries an Ed25519
 *      signature from the verifier's OWN key and the authority verifies it
 *      against the registered key (wrong key / unsigned / forged →
 *      rejected); one invalid reveal → inadmissible, no retry.
 *   8. Verdict seam → ACCEPT, winner = contender-1.
 *   9. Exact-state single-use permit; replay → ALREADY_CONSUMED.
 *  10. in-toto attestation chain → signed promotion bundle on disk.
 *  11. Offline `$ verify` CLI over the bundle → VERIFIED.
 *
 * Simulation substrate vs production-real logic — stated plainly:
 *   FAKE: FakeArtifacts (in-memory repos/tokens), pushAsToken/readTreeAsToken
 *         (stand-ins for the git protocol), the "language runtime" below
 *         (regex-extracted function bodies executed via new Function —
 *         labeled wherever it appears), the Ed25519 slice signer (production
 *         uses Sigstore; the DSSE envelope shape is identical).
 *   REAL: the task-state machine, claim validation + conflict graph,
 *         admission gates, evaluation bundle construction, blind-verifier
 *         commit/reveal mechanics + report signature verification against
 *         registered keys, the verdict seam (gates → dominance →
 *         vote), exact-state permits, and the in-toto/DSSE attestation
 *         shapes — all production code paths, no slice-only forks.
 *
 * The harness exits non-zero on any unexpected outcome.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
	canonicalJson,
	joinHashParts,
	randomHex,
	sha256Hex,
} from "../lib/canonical.ts";
import {
	ArtifactAuthError,
	forkIdempotent,
} from "../lib/artifacts-port.ts";
import { FakeArtifacts } from "../lib/fake-artifacts.ts";
import {
	attemptPromotion,
	commitVerifier,
	createAuthority,
	defaultCtx,
	ingestQueueEvent,
	issuePermit,
	quarantineContender,
	registerClaim,
	registerOperatorKeys,
	registerVerifierKeys,
	revealVerifier,
	runVerdictSeam,
	submitEvaluation,
	submitVerifierReport,
	taskHashFor,
	type CandidateEvidence,
	type Ctx,
	type NewClaimInput,
} from "../lib/task-state.ts";
import { reconcileClaims } from "../lib/claims.ts";
import {
	checkAdmissionGates,
	evaluateCandidate,
	type StaticAnalyzer,
	type TreeTest,
} from "../lib/evaluation.ts";
import { createCommitment, type DeterministicVerifier } from "../lib/verifiers.ts";
import { tallyVotes } from "../lib/verdict-seam.ts";
import {
	buildLinkStatement,
	buildPromotionAuthority,
	buildTestResultStatement,
	buildVerificationResultStatement,
	signEnvelope,
	verifyBundle,
	type PromotionBundle,
} from "../lib/attestation.ts";
import { createEd25519Signer } from "../lib/signer-node.ts";
import { SELECTOR_POLICY_INPUT } from "../do/TaskAuthority.ts";
import {
	SELECTOR_POLICY_VERSION,
	type AuthorityState,
	type CallerIdentity,
	type ContenderRecord,
	type EvaluationBundle,
	type QueuePushEvent,
	type ReferenceReport,
	type TaskRecord,
	type VerdictReport,
} from "../lib/types.ts";

const execFileAsync = promisify(execFile);

/* ------------------------------------------------------------------ */
/* Options / result                                                    */
/* ------------------------------------------------------------------ */

export interface SliceOptions {
	/** Suppress the sectioned log (used by test/slice.test.ts). */
	quiet?: boolean;
	/** Directory for promotion.bundle (default ".slice-output"). */
	outDir?: string;
}

export interface SliceResult {
	taskId: string;
	taskHash: string;
	baseline: string;
	candidateShas: Record<string, string>;
	verdictState: string;
	winnerSha: string | null;
	promotionOutcome: string;
	/** Outcome of presenting the same permit a second time (must be ALREADY_CONSUMED). */
	replayOutcome: string;
	permitId: string;
	bundlePath: string;
	verified: boolean;
}

function check(cond: unknown, msg: string): asserts cond {
	if (!cond) throw new Error(`slice assertion failed: ${msg}`);
}

/* ------------------------------------------------------------------ */
/* Simulated language runtime (SLICE ONLY)                             */
/*                                                                     */
/* Extracts `isTokenExpired` from the candidate's src/auth.js and       */
/* executes it via `new Function`. This is a stand-in for a real        */
/* language toolchain: the protocol mechanics (gates, oracles,          */
/* quarantine, verdict, permits) are what's under test, not JS         */
/* execution. Labeled everywhere it is used.                            */
/* ------------------------------------------------------------------ */

function extractIsTokenExpired(tree: Record<string, string>): (exp: number, now: number) => boolean {
	const src = tree["src/auth.js"] ?? "";
	const m = /export function isTokenExpired\(exp,\s*now\)\s*\{([\s\S]*?)\n\}/.exec(src);
	if (!m) throw new Error("simulated runtime: isTokenExpired not found in src/auth.js");
	return new Function("exp", "now", m[1]) as (exp: number, now: number) => boolean;
}

function behaviorTest(name: string, exp: number, now: number, expected: boolean): TreeTest {
	return (tree) => {
		let got: unknown;
		let threw: string | null = null;
		try {
			got = extractIsTokenExpired(tree)(exp, now);
		} catch (e) {
			threw = (e as Error).message;
		}
		const pass = threw === null && got === expected;
		return {
			name,
			pass,
			detail: threw !== null ? `threw: ${threw}` : `got ${String(got)}, want ${String(expected)}`,
		};
	};
}

/* ------------------------------------------------------------------ */
/* The slice                                                           */
/* ------------------------------------------------------------------ */

export async function runSlice(opts: SliceOptions = {}): Promise<SliceResult> {
	const quiet = opts.quiet ?? false;
	const outDir = opts.outDir ?? ".slice-output";
	const log = (...args: unknown[]): void => {
		if (!quiet) console.log(...args);
	};
	const section = (n: string, title: string): void => {
		log(`\n${"=".repeat(70)}\n[${n}] ${title}\n${"=".repeat(70)}`);
	};

	const selectorPolicyHash = await sha256Hex(SELECTOR_POLICY_INPUT);
	const ctx: Ctx = defaultCtx(selectorPolicyHash);
	const short = (h: string): string => h.slice(0, 12);

	/* ================= [0] SETUP ================= */
	section("0/11", "SETUP — fake substrate, canonical repo, buggy baseline");
	const fake = new FakeArtifacts();
	await fake.create("canonical");
	const baselineTree: Record<string, string> = {
		"src/auth.js":
			`export function isTokenExpired(exp, now) {\n  return exp > now;\n}\n`, // BUGGY — inverted
		"tests/auth.visible.js":
			`// Visible test manifest — names only.\n// The evaluation domain implements these; contenders must not modify this file.\n` +
			`export const VISIBLE_TESTS = [\n  "expired token returns true",\n  "valid token returns false",\n];\n`,
		"README.md": `# seam slice fixture\n`,
	};
	const baseline = await fake.adminPush({
		repo: "canonical",
		ref: "main",
		tree: baselineTree,
		message: "baseline: buggy isTokenExpired (inverted comparison)",
	});
	log(`canonical repo created; baseline commit ${baseline}`);
	log(`  src/auth.js: buggy 'return exp > now;' (inverted)`);

	/* ================= [1] FREEZE TASK ================= */
	section("1/11", "FREEZE TASK — task record → task authority");
	const task_id = "task_slice_001";
	const intent =
		"Fix isTokenExpired so expired tokens (exp <= now) return true and valid tokens return false.";
	const behavior_contract = "isTokenExpired(exp, now) returns true iff exp <= now.";
	const frozen_at = new Date().toISOString();
	// Spec 1 §5 (FROZEN): task_hash = SHA256(canonical_json(task_record)) — the
	// single conforming implementation is taskHashFor (src/lib/task-state.ts).
	const task_hash = await taskHashFor(
		{
			intent,
			baseline_repo: "canonical",
			baseline_commit: baseline,
			behavior_contract,
			policy_version: SELECTOR_POLICY_VERSION,
			frozen_at,
		},
		sha256Hex,
	);
	const task: TaskRecord = {
		task_id,
		task_hash,
		intent,
		baseline_repo: "canonical",
		baseline_commit: baseline,
		behavior_contract,
		policy_version: SELECTOR_POLICY_VERSION,
		frozen_at,
	};
	// NOTE: the harness drives the pure task-state machine directly —
	// the same transition functions the Durable Object wrapper calls.
	let state: AuthorityState = createAuthority(task);
	log(`task_id=${task_id}`);
	log(`task_hash=${task_hash}`);
	log(`behavior contract: "${behavior_contract}"`);

	// KEY FREEZE (spec 1 §8, §9.4): every verifier's Ed25519 public key and
	// the operator-of-record's key are registered NOW, bound to
	// verifier_id, and are IMMUTABLE for the task's lifetime. From this
	// point on, submitVerifierReport rejects any report not signed by the
	// registered key — a forged report cannot be injected. Each verifier
	// holds its own private key; the slice signer here is the harness's
	// stand-in for per-verifier key custody (SIMULATION SUBSTRATE:
	// production uses Sigstore per spec 4 §6; the DSSE envelope shape is
	// identical, only the key backend differs).
	const verifierSignerIds = ["verifier-1-correctness", "verifier-2-security", "verifier-3-minimality"];
	const verifierSigners: Record<string, ReturnType<typeof createEd25519Signer>> = {};
	for (const vid of verifierSignerIds) verifierSigners[vid] = createEd25519Signer();
	state = await registerVerifierKeys(
		state,
		verifierSignerIds.map((verifier_id) => ({
			verifier_id,
			public_key_der_hex: verifierSigners[verifier_id].publicKeyDerHex,
		})),
		ctx,
	);
	const operatorSigner = createEd25519Signer();
	state = await registerOperatorKeys(state, [{ public_key_der_hex: operatorSigner.publicKeyDerHex }], ctx);
	log(
		`keys frozen: ${verifierSignerIds.length} verifier keys + 1 operator key ` +
			`(keyids immutable; reports/determinations must verify)`,
	);

	/* ================= [2] WORK CLAIMS ================= */
	section("2/11", "WORK CLAIMS — registration + conflict classification");
	const contenderIds = ["contender-1", "contender-2", "contender-3"];
	const claimInputs: Record<string, NewClaimInput> = {
		"contender-1": {
			agent: "contender-1",
			task: task_hash,
			baseline,
			intent: { behavior: ["fix isTokenExpired boundary"] },
			scope: { paths: ["src/auth.js"], symbols: ["isTokenExpired"] },
			contracts: { reads: ["JWTClaims"], modifies: ["TokenValidationResult"] },
			interfaces: [],
			schema_changes: [],
			expected_tests: ["expired token returns true", "valid token returns false"],
			lease: { claimed_at: frozen_at, expires_at: new Date(Date.now() + 3600_000).toISOString() },
		},
		"contender-2": {
			agent: "contender-2",
			task: task_hash,
			baseline,
			intent: { behavior: ["fix isTokenExpired boundary"] },
			scope: { paths: ["src/auth.js"], symbols: ["isTokenExpired"] },
			contracts: { reads: [], modifies: ["JWTClaims"] },
			interfaces: [],
			schema_changes: [],
			expected_tests: ["expired token returns true", "valid token returns false"],
			lease: { claimed_at: frozen_at, expires_at: new Date(Date.now() + 3600_000).toISOString() },
		},
		"contender-3": {
			agent: "contender-3",
			task: task_hash,
			baseline,
			intent: { behavior: ["fix isTokenExpired boundary"] },
			scope: { paths: ["src/auth.js", "tests/auth.visible.js"], symbols: ["isTokenExpired"] },
			contracts: { reads: ["TokenValidationResult"], modifies: [] },
			interfaces: [],
			schema_changes: [],
			expected_tests: ["expired token returns true", "valid token returns false"],
			lease: { claimed_at: frozen_at, expires_at: new Date(Date.now() + 3600_000).toISOString() },
		},
	};
	const workIds: Record<string, string> = {};
	for (const cid of contenderIds) {
		const r = await registerClaim(state, claimInputs[cid], ctx);
		state = r.state;
		workIds[cid] = r.claim.work_id;
		log(`claim registered: ${r.claim.work_id} (agent ${cid})`);
		for (const rep of r.reports) {
			log(`  conflict ${rep.claim_a} vs ${rep.claim_b}: ${rep.risk}`);
			log(`    ${rep.explanation}`);
		}
	}
	// The designed RED pair: claim-1 reads JWTClaims, claim-2 modifies it.
	const redPair = reconcileClaims(state.claims).find(
		(r) =>
			(workIds["contender-1"] === r.claim_a && workIds["contender-2"] === r.claim_b) ||
			(workIds["contender-1"] === r.claim_b && workIds["contender-2"] === r.claim_a),
	);
	check(redPair !== undefined && redPair.risk === "RED", "claims 1+2 must classify RED");
	log(`ASSERT: claim-1 vs claim-2 → RED (contract conflict on JWTClaims)`);
	log(
		`slice policy for RED conflicts: proceed-with-awareness (spec 2 leaves the default OPEN; ` +
			`the conflict is recorded in the log and counted in blast_radius, not used as a veto)`,
	);

	/* ================= [3] FORKS ================= */
	section("3/11", "FORKS — idempotent contender forks + write tokens");
	const forkNames: Record<string, string> = {};
	const writePlaintexts: Record<string, string> = {};
	for (const cid of contenderIds) {
		const forkName = (await sha256Hex(joinHashParts("fork", task_id, cid))).slice(0, 32);
		forkNames[cid] = forkName;
		const first = await forkIdempotent(fake, "canonical", forkName);
		check(first.created, `first fork for ${cid} must create`);
		// Demonstrate idempotency: the second call converges to the same fork.
		const second = await forkIdempotent(fake, "canonical", forkName);
		check(!second.created && second.repo.name === forkName, "double-fork must return the existing fork");
		log(`fork ${forkName} created for ${cid}; second fork call → existing fork (idempotent)`);
		const repo = second.repo;
		if (first.initialTokenPlaintext !== null) {
			// The fork-creation token has the binding default TTL — too long
			// for a contender. Revoke it; the contender gets a ≤1h token.
			await repo.revokeToken(first.initialTokenPlaintext);
		}
		const tok = await repo.createToken("write", 3600);
		writePlaintexts[cid] = tok.plaintext; // held in memory only, never logged
		// Control-plane action: insert the contender record directly into
		// the authority state (documented; the DO /contender RPC does this
		// in production after forking).
		const contender: ContenderRecord = {
			contender_id: cid,
			agent_id: cid,
			fork_repo: forkName,
			fork_lineage: { parent_repo: "canonical", parent_commit: baseline },
			token_id: tok.id,
			status: "forked",
			claim_work_id: workIds[cid],
			latest_commit: baseline,
		};
		state = { ...state, contenders: { ...state.contenders, [cid]: contender } };
		log(`contender record inserted: ${cid} → fork ${forkName} (write token id ${tok.id}, TTL 3600s)`);
	}

	/* ================= [4] CONTENDER PUSHES ================= */
	section("4/11", "CONTENDER WORK — simulated agent pushes via the git-protocol stand-in");
	const candidateTrees: Record<string, Record<string, string>> = {
		"contender-1": {
			...baselineTree,
			"src/auth.js": `export function isTokenExpired(exp, now) {\n  return exp <= now;\n}\n`, // CORRECT
		},
		"contender-2": {
			...baselineTree,
			"src/auth.js": `export function isTokenExpired(exp, now) {\n  return exp < now;\n}\n`, // plausible wrong: misses the boundary
		},
		"contender-3": {
			...baselineTree,
			"src/auth.js": `export function isTokenExpired(exp, now) {\n  return exp < now;\n}\n`,
			// ATTACK: modifies the visible test manifest to hide the boundary.
			"tests/auth.visible.js": baselineTree["tests/auth.visible.js"].replace(
				'"valid token returns false"',
				'"valid token returns false (patched by contender-3)"',
			),
		},
	};
	const candidateShas: Record<string, string> = {};
	const candidateMessages: Record<string, string> = {};
	for (const cid of contenderIds) {
		const message = `${cid}: fix isTokenExpired`;
		candidateMessages[cid] = message;
		const sha = await fake.pushAsToken({
			repo: forkNames[cid],
			ref: "main",
			tree: candidateTrees[cid],
			message,
			parents: [baseline],
			token: writePlaintexts[cid],
		});
		candidateShas[cid] = sha;
		log(`${cid} pushed candidate ${short(sha)} (${cid === "contender-3" ? "src/auth.js + tests/auth.visible.js [TAMPER]" : "src/auth.js"})`);
	}

	/* ================= [5] QUEUE INGESTION ================= */
	section("5/11", "QUEUE INGESTION — at-least-once delivery, event_key dedupe");
	const pushEvents: Record<string, QueuePushEvent> = {};
	for (const cid of contenderIds) {
		const event: QueuePushEvent = {
			namespace: "default",
			repo: forkNames[cid],
			ref: "refs/heads/main",
			before: baseline,
			after: candidateShas[cid],
		};
		pushEvents[cid] = event;
		const r = await ingestQueueEvent(state, event, ctx);
		state = r.state;
		check(r.outcome === "APPLIED_NEW", `push event for ${cid} must be APPLIED_NEW`);
		log(`event for ${cid}: ${r.outcome} (latest_commit=${short(candidateShas[cid])})`);
	}
	// (a) duplicate delivery of contender-1's event → ACK_DUP
	{
		const r = await ingestQueueEvent(state, pushEvents["contender-1"], ctx);
		state = r.state;
		check(r.outcome === "ACK_DUP", "duplicate delivery must be ACK_DUP");
		log(`duplicate delivery of contender-1's event → ${r.outcome} (no state change, no effects)`);
	}
	// (b) event for an unknown repo → REJECTED_OUT_OF_ORDER
	{
		const r = await ingestQueueEvent(
			state,
			{ namespace: "default", repo: "ghost-repo", ref: "refs/heads/main", before: baseline, after: "deadbeef" },
			ctx,
		);
		state = r.state;
		check(r.outcome === "REJECTED_OUT_OF_ORDER", "unknown repo must be REJECTED_OUT_OF_ORDER");
		log(`event for unknown repo 'ghost-repo' → ${r.outcome} (ledgered, not applied)`);

	}

	/* ================= [6] EVALUATION ================= */
	section("6/11", "EVALUATION — admission gates, hidden oracle, tamper → quarantine");
	// SIMULATED LANGUAGE RUNTIME (slice-only): the TreeTests below extract
	// isTokenExpired from src/auth.js and execute it via new Function.
	// The protocol mechanics are what's under test, not a JS toolchain.
	const visibleTests: TreeTest[] = [
		behaviorTest("visible: expired token (100,200) -> true", 100, 200, true),
		behaviorTest("visible: valid token (300,200) -> false", 300, 200, false),
	];
	const hiddenTests: TreeTest[] = [
		behaviorTest("hidden: boundary (200,200) -> true", 200, 200, true),
		behaviorTest("hidden: zero (0,0) -> true", 0, 0, true),
	];
	const semanticChecks: TreeTest[] = [
		(tree) => {
			const v = extractIsTokenExpired(tree)(123, 456);
			return { name: "semantic: returns a boolean", pass: typeof v === "boolean" };
		},
	];
	const staticAnalyzers: StaticAnalyzer[] = [
		(tree) => {
			const src = tree["src/auth.js"] ?? "";
			const findings: string[] = [];
			if (!/isTokenExpired/.test(src)) findings.push("isTokenExpired missing from src/auth.js");
			if (/eval\s*\(/.test(src)) findings.push("eval() usage in src/auth.js");
			return { passed: findings.length === 0, findings };
		},
	];
	const securityPolicy: StaticAnalyzer = () => ({ passed: true, findings: [] });

	const baselineManifestHash = await sha256Hex(baselineTree["tests/auth.visible.js"]);
	const bundles: Record<string, EvaluationBundle> = {};
	for (const cid of contenderIds) {
		const repo = await fake.get(forkNames[cid]);
		// Credential matrix (spec 3 §5): the evaluation domain gets a READ
		// token on the fork — never a write token.
		const readTok = await repo.createToken("read", 600);
		const tree = await fake.readTreeAsToken({
			repo: forkNames[cid],
			ref: candidateShas[cid],
			token: readTok.plaintext,
		});
		const meta = await repo.readCommit(candidateShas[cid]);
		check(meta !== null, `commit ${short(candidateShas[cid])} must exist`);
		const treeSha256 = (meta as { treeHash: string }).treeHash;

		// The evaluator must NOT be able to write with its read token.
		let scopeDenied = false;
		try {
			await fake.pushAsToken({
				repo: forkNames[cid],
				ref: "main",
				tree,
				message: "evaluator write attempt",
				token: readTok.plaintext,
			});
		} catch (e) {
			scopeDenied = e instanceof ArtifactAuthError && e.code === "SCOPE_DENIED";
		}
		check(scopeDenied, "evaluator read token must be denied write (SCOPE_DENIED)");
		log(`${cid}: evaluated via READ token (write attempt → SCOPE_DENIED, as required)`);

		// Mechanical tamper signal: candidate test manifest vs baseline.
		const candidateManifestHash = await sha256Hex(tree["tests/auth.visible.js"] ?? "");
		const tamperSignals =
			candidateManifestHash !== baselineManifestHash ? ["test_manifest_hash_mismatch"] : [];

		const claim = state.claims.find((c) => c.agent === cid);
		check(claim !== undefined, `claim for ${cid} must exist`);
		const candidateFiles =
			cid === "contender-3" ? ["src/auth.js", "tests/auth.visible.js"] : ["src/auth.js"];
		const gates = checkAdmissionGates({
			claim: claim as NonNullable<typeof claim>,
			candidateFiles,
			candidateSymbols: ["isTokenExpired"],
			forkLineage: { parent_repo: "canonical", parent_commit: baseline },
			baselineCommit: baseline,
			toolReceipts: [
				{ action: "edit_file", status: "OK" },
				{ action: "push", status: "OK" },
			],
			tamperSignals,
			provenance: { agent_id: cid, model: "slice-simulated-agent/0.1", harness_version: "slice/0.1.0" },
		});
		const bundle = await evaluateCandidate({
			candidateSha: candidateShas[cid],
			treeSha256,
			contenderId: cid,
			taskHash: task_hash,
			candidateTree: tree,
			hiddenTests,
			regressionTests: visibleTests,
			semanticChecks,
			staticAnalyzers,
			securityPolicy,
			baselineTestManifestHash: baselineManifestHash,
			candidateTestManifestHash: candidateManifestHash,
			gates,
			sha256Hex,
		});
		// Evidence enters the authority only from the evaluation domain
		// (the zone check is enforced inside submitEvaluation, spec 3 §5).
		const evalCaller: CallerIdentity = { zone: "evaluation_domain" };
		const evalRes = await submitEvaluation(state, bundle, evalCaller, ctx);
		check(evalRes.outcome === "RECORDED", `evidence for ${cid} must be RECORDED (got ${evalRes.outcome})`);
		state = evalRes.state;
		bundles[cid] = bundle;
		log(
			`${cid}: bundle ${short(bundle.bundle_hash)} — hidden_oracle ${bundle.hidden_oracle.passed ? "PASS" : "FAIL"} ` +
				`[${bundle.hidden_oracle.failed.join(", ") || "all pass"}], regressions ${bundle.regressions.passed ? "PASS" : "FAIL"}, ` +
				`no_eval_tampering=${bundle.admission.no_eval_tampering}`,
		);

		if (!bundle.admission.no_eval_tampering) {
			// Mechanical trigger → quarantine (spec 1 §9.5, spec 3 §7).
			const q = await quarantineContender(state, cid, "eval_file_modification", bundle.bundle_hash, ctx);
			state = q.state;
			log(`QUARANTINE: ${cid} (trigger=eval_file_modification, evidence=${short(bundle.bundle_hash)})`);
			for (const e of q.effects) {
				if (e.kind === "revoke_token") {
					const r2 = await fake.get(e.repo);
					const revoked = await r2.revokeToken(e.token_id);
					check(revoked, "revoke_token effect must revoke");
					log(`  effect executed: revoke_token ${e.token_id} on ${e.repo}`);
				} else {
					log(`  effect (not executed in slice): ${e.kind}`);
				}
			}
			// Demonstrate: a subsequent push with the revoked token throws.
			let threwRevoked = false;
			try {
				await fake.pushAsToken({
					repo: forkNames[cid],
					ref: "main",
					tree: candidateTrees[cid],
					message: "post-quarantine push attempt",
					token: writePlaintexts[cid],
				});
			} catch (e) {
				threwRevoked = e instanceof ArtifactAuthError && e.code === "TOKEN_REVOKED";
			}
			check(threwRevoked, "push with revoked token must throw TOKEN_REVOKED");
			log(`  post-quarantine push with revoked token → TOKEN_REVOKED (demonstrated)`);
		}
	}
	check(state.quarantine["contender-3"]?.status === "QUARANTINED", "contender-3 must be quarantined");
	check(state.contenders["contender-3"].status === "quarantined", "contender-3 status must be quarantined");
	check(state.evaluations[candidateShas["contender-3"]].tainted === true, "contender-3 bundle must be tainted");
	log(`ASSERT: contender-3 QUARANTINED, token revoked, bundle tainted`);

	/* ================= [7] BLIND VERIFIERS ================= */
	section("7/11", "BLIND VERIFIERS — commit → anonymized judge → reveal → signed report");
	// The authority's attestation signer (in-toto envelopes, §10). This is
	// NOT a verifier key — the verifiers' own signers were created and
	// their keys registered at task freeze above. SIMULATION SUBSTRATE:
	// production uses Sigstore per spec 4 §6; the DSSE envelope shape is
	// identical, only the key backend differs. The key lives in the
	// control plane only.
	const signer = createEd25519Signer();

	function makeVerifier(verifier_id: string, aspect: string): DeterministicVerifier {
		return {
			verifier_id,
			aspect,
			produceReference(_task: TaskRecord): ReferenceReport {
				return {
					expected_behavior: ["isTokenExpired(exp, now) returns true iff exp <= now"],
					invariants: ["boundary exp === now must return true", "pure function of (exp, now)"],
					likely_failure_modes: [
						"off-by-one at the boundary (exp < now instead of exp <= now)",
						"inverted comparison",
						"test tampering to hide the boundary",
					],
					evaluation_plan: [
						"run the hidden oracle at the boundary",
						"check test-manifest integrity",
						"check the change stays in scope",
					],
					security_expectations: ["no test file modification", "minimal change surface"],
				};
			},
			judge(candidateLabel: string, bundle: EvaluationBundle) {
				if (aspect === "correctness") {
					return bundle.hidden_oracle.passed && bundle.regressions.passed
						? { verdict: "accept" as const, reasons: [`${candidateLabel}: hidden oracle + regressions pass`] }
						: {
								verdict: "reject" as const,
								reasons: [`${candidateLabel}: oracle failures [${bundle.hidden_oracle.failed.join(", ")}]`],
							};
				}
				if (aspect === "security") {
					return bundle.security_policy.passed && bundle.admission.no_eval_tampering && !bundle.tainted
						? { verdict: "accept" as const, reasons: [`${candidateLabel}: no tamper signals; policy clean`] }
						: { verdict: "reject" as const, reasons: [`${candidateLabel}: security/tamper signal`] };
				}
				return bundle.static_analysis.passed && bundle.admission.scope_compliance
					? { verdict: "accept" as const, reasons: [`${candidateLabel}: in scope, minimal`] }
					: { verdict: "reject" as const, reasons: [`${candidateLabel}: scope/static failure`] };
			},
		};
	}

	// Control-plane action (documented): assign anonymized labels to
	// candidates and record the label → SHA mapping in the authority.
	// Verifiers see ONLY the label + the evaluation bundle, never the
	// contender identity or the SHA.
	for (const cid of contenderIds) {
		const label = `candidate-${candidateShas[cid].slice(0, 4)}`;
		state = {
			...state,
			candidate_labels: { ...state.candidate_labels, [label]: candidateShas[cid] },
		};
		log(`label assigned: ${label} → ${short(candidateShas[cid])} (authority-held mapping; verifiers never see SHAs)`);
	}
	const labelOf = (cid: string): string => `candidate-${candidateShas[cid].slice(0, 4)}`;

	const verifiers = [
		makeVerifier("verifier-1-correctness", "correctness"),
		makeVerifier("verifier-2-security", "security"),
		makeVerifier("verifier-3-minimality", "minimality"),
	];
	for (const v of verifiers) {
		const reference = v.produceReference(task);
		const nonce = randomHex(16);
		const commitment = await createCommitment(
			reference,
			nonce,
			task_hash,
			v.verifier_id,
			SELECTOR_POLICY_VERSION,
			sha256Hex,
		);
		state = await commitVerifier(
			state,
			{
				verifier_id: v.verifier_id,
				task_hash,
				policy_version: SELECTOR_POLICY_VERSION,
				commitment,
				committed_at: ctx.now(),
			},
			ctx,
		);
		log(`${v.verifier_id} committed (${short(commitment)}) BEFORE seeing any candidate`);
		// Blind judging: anonymized label + bundle only.
		const judged = v.judge(labelOf("contender-1"), bundles["contender-1"]);
		log(`  judged ${labelOf("contender-1")} on aspect '${v.aspect}' → ${judged.verdict.toUpperCase()}`);
		// Each verifier signs with ITS OWN key; the authority verifies the
		// signature against the key registered for verifier_id at freeze.
		const vSigner = verifierSigners[v.verifier_id];
		const unsigned = {
			verifier_id: v.verifier_id,
			candidate_label: labelOf("contender-1"),
			verdict: judged.verdict,
			reasons: judged.reasons,
			keyid: vSigner.keyid,
		};
		const sig = await vSigner.sign(new TextEncoder().encode(canonicalJson(unsigned)));
		const report: VerdictReport = { ...unsigned, signature: sig.signature };
		// The harness sanity-checks the signature before submission; the
		// AUTHORITY re-verifies it in submitVerifierReport against the
		// registered key — an unsigned, wrong-key, or forged report is
		// rejected there (spec 1 §8).
		const sigOk = await vSigner.verify(
			new TextEncoder().encode(canonicalJson(unsigned)),
			report.signature,
			report.keyid,
		);
		check(sigOk, `${v.verifier_id} report signature must verify`);
		const rev = await revealVerifier(state, v.verifier_id, reference, nonce, ctx);
		check(rev.admissible, `${v.verifier_id} reveal must be admissible`);
		state = rev.state;
		state = await submitVerifierReport(state, report, ctx);
		log(`  reveal VALID → report submitted (${judged.verdict})`);
	}

	// Invalid reveal demonstration: commit with one nonce, reveal another.
	{
		const bad = makeVerifier("verifier-4-invalid", "correctness");
		const reference = bad.produceReference(task);
		const realNonce = randomHex(16);
		const commitment = await createCommitment(
			reference,
			realNonce,
			task_hash,
			bad.verifier_id,
			SELECTOR_POLICY_VERSION,
			sha256Hex,
		);
		state = await commitVerifier(
			state,
			{
				verifier_id: bad.verifier_id,
				task_hash,
				policy_version: SELECTOR_POLICY_VERSION,
				commitment,
				committed_at: ctx.now(),
			},
			ctx,
		);
		const rev = await revealVerifier(state, bad.verifier_id, reference, "wrong-nonce", ctx);
		check(!rev.admissible, "invalid reveal must be inadmissible");
		state = rev.state;
		check(
			state.ended_verifiers?.[bad.verifier_id] === "invalid reveal",
			"verifier must be ended after invalid reveal",
		);
		log(`verifier-4-invalid: wrong nonce → VERIFIER_REPORT_INADMISSIBLE; participation ENDED`);
		const retry = await revealVerifier(state, bad.verifier_id, reference, realNonce, ctx);
		check(!retry.admissible, "no retry with a rewritten opinion");
		state = retry.state;
		log(`  second reveal (correct nonce) → still inadmissible: no retry, as frozen`);
	}

	/* ================= [8] VERDICT SEAM ================= */
	section("8/11", "VERDICT SEAM — eligibility gates → dominance");
	const allConflicts = reconcileClaims(state.claims);
	const blastRadius = (cid: string): number => {
		const ids = new Set([workIds[cid]]);
		return allConflicts.filter(
			(r) =>
				(r.risk === "RED" || r.risk === "BLOCKED") && (ids.has(r.claim_a) || ids.has(r.claim_b)),
		).length;
	};
	const changeSurface = (cid: string): number => {
		const tree = candidateTrees[cid];
		return Object.keys(tree).filter((k) => tree[k] !== baselineTree[k]).length;
	};
	// NOTE: the caller names candidates and supplies the control-plane
	// dominance dimensions (blast_radius, change_surface) — the EVIDENCE
	// (evaluation bundles) is resolved from the authority's own stored
	// state inside runVerdictSeam, never from caller-supplied objects.
	const candidates: CandidateEvidence[] = contenderIds.map((cid) => ({
		contender_id: cid,
		candidate_sha: candidateShas[cid],
		blast_radius: blastRadius(cid),
		change_surface: changeSurface(cid),
	}));
	for (const c of candidates) {
		log(`${c.contender_id}: blast_radius=${c.blast_radius} (RED/BLOCKED pairs), change_surface=${c.change_surface} file(s)`);
	}
	const vr = await runVerdictSeam(state, candidates, ctx);
	state = vr.state;
	const record = vr.record;
	log(`verdict: ${record.state}`);
	for (const reason of record.reasons) log(`  - ${reason}`);
	// Show the (now correctly resolved) blind-verifier tally for the log.
	const tally = tallyVotes(state.verdict_reports, [candidateShas["contender-1"], candidateShas["contender-2"]], state.candidate_labels);
	for (const [sha, t] of Object.entries(tally)) {
		log(`  votes for ${short(sha)}: ${t.accepts} accept / ${t.rejects} reject / ${t.abstains} abstain`);
	}
	check(record.state === "ACCEPT", `verdict must be ACCEPT (got ${record.state})`);
	check(record.winner_sha === candidateShas["contender-1"], "winner must be contender-1's SHA");
	log(`ASSERT: ACCEPT with winner = contender-1 (${short(record.winner_sha as string)})`);
	log(`  (contender-3 excluded: quarantined; contender-2 ineligible: hidden_oracle failed)`);

	/* ================= [9] PERMIT + PROMOTION ================= */
	section("9/11", "PERMIT + PROMOTION — exact-state, single-use");
	const canonicalRepo = await fake.get("canonical");
	const canonicalHeadBefore = await canonicalRepo.getHead();
	check(canonicalHeadBefore === baseline, "canonical head must still be the baseline");
	const ip = await issuePermit(state, record.winner_sha as string, "canonical", canonicalHeadBefore as string, ctx);
	state = ip.state;
	const permit = ip.permit;
	log(`permit issued: ${permit.permit_id}`);
	log(`  binds task + baseline + winning tree + eval bundle + policy + expected destination head`);

	// First presentation → PROMOTED.
	const winnerTree = state.evaluations[record.winner_sha as string].tree_sha256;
	const a1 = await attemptPromotion(state, permit.permit_id, canonicalHeadBefore as string, winnerTree, ctx);
	state = a1.state;
	check(a1.outcome === "PROMOTED", `first attempt must PROMOTE (got ${a1.outcome})`);
	log(`attemptPromotion #1 → ${a1.outcome}`);
	let promotedSha = "";
	for (const e of a1.effects) {
		if (e.kind === "canonical_write") {
			// The promotion service is the ONLY canonical writer (spec 3 §2).
			// The write preserves the candidate commit BIT-FOR-BIT (same
			// parents, tree, message → same SHA, as in real git): what was
			// reviewed at SHA X is what ships at SHA X. verifyBundle's
			// "candidate digest" line checks exactly this — no substitution
			// between review and ship (spec 3 §6 attack #7).
			log(`  executing canonical_write effect via the promotion service (sole canonical writer)`);
			log(`  promotion preserves the reviewed commit bit-for-bit (same parents/tree/message → same SHA, as in real git)`);
			promotedSha = await fake.adminPush({
				repo: "canonical",
				ref: "main",
				tree: candidateTrees["contender-1"],
				message: candidateMessages["contender-1"],
				parents: [canonicalHeadBefore as string],
			});
			check(promotedSha === (record.winner_sha as string), "promoted commit must be the reviewed candidate commit (no substitution)");
		}
	}
	check(promotedSha !== "", "canonical_write effect must have executed");
	const headAfterPromote = await canonicalRepo.getHead();
	log(`canonical head: ${short(canonicalHeadBefore as string)} → ${short(headAfterPromote as string)}`);

	// Replay: same permit_id again → ALREADY_CONSUMED, head must not move.
	const a2 = await attemptPromotion(state, permit.permit_id, headAfterPromote as string, winnerTree, ctx);
	state = a2.state;
	check(a2.outcome === "ALREADY_CONSUMED", `replay must be ALREADY_CONSUMED (got ${a2.outcome})`);
	check(a2.effects.length === 0, "replay must produce no effects");
	const headAfterReplay = await canonicalRepo.getHead();
	check(headAfterReplay === headAfterPromote, "canonical head must not move on permit replay");
	log(`attemptPromotion #2 (replay) → ${a2.outcome}; canonical head unchanged (${short(headAfterReplay as string)})`);
	log(`ASSERT: permit replay is a no-op ACK; no duplicate promotion`);

	/* ================= [10] ATTESTATION ================= */
	section("10/11", "ATTESTATION — in-toto chain → signed promotion bundle");
	const winnerSha = record.winner_sha as string;
	const winnerBundle = state.evaluations[winnerSha];
	const testConfigDigest = await sha256Hex(
		canonicalJson({
			visible: ["expired token (100,200) -> true", "valid token (300,200) -> false"],
			hidden: ["boundary (200,200) -> true", "zero (0,0) -> true"],
			policy: "slice-eval-policy/0.1.0",
		}),
	);
	const link = await buildLinkStatement({
		baselineCommit: baseline,
		candidateCommit: winnerSha,
		treeSha256: winnerTree,
	});
	const testResult = await buildTestResultStatement({
		treeSha256: winnerTree,
		candidateCommit: winnerSha,
		testConfigDigest,
		result: "PASS",
	});
	const verificationResult = await buildVerificationResultStatement({
		treeSha256: winnerTree,
		candidateCommit: winnerSha,
		policySha256: selectorPolicyHash,
		result: "PASSED",
	});
	const authority = await buildPromotionAuthority({
		taskHash: task_hash,
		baselineCommit: baseline,
		candidateRepo: forkNames["contender-1"],
		candidateCommit: winnerSha,
		treeSha256: winnerTree,
		evaluationBundleHash: winnerBundle.bundle_hash,
		verificationResult: "PASSED",
		policySha256: selectorPolicyHash,
		destinationRepo: "canonical",
		expectedParent: canonicalHeadBefore as string,
		nonce: permit.nonce,
		permitId: permit.permit_id,
		issuedAt: permit.issued_at,
	});
	const statements = [];
	for (const st of [link, testResult, verificationResult, authority]) {
		statements.push(await signEnvelope(st, signer));
	}
	log(`signed 4 DSSE envelopes (link → test result → verification result → promotion authority)`);
	const bundle: PromotionBundle = {
		version: 1,
		statements,
		ship: {
			repo: "canonical",
			commit: promotedSha,
			tree_sha256: winnerTree,
			parent: canonicalHeadBefore as string,
			permit_id: permit.permit_id,
		},
		ledger_hashes: [permit.permit_id],
		authority_pubkey_der_hex: signer.publicKeyDerHex,
	};
	// Sanity: the bundle verifies with the full signer before writing.
	const pre = await verifyBundle(bundle, signer, { policyHash: selectorPolicyHash });
	check(pre.verified, `bundle must verify before writing (failing: ${pre.lines.filter((l) => l.status === "FAIL").map((l) => l.label).join(", ")})`);
	await mkdir(outDir, { recursive: true });
	const bundlePath = path.resolve(outDir, "promotion.bundle");
	await writeFile(bundlePath, JSON.stringify(bundle, null, 2));
	log(`promotion bundle written to ${bundlePath}`);

	/* ================= [11] OFFLINE VERIFY ================= */
	section("11/11", "OFFLINE VERIFY — $ verify promotion.bundle");
	// Invoke the real CLI as a subprocess (the same command an operator runs).
	const { stdout, stderr } = await execFileAsync(
		process.execPath,
		[path.resolve("src/cli/verify.ts"), bundlePath],
		{ cwd: path.resolve(".") },
	).catch((e: { stdout?: string; stderr?: string; message?: string }) => {
		throw new Error(`verify CLI failed: ${e.message}\nstdout: ${e.stdout}\nstderr: ${e.stderr}`);
	});
	if (stderr.trim() !== "") log(`verify stderr: ${stderr.trim()}`);
	log(`$ node src/cli/verify.ts ${path.relative(".", bundlePath)}`);
	for (const line of stdout.split("\n")) log(`  ${line}`);
	check(stdout.trimEnd().endsWith("VERIFIED"), "verify CLI transcript must end with VERIFIED");
	check(!stdout.includes("FAIL") && !stdout.includes("NOT VERIFIED"), "verify CLI must show no FAIL");

	return {
		taskId: task_id,
		taskHash: task_hash,
		baseline,
		candidateShas,
		verdictState: record.state,
		winnerSha,
		promotionOutcome: a1.outcome,
		replayOutcome: a2.outcome,
		permitId: permit.permit_id,
		bundlePath,
		verified: true,
	};
}

/* ------------------------------------------------------------------ */
/* CLI entry: `node src/harness/slice.ts`                              */
/* ------------------------------------------------------------------ */

function isMainModule(): boolean {
	const arg = process.argv[1];
	if (!arg) return false;
	try {
		return pathToFileURL(path.resolve(arg)).href === import.meta.url;
	} catch {
		return false;
	}
}

if (isMainModule()) {
	runSlice({})
		.then(() => {
			console.log("\nSLICE OK");
		})
		.catch((e) => {
			console.error(`\nSLICE FAILED: ${(e as Error).message}`);
			process.exit(1);
		});
}
