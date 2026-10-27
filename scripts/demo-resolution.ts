/**
 * Local demo of governed resolution, end to end (no Cloudflare account):
 *
 *   npm run demo:resolution
 *
 * 1. A real fork crew (configs/demo-composition.json) runs on a fresh git
 *    repository. sub-api and sub-ui both rewrite src/contract.js: CONFLICTED.
 * 2. Their witnesses (configs/witnesses/demo/) are frozen before any resolver.
 * 3. A lazy resolver keeps one side. The lease accepts where it wrote; the
 *    witness gate refuses it: sub-api's intent is gone.
 * 4. The repo's scripted resolver (scripts/demo-resolve.mjs) keeps both
 *    intents: ADMIT. The authority records CONFLICTED, then RESOLVED bound to
 *    the capsule.
 * 5. The resolved SHA goes through verdict, permit and promotion in the task
 *    authority, the bundle is signed, and the offline verifier checks it.
 *
 * Like `npm run slice`, steps 5's evaluation evidence and signing key are
 * HARNESS values made here, not an evaluator run or the live authority key.
 * The witness runner key is generated in memory for this run; only its
 * PUBLIC key is written (next to the bundle) and pinned by the authority and
 * by the verifier (--witness-key). No private key is written or committed.
 * Steps 1–4 are the real runner code on real commits.
 */

import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SELECTOR_POLICY_INPUT } from "../src/do/TaskAuthority.ts";
import { canonicalJson, sha256Hex } from "../src/lib/canonical.ts";
import { assumeCompleteMergeArtifactScan } from "../src/lib/merge-artifacts.ts";
import { createEd25519Signer } from "../src/lib/signer-node.ts";
import {
	attemptPromotion,
	createAuthority,
	defaultCtx,
	issuePermit,
	recordComposition,
	recordPromotionBundle,
	runVerdictSeam,
	submitEvaluation,
} from "../src/lib/task-state.ts";
import type { EvaluationBundle } from "../src/lib/types.ts";
import { DEMO_COMPOSITION_CONFIG, loadForkCrew, runCrewOnFork } from "./lib/fork-crew.mjs";
import { governCrewResult } from "./lib/governed-resolution.mjs";
import { witnessSignerFromKey } from "./lib/admission.mjs";
import { parseWitnessRunnerKeys } from "../src/lib/admission-proof.ts";
import { treeDigestV1 } from "../src/lib/tree-digest.ts";
import { freezeWitnesses, loadWitnesses } from "./lib/witness.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.resolve(process.argv[2] ?? ".madgrix-demo");
const log = (line: string) => console.log(`[demo] ${line}`);
for (const [k, v] of Object.entries({
	GIT_AUTHOR_NAME: "Git4agents",
	GIT_AUTHOR_EMAIL: "git4agents@madgrix.invalid",
	GIT_COMMITTER_NAME: "Git4agents",
	GIT_COMMITTER_EMAIL: "git4agents@madgrix.invalid",
})) process.env[k] ??= v;

function git(repo: string, args: string[]): string {
	const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
	return (r.stdout ?? "").trim();
}

const repo = mkdtempSync(path.join(tmpdir(), "madgrix-demo-resolution-"));
try {
	git(repo, ["init", "--quiet", "--initial-branch=main"]);
	writeFileSync(path.join(repo, "README.md"), "baseline\n");
	git(repo, ["add", "-A"]);
	git(repo, ["commit", "--quiet", "-m", "baseline"]);
	const baseline = git(repo, ["rev-parse", "HEAD"]);

	// 1–2. The crew, its frozen witnesses, the conflict.
	const crew = loadForkCrew(DEMO_COMPOSITION_CONFIG);
	const witnesses = loadWitnesses(DEMO_COMPOSITION_CONFIG, crew);
	if (!witnesses) throw new Error("demo crew declares no witnesses");
	log(`crew: ${crew.subs.map((s: { id: string }) => s.id).join(", ")} on one fork; witness manifest ${witnesses.sha256.slice(0, 12)}`);
	const run = await runCrewOnFork(repo, crew);
	log(`TheUstad: ${run.theustad?.final}`);
	log(`composition: ${run.status} on ${run.overlap.join(", ")} (sub-agent commits ${run.commits.map((c: { sha: string }) => c.sha.slice(0, 7)).join(", ")})`);
	const frozen = freezeWitnesses(repo, run.baseline, run.commits, witnesses);
	for (const [key, o] of Object.entries(frozen.outcomes)) log(`witness ${key}: baseline ${o.baseline}, own commit ${o.own}`);

	// HARNESS witness runner key, generated for this run (never written).
	const witnessSigner = await witnessSignerFromKey(generateKeyPairSync("ed25519").privateKey);
	const ctx = { ...defaultCtx(await sha256Hex(SELECTOR_POLICY_INPUT)), witnessRunnerKeys: await parseWitnessRunnerKeys(witnessSigner.publicKeySpkiHex) };
	log(`witness runner key ${witnessSigner.keyId} (HARNESS, in memory; pinned by the authority and the verifier)`);
	const taskHash = await sha256Hex("demo: compose api, ui and an integration check");

	// 3. A lazy resolver.
	const lazy = await governCrewResult(repo, run, {
		taskHash,
		contenderId: "contender-demo",
		witnesses,
		frozen,
		mode: "command",
		command: "printf '%s\\n' 'export const label = \"ui\";' > src/contract.js",
	});
	const lazyWitness = "review" in lazy ? lazy.review?.candidates[0]?.witness : null;
	log(
		`lazy resolver (keeps "ui"): witnesses ${lazyWitness?.verdict ?? "n/a"} → ${lazy.status}, nothing recorded — ` +
			`${lazyWitness?.report.reasons.join("; ") ?? "no candidate"}`,
	);

	// 4. The scripted resolver that keeps both intents.
	const governed = await governCrewResult(repo, run, {
		taskHash,
		contenderId: "contender-demo",
		witnesses,
		frozen,
		mode: "command",
		command: `node ${JSON.stringify(path.join(repoRoot, "scripts/demo-resolve.mjs"))}`,
		witnessSigner,
	});
	if (governed.status !== "RESOLVED" || !governed.candidateSha) throw new Error(`expected RESOLVED, got ${governed.status}`);
	const sha = governed.candidateSha;
	log(`demo resolver: RESOLVED ${sha.slice(0, 12)}; src/contract.js = ${git(repo, ["show", `${sha}:src/contract.js`])}`);
	log(`capsule ${"capsule" in governed ? governed.capsule?.capsule_id.slice(0, 12) : "?"}; witnesses ADMIT`);

	// The task authority: CONFLICTED, then RESOLVED bound to the capsule.
	let state = createAuthority({
		task_id: "demo-resolution",
		task_hash: taskHash,
		intent: "compose api, ui and an integration check",
		baseline_repo: "demo/repo",
		baseline_commit: baseline,
		behavior_contract: "the label keeps api and ui",
		policy_version: ctx.policyVersion,
		frozen_at: new Date().toISOString(),
	});
	state.contenders["contender-demo"] = {
		contender_id: "contender-demo",
		agent_id: "parent",
		fork_repo: "demo/fork",
		fork_lineage: { parent_repo: "demo/repo", parent_commit: baseline },
		fork_base: baseline,
		token_id: "tok-demo",
		status: "forked",
		claim_work_id: null,
		latest_commit: sha,
	};
	for (const composition of governed.compositions) {
		state = await recordComposition(state, composition, ctx);
		log(`authority recorded ${composition.status}${state.composition?.capsule_id ? ` (capsule ${state.composition.capsule_id.slice(0, 12)})` : ""}`);
	}

	// 5. HARNESS evaluation evidence, verdict, permit, promotion, signed bundle.
	// tree-digest/v1 of the candidate (what promote.sh computes), which the
	// witness attestation also names.
	const entries = git(repo, ["ls-tree", "-r", "--full-tree", sha]).split("\n").filter(Boolean).map((line) => {
		const [meta, file] = line.split("\t");
		const [mode, type, id] = meta.split(" ");
		const blob = spawnSync("git", ["cat-file", "blob", id], { cwd: repo });
		return { mode, type, path: file, bytes: new Uint8Array(blob.stdout) };
	});
	const digest = await treeDigestV1(entries);
	if (!digest.ok) throw new Error("demo tree has a non-blob entry");
	const tree = digest.digest;
	const evidence = assumeCompleteMergeArtifactScan({
		candidate_sha: sha,
		tree_sha256: tree,
		contender_id: "contender-demo",
		task_hash: taskHash,
		admission: { exact_baseline: true, scope_compliance: true, valid_tool_states: true, no_eval_tampering: true, provenance_complete: true },
		hidden_oracle: { passed: true, total: 2, failed: [] as string[] },
		regressions: { passed: true, total: 1, failed: [] as string[] },
		static_analysis: { passed: true, findings: [] as string[] },
		semantic_checks: { passed: true, total: 1, failed: [] as string[] },
		security_policy: { passed: true, findings: [] as string[] },
		evaluated_at: new Date().toISOString(),
		tainted: false,
	});
	const bundle: EvaluationBundle = { ...(evidence as EvaluationBundle), bundle_hash: await sha256Hex(canonicalJson(evidence)) };
	state = (await submitEvaluation(state, bundle, { zone: "evaluation_domain" }, ctx)).state;
	const seam = await runVerdictSeam(state, [{ contender_id: "contender-demo", candidate_sha: sha, blast_radius: 1, change_surface: 1 }], ctx);
	log(`verdict seam: ${seam.record.state} (harness evaluation evidence)`);
	const permit = await issuePermit(seam.state, sha, "demo/repo", baseline, ctx);
	if (permit.outcome !== "ISSUED" || !permit.permit) throw new Error(`permit ${permit.outcome}`);
	const promoted = await attemptPromotion(permit.state, permit.permit.permit_id, baseline, tree, ctx);
	log(`promotion: ${promoted.outcome} ${sha.slice(0, 12)} (authority state; no remote repository is written)`);
	const signer = createEd25519Signer();
	const signed = await recordPromotionBundle(promoted.state, permit.permit.permit_id, { commit: sha, parent: baseline }, signer, ctx);

	mkdirSync(outDir, { recursive: true });
	const bundlePath = path.join(outDir, "resolution.bundle");
	const keyPath = path.join(outDir, "harness-authority.pub");
	writeFileSync(bundlePath, `${JSON.stringify(signed.bundle, null, 2)}\n`);
	writeFileSync(keyPath, `${signer.publicKeyDerHex}\n`);
	const witnessKeyPath = path.join(outDir, "witness-runner.pub");
	writeFileSync(witnessKeyPath, `${witnessSigner.publicKeySpkiHex}\n`);
	log(`bundle ${path.relative(repoRoot, bundlePath)}; HARNESS authority key ${path.relative(repoRoot, keyPath)}`);
	log(`$ node src/cli/verify.ts --trust-key ${path.relative(repoRoot, keyPath)} --witness-key ${path.relative(repoRoot, witnessKeyPath)} ${path.relative(repoRoot, bundlePath)}`);
	const verify = spawnSync(process.execPath, [path.join(repoRoot, "src/cli/verify.ts"), "--trust-key", keyPath, "--witness-key", witnessKeyPath, bundlePath], { encoding: "utf8" });
	process.stdout.write(verify.stdout);
	if (verify.status !== 0) {
		process.stderr.write(verify.stderr);
		process.exitCode = 1;
	}
} finally {
	rmSync(repo, { recursive: true, force: true });
}
