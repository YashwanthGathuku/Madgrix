/**
 * Resolution hardening, round 4: witness runner key required (fail closed),
 * proof stored and re-checked offline, proof bound to file contents, key
 * rotation and revocation, sandboxed witness replays, config includes and
 * worktree admin files watched, bounded rebase-retry after a lost CAS.
 * Local only (git, bash, bubblewrap).
 * node --test test/resolution-hardening-v4.test.ts
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

import { MainMovedError, loadForkCrew, runCrewOnFork } from "../scripts/lib/fork-crew.mjs";
import { governCrewResult } from "../scripts/lib/governed-resolution.mjs";
import { bubblewrapAvailable, setBubblewrapAvailableForTest } from "../scripts/lib/sandbox.mjs";
import { parseWitnessRunnerKeys, witnessKeyId } from "../src/lib/admission-proof.ts";
import { verifyBundle, type PromotionBundle } from "../src/lib/attestation.ts";
import { canonicalJson } from "../src/lib/canonical.ts";
import { SELECTOR_POLICY_INPUT } from "../src/do/TaskAuthority.ts";
import { assumeCompleteMergeArtifactScan } from "../src/lib/merge-artifacts.ts";
import { createEd25519Signer as authoritySigner } from "../src/lib/signer-node.ts";
import { treeDigestV1 } from "../src/lib/tree-digest.ts";
import { freezeWitnesses, loadWitnesses } from "../scripts/lib/witness.mjs";
import { sha256Hex } from "../src/lib/canonical.ts";
import { generateKeyPairSync } from "node:crypto";
import { witnessSignerFromKey } from "../scripts/lib/admission.mjs";
import { attemptPromotion, createAuthority, issuePermit, recordComposition, recordPromotionBundle, runVerdictSeam, submitEvaluation, type Ctx } from "../src/lib/task-state.ts";
import type { AuthorityState, CompositionRecord, EvaluationBundle } from "../src/lib/types.ts";

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
	const repo = tmp("v4-repo-");
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
	const dir = tmp("v4-crew-");
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


const runnerKey = () => witnessSignerFromKey(generateKeyPairSync("ed25519").privateKey);
function authority(baseline: string): AuthorityState {
	const state = createAuthority({ task_id: "t", task_hash: TASK, intent: "i", baseline_repo: "r", baseline_commit: baseline, behavior_contract: "b", policy_version: "seam-policy/0.1.0", frozen_at: "2026-10-20T00:00:00Z" });
	state.contenders.c1 = { contender_id: "c1", agent_id: "parent", fork_repo: "f", fork_lineage: { parent_repo: "r", parent_commit: baseline }, fork_base: baseline, token_id: "tok", status: "forked", claim_work_id: null, latest_commit: null };
	return state;
}
async function ctxFor(keys: string[], revoked: string[] = [], insecure = false): Promise<Ctx> {
	return {
		now: () => "2026-10-20T00:00:00.000Z",
		randomHex: (n) => "e".repeat(n * 2),
		sha256Hex,
		selectorPolicyHash: "p",
		policyVersion: "seam-policy/0.1.0",
		witnessRunnerKeys: await parseWitnessRunnerKeys(keys.join(","), revoked.join(",")),
		insecureUnpinnedWitnessRunner: insecure,
	};
}
async function recordAll(state: AuthorityState, records: CompositionRecord[], ctx: Ctx) {
	for (const r of records) state = await recordComposition(state, r, ctx);
	return state;
}
async function treeDigest(repo: string, sha: string) {
	const entries = git(repo, ["ls-tree", "-r", "--full-tree", sha]).split("\n").filter(Boolean).map((line) => {
		const [meta, file] = line.split("\t");
		const [mode, type, id] = meta.split(" ");
		return { mode, type, path: file, bytes: new Uint8Array(spawnSync("git", ["cat-file", "blob", id], { cwd: repo }).stdout) };
	});
	const d = await treeDigestV1(entries);
	assert.ok(d.ok);
	return d.digest;
}
/** Record, evaluate, permit, promote and sign a resolved candidate; returns the bundle and how to verify it. */
async function promote(repo: string, records: CompositionRecord[], ctx: Ctx, opts: { tree?: string } = {}) {
	const baseline = records[0].baseline;
	let state = await recordAll(authority(baseline), records, ctx);
	const sha = state.composition?.candidate_sha as string;
	state.contenders.c1 = { ...state.contenders.c1, latest_commit: sha };
	const tree = opts.tree ?? (await treeDigest(repo, sha));
	const evidence = assumeCompleteMergeArtifactScan({
		candidate_sha: sha, tree_sha256: tree, contender_id: "c1", task_hash: TASK,
		admission: { exact_baseline: true, scope_compliance: true, valid_tool_states: true, no_eval_tampering: true, provenance_complete: true },
		hidden_oracle: { passed: true, total: 1, failed: [] as string[] }, regressions: { passed: true, total: 1, failed: [] as string[] },
		static_analysis: { passed: true, findings: [] as string[] }, semantic_checks: { passed: true, total: 1, failed: [] as string[] },
		security_policy: { passed: true, findings: [] as string[] }, evaluated_at: "2026-10-20T00:00:00.000Z", tainted: false,
	});
	const bundle = { ...(evidence as EvaluationBundle), bundle_hash: await sha256Hex(canonicalJson(evidence)) };
	state = (await submitEvaluation(state, bundle, { zone: "evaluation_domain" }, ctx)).state;
	const seam = await runVerdictSeam(state, [{ contender_id: "c1", candidate_sha: sha, blast_radius: 1, change_surface: 1 }], ctx);
	const permit = await issuePermit(seam.state, sha, "r", baseline, ctx);
	assert.equal(permit.outcome, "ISSUED");
	const id = permit.permit?.permit_id as string;
	const promoted = await attemptPromotion(permit.state, id, baseline, tree, ctx);
	assert.equal(promoted.outcome, "PROMOTED");
	const signer = authoritySigner();
	const signed = await recordPromotionBundle(promoted.state, id, { commit: sha, parent: baseline }, signer, ctx);
	return { state: signed.state, bundle: signed.bundle, signer, pin: { policyHash: "p", trustedKeyDerHex: signer.publicKeyDerHex } };
}
const resolutionLine = (r: { lines: Array<{ label: string; status: string; detail?: string }> }) => r.lines.find((l) => l.label === "resolution");

describe("round 4 item 1: the authority requires a pinned witness runner key", () => {
	it("refuses COMPOSED and RESOLVED with no key pinned; only the insecure dev opt-in accepts, with a warning", async () => {
		const repo = mkRepo({ "a.js": "x = 0\n" });
		const c = await conflict(repo);
		const g = await govern(repo, c);
		const [conflicted, resolved] = g.compositions as CompositionRecord[];
		const base = await recordComposition(authority(c.run.baseline), conflicted, await ctxFor([]));
		await assert.rejects(recordComposition(base, resolved, await ctxFor([])), /no witness runner key is pinned; refusing to record RESOLVED/);
		const warnings: string[] = [];
		const warn = console.warn;
		console.warn = (m: string) => warnings.push(String(m));
		try {
			const ok = await recordComposition(base, resolved, await ctxFor([], [], true));
			assert.equal(ok.composition?.status, "RESOLVED");
			assert.equal(ok.composition?.admission_proof, undefined, "nothing unverified is stored");
		} finally {
			console.warn = warn;
		}
		assert.ok(warnings.length <= 1);
		const repo2 = mkRepo({ "a.js": "a\n", "b.js": "b\n" });
		const run = await runCrewOnFork(repo2, loadForkCrew(mkCrew([{ id: "s1", command: "echo A > a.js" }, { id: "s2", command: "echo B > b.js" }])), undefined, noGate);
		const composed = (await governCrewResult(repo2, run, { taskHash: TASK, contenderId: "c1", witnesses: null, frozen: null, mode: "command" })).compositions[0] as CompositionRecord;
		await assert.rejects(recordComposition(authority(run.baseline), composed, await ctxFor([])), /refusing to record COMPOSED/);
	});

	it("the Durable Object reads its keys and the opt-in from the environment", async () => {
		assert.equal(await parseWitnessRunnerKeys(""), null);
		assert.equal(await parseWitnessRunnerKeys(undefined), null);
		await assert.rejects(parseWitnessRunnerKeys("not-hex"), /not hex/);
		const k = await runnerKey();
		const parsed = await parseWitnessRunnerKeys(` ${k.publicKeySpkiHex} ,`, "wr-dead");
		assert.deepEqual(parsed, { keys: [{ key_id: k.keyId, public_key: k.publicKeySpkiHex }], revoked: ["wr-dead"] });
	});
});

describe("round 4 item 2: the proof is stored in the ledger and re-checked by offline verify", () => {
	it("VERIFIED with the runner key pinned; NOT VERIFIED without it, or when the proof is stripped or tampered", async () => {
		const repo = mkRepo({ "a.js": "x = 0\n" });
		const c = await conflict(repo);
		const runner = await runnerKey();
		const g = await govern(repo, c, { witnessSigner: runner });
		assert.equal(g.status, "RESOLVED");
		const ctx = await ctxFor([runner.publicKeySpkiHex]);
		const { state, bundle, signer, pin } = await promote(repo, g.compositions as CompositionRecord[], ctx);
		// Stored with the composition, hashed into composition_recorded, and carried in the resolution payload.
		assert.ok(state.composition?.admission_proof);
		assert.ok(bundle.resolution?.admission_proof);
		const keys = ctx.witnessRunnerKeys;
		const good = await verifyBundle(bundle, signer, { ...pin, witnessRunnerKeys: keys });
		assert.equal(good.verified, true, JSON.stringify(good.lines.filter((l) => l.status === "FAIL")));
		assert.match(resolutionLine(good)?.status ?? "", new RegExp(`proof ${runner.keyId}$`));

		const noKey = await verifyBundle(bundle, signer, pin);
		assert.equal(noKey.verified, false);
		assert.match(resolutionLine(noKey)?.detail ?? "", /no witness runner key is pinned for verify/);

		const stripped: PromotionBundle = structuredClone(bundle);
		delete stripped.resolution!.admission_proof;
		const s = await verifyBundle(stripped, signer, { ...pin, witnessRunnerKeys: keys });
		assert.equal(s.verified, false);
		assert.match(resolutionLine(s)?.detail ?? "", /recorded 0 times/);

		const forged: PromotionBundle = structuredClone(bundle);
		forged.resolution!.admission_proof!.attestation.signature = Buffer.alloc(64, 1).toString("base64");
		const f = await verifyBundle(forged, signer, { ...pin, witnessRunnerKeys: keys });
		assert.equal(f.verified, false);

		// A bundle whose ledger was produced with the proof but whose proof no longer
		// verifies (re-signed by another key) fails even if a verifier pins that key.
		const other = await runnerKey();
		const wrongPin = await verifyBundle(bundle, signer, { ...pin, witnessRunnerKeys: await parseWitnessRunnerKeys(other.publicKeySpkiHex) });
		assert.equal(wrongPin.verified, false);
		assert.match(resolutionLine(wrongPin)?.detail ?? "", /not pinned/);
	});

	it("the verify CLI needs --witness-key and prints NOT VERIFIED without it", async () => {
		const repo = mkRepo({ "a.js": "x = 0\n" });
		const c = await conflict(repo);
		const runner = await runnerKey();
		const g = await govern(repo, c, { witnessSigner: runner });
		const policy = { ...(await ctxFor([runner.publicKeySpkiHex])), selectorPolicyHash: await sha256Hex(SELECTOR_POLICY_INPUT) };
		const { bundle, signer } = await promote(repo, g.compositions as CompositionRecord[], policy);
		const dir = tmp("v4-cli-");
		writeFileSync(path.join(dir, "b.json"), JSON.stringify(bundle));
		writeFileSync(path.join(dir, "auth.pub"), signer.publicKeyDerHex);
		writeFileSync(path.join(dir, "wr.pub"), runner.publicKeySpkiHex);
		const cli = path.join(here, "../src/cli/verify.ts");
		const env = { PATH: process.env.PATH ?? "" };
		const ok = spawnSync(process.execPath, [cli, "--trust-key", path.join(dir, "auth.pub"), "--witness-key", path.join(dir, "wr.pub"), path.join(dir, "b.json")], { encoding: "utf8", env });
		assert.equal(ok.status, 0, ok.stdout + ok.stderr);
		assert.match(ok.stdout, /\nVERIFIED\n/);
		const bad = spawnSync(process.execPath, [cli, "--trust-key", path.join(dir, "auth.pub"), path.join(dir, "b.json")], { encoding: "utf8", env });
		assert.equal(bad.status, 1);
		assert.match(bad.stdout, /NOT VERIFIED/);
		const revoked = spawnSync(process.execPath, [cli, "--trust-key", path.join(dir, "auth.pub"), "--witness-key", path.join(dir, "wr.pub"), "--revoked-witness-keys", runner.keyId, path.join(dir, "b.json")], { encoding: "utf8", env });
		assert.equal(revoked.status, 1);
		assert.match(revoked.stdout, /NOT VERIFIED/);
	});
});

describe("round 4 item 3: the proof binds file contents, not just the tree id", () => {
	it("the authority walks hashed tree objects to the leased files' blobs; a swapped blob, tree object or digest is refused", async () => {
		const repo = mkRepo({ "src/deep/a.js": "x = 0\n" });
		const subs = [
			{ id: "s1", command: `printf "x = 'A'\\n" > src/deep/a.js`, witness: `grep -q "A" src/deep/a.js` },
			{ id: "s2", command: `printf "x = 'B'\\n" > src/deep/a.js`, witness: `grep -q "B" src/deep/a.js` },
		];
		const c = await conflict(repo, subs);
		const runner = await runnerKey();
		const g = await governCrewResult(repo, c.run, { taskHash: TASK, contenderId: "c1", witnesses: c.witnesses, frozen: c.frozen, mode: "command", command: `printf "x = 'AB'\\n" > src/deep/a.js`, witnessSigner: runner });
		assert.equal(g.status, "RESOLVED");
		const [conflicted, resolved] = g.compositions as CompositionRecord[];
		const proof = resolved.admission_proof!;
		assert.deepEqual(proof.files.map((f) => f.path), ["src/deep/a.js"]);
		assert.equal(proof.files[0].blob, git(repo, ["rev-parse", `${g.candidateSha}:src/deep/a.js`]));
		assert.equal(Object.keys(proof.tree_objects).length, 3, "root, src, src/deep");
		assert.equal(proof.attestation.payload.candidate_tree_digest_v1, await treeDigest(repo, g.candidateSha as string));
		const ctx = await ctxFor([runner.publicKeySpkiHex]);
		const base = await recordComposition(authority(c.run.baseline), conflicted, ctx);
		assert.equal((await recordComposition(base, resolved, ctx)).composition?.status, "RESOLVED");

		const blob = structuredClone(resolved);
		blob.admission_proof!.files[0].blob = git(repo, ["rev-parse", `${c.run.commits[0].sha}:src/deep/a.js`]);
		await assert.rejects(recordComposition(base, blob, ctx), /blob for src\/deep\/a.js is not the candidate tree's/);
		const tree = structuredClone(resolved);
		const [first] = Object.keys(tree.admission_proof!.tree_objects);
		tree.admission_proof!.tree_objects[first] = Buffer.from("40000 x\0" + "\0".repeat(20)).toString("base64");
		await assert.rejects(recordComposition(base, tree, ctx), /does not hash to its id/);
		const missing = structuredClone(resolved);
		missing.admission_proof!.tree_objects = {};
		await assert.rejects(recordComposition(base, missing, ctx), /missing the tree object/);
		const content = structuredClone(resolved);
		content.admission_proof!.files[0].sha256 = "0".repeat(64);
		await assert.rejects(recordComposition(base, content, ctx), /attestation does not verify/);
		const fewer = structuredClone(resolved);
		fewer.admission_proof!.files = [];
		await assert.rejects(recordComposition(base, fewer, ctx), /does not bind exactly the record's files/);
	});

	it("offline verify refuses an attestation whose tree-digest/v1 is not the promoted tree's", async () => {
		const repo = mkRepo({ "a.js": "x = 0\n" });
		const c = await conflict(repo);
		const runner = await runnerKey();
		const g = await govern(repo, c, { witnessSigner: runner });
		const ctx = await ctxFor([runner.publicKeySpkiHex]);
		const { bundle, signer, pin } = await promote(repo, g.compositions as CompositionRecord[], ctx, { tree: "d".repeat(64) });
		const r = await verifyBundle(bundle, signer, { ...pin, witnessRunnerKeys: ctx.witnessRunnerKeys });
		assert.equal(r.verified, false);
		assert.match(resolutionLine(r)?.detail ?? "", /tree-digest\/v1 is not the promoted tree's/);
	});
});

describe("round 4 item 4: several pinned keys, key ids, revocation", () => {
	it("a proof by either pinned key is accepted; a revoked key is refused by the authority and by verify", async () => {
		const repo = mkRepo({ "a.js": "x = 0\n" });
		const c = await conflict(repo);
		const oldKey = await runnerKey();
		const newKey = await runnerKey();
		assert.equal(newKey.keyId, await witnessKeyId(newKey.publicKeySpkiHex));
		assert.match(newKey.keyId, /^wr-[0-9a-f]{32}$/);
		const g = await govern(repo, c, { witnessSigner: newKey });
		const records = g.compositions as CompositionRecord[];
		const both = await ctxFor([oldKey.publicKeySpkiHex, newKey.publicKeySpkiHex]);
		assert.equal((await recordAll(authority(c.run.baseline), records, both)).composition?.status, "RESOLVED");
		const revoked = await ctxFor([oldKey.publicKeySpkiHex, newKey.publicKeySpkiHex], [newKey.keyId]);
		await assert.rejects(recordAll(authority(c.run.baseline), records, revoked), new RegExp(`revoked key ${newKey.keyId}`));
		// Revocation applies to bundles already signed, too (no timestamping: it is not "revoked after").
		const { bundle, signer, pin } = await promote(repo, records, both);
		assert.equal((await verifyBundle(bundle, signer, { ...pin, witnessRunnerKeys: both.witnessRunnerKeys })).verified, true);
		const r = await verifyBundle(bundle, signer, { ...pin, witnessRunnerKeys: revoked.witnessRunnerKeys });
		assert.equal(r.verified, false);
		assert.match(resolutionLine(r)?.detail ?? "", /revoked key/);
		// A key id that claims to be a pinned key but is signed by another key fails the signature.
		const relabel = structuredClone(records[1]);
		relabel.admission_proof!.attestation.key_id = oldKey.keyId;
		await assert.rejects(recordAll(authority(c.run.baseline), [records[0], relabel], both), /does not verify/);
	});
});

describe("round 4 item 5: witness replays run in the sandbox, fail closed", () => {
	it("a witness cannot write outside its checkout, and sees a fresh PID namespace", { skip: !bubblewrapAvailable() && "bubblewrap is not available" }, async () => {
		const marker = path.join(tmp("v4-wmark-"), "ran");
		const repo = mkRepo({ "a.js": "x = 0\n" });
		const subs = [
			{ id: "s1", command: `printf "x = 'A'\\n" > a.js`, witness: `echo hi > ${marker}; [ "$(cat /proc/1/comm)" = bwrap ] && grep -q A a.js` },
			{ id: "s2", command: `printf "x = 'B'\\n" > a.js`, witness: `grep -q B a.js` },
		];
		const c = await conflict(repo, subs);
		assert.equal(existsSync(marker), false, "the witness could not write outside its checkout");
		assert.deepEqual(Object.values(c.frozen.outcomes).map((o) => o.own), ["pass", "pass"]);
	});

	it("refuses to replay when bubblewrap is unavailable, and 'none' needs the explicit opt-in", async () => {
		const repo = mkRepo({ "a.js": "x = 0\n" });
		const cfg = mkCrew(AB());
		const crew = loadForkCrew(cfg);
		const run = await runCrewOnFork(repo, crew, undefined, noGate);
		const witnesses = loadWitnesses(cfg, crew)!;
		setBubblewrapAvailableForTest(false);
		try {
			assert.throws(() => freezeWitnesses(repo, run.baseline, run.commits, witnesses), /refusing to run the witness unsandboxed/);
		} finally {
			setBubblewrapAvailableForTest(null);
		}
		process.env.MADGRIX_WITNESS_SANDBOX = "none";
		try {
			assert.throws(() => freezeWitnesses(repo, run.baseline, run.commits, witnesses), /needs MADGRIX_I_ACCEPT_UNSANDBOXED_RESOLVER=1/);
		} finally {
			delete process.env.MADGRIX_WITNESS_SANDBOX;
		}
	});
});

describe("round 4 item 6: include targets and every worktree admin file are watched", () => {
	const cases: Array<[string, (m: string, inc: string) => string, (repo: string, inc: string) => void]> = [
		["an existing include.path target outside .git", (m, inc) => `printf '[core]\\n\\tfsmonitor = echo ran >> ${m}; false\\n' > ${inc} && echo A > a.js`, (repo, inc) => { writeFileSync(inc, "[user]\n\tname = T\n"); git(repo, ["config", "include.path", inc]); }],
		["an includeIf target that does not exist yet", (m, inc) => `printf '[core]\\n\\tfsmonitor = echo ran >> ${m}; false\\n' > ${inc} && echo A > a.js`, (repo, inc) => git(repo, ["config", `includeIf.gitdir:/nowhere/.path`, inc])],
		["a nested include inside an include target", (m, inc) => `printf '[include]\\n\\tpath = ${inc}.2\\n' >> ${inc} && printf '[core]\\n\\tfsmonitor = echo ran >> ${m}; false\\n' > ${inc}.2 && echo A > a.js`, (repo, inc) => { writeFileSync(inc, "[user]\n\tname = T\n"); git(repo, ["config", "include.path", inc]); }],
		["an attached HEAD in the worktree admin dir", () => `echo 'ref: refs/heads/main' > "$(git rev-parse --git-dir)/HEAD" && echo A > a.js`, () => {}],
		["a new file in the worktree admin dir", () => `echo x > "$(git rev-parse --git-dir)/sparse-hack" && echo A > a.js`, () => {}],
	];
	for (const [name, plant, setup] of cases) {
		it(`${name}: the crew is refused and the file restored`, async () => {
			const repo = mkRepo({ "a.js": "a\n", "b.js": "b\n" });
			const inc = path.join(tmp("v4-inc-"), "inc.cfg");
			setup(repo, inc);
			const incBefore = existsSync(inc) ? readFileSync(inc, "utf8") : null;
			const mainBefore = git(repo, ["rev-parse", "main"]);
			const marker = path.join(tmp("v4-mark-"), "ran");
			const cfg = mkCrew([{ id: "s1", command: plant(marker, inc) }, { id: "s2", command: "echo B > b.js" }]);
			await assert.rejects(runCrewOnFork(repo, loadForkCrew(cfg), undefined, noGate), /a sub-agent changed repository control files/);
			assert.equal(existsSync(marker), false, "the planted code never ran");
			assert.equal(existsSync(inc) ? readFileSync(inc, "utf8") : null, incBefore);
			assert.equal(git(repo, ["rev-parse", "main"]), mainBefore);
		});
	}
	it("ordinary git use in a worktree (status, diff, add) is not mistaken for tampering", async () => {
		const repo = mkRepo({ "a.js": "a\n", "b.js": "b\n" });
		const cfg = mkCrew([{ id: "s1", command: "echo A > a.js && git status --short >/dev/null && git diff >/dev/null && git add a.js" }, { id: "s2", command: "echo B > b.js" }]);
		const run = await runCrewOnFork(repo, loadForkCrew(cfg), undefined, noGate);
		assert.equal(run.status, "COMPOSED");
	});
});

describe("round 4 item 7: a CAS loser rebases onto the new main and is re-verified", () => {
	it("two concurrent COMPOSED crews on different files: both publish, the second rebased onto the first", async () => {
		const repo = mkRepo({ "a.js": "a\n", "b.js": "b\n", "c.js": "c\n", "d.js": "d\n" });
		const crewOf = (x: string, y: string) => loadForkCrew(mkCrew([{ id: `p${x}`, command: `sleep 0.2; echo ${x}${x} > ${x}.js` }, { id: `q${y}`, command: `echo ${y}${y} > ${y}.js` }]));
		const results = await Promise.all([runCrewOnFork(repo, crewOf("a", "b"), undefined, noGate), runCrewOnFork(repo, crewOf("c", "d"), undefined, noGate)]);
		const rebased = results.filter((r) => (r as { rebases?: unknown[] }).rebases?.length);
		assert.equal(rebased.length, 1);
		const main = git(repo, ["rev-parse", "main"]);
		assert.equal(main, (rebased[0] as { sha: string }).sha);
		for (const f of ["a", "b", "c", "d"]) assert.equal(git(repo, ["show", `main:${f}.js`]), `${f}${f}`);
		const other = results.find((r) => r !== rebased[0]) as { sha: string };
		assert.equal(git(repo, ["rev-parse", "main^1"]), other.sha, "the rebased candidate's first parent is the other crew's commit");
	});

	it("a RESOLVED loser is rebased, its witnesses re-run on the new base, and the authority accepts it with rebased_onto", async () => {
		const repo = mkRepo({ "a.js": "x = 0\n", "b.js": "y = 0\n" });
		const first = await conflict(repo);
		const second = await conflict(repo, [
			{ id: "t1", command: `printf "y = 'C'\\n" > b.js`, witness: `grep -q C b.js` },
			{ id: "t2", command: `printf "y = 'D'\\n" > b.js`, witness: `grep -q D b.js` },
		]);
		const runner = await runnerKey();
		const g1 = await govern(repo, first, { witnessSigner: runner });
		assert.equal(g1.status, "RESOLVED");
		const g2 = await governCrewResult(repo, second.run, { taskHash: TASK, contenderId: "c1", witnesses: second.witnesses, frozen: second.frozen, mode: "command", command: `printf "y = 'CD'\\n" > b.js`, witnessSigner: runner });
		assert.equal(g2.status, "RESOLVED", JSON.stringify((g2 as { review?: unknown }).review));
		assert.equal(git(repo, ["rev-parse", "main"]), g2.candidateSha);
		assert.equal(git(repo, ["rev-parse", "main^1"]), g1.candidateSha);
		assert.equal(git(repo, ["show", "main:a.js"]), "x = 'AB'");
		assert.equal(git(repo, ["show", "main:b.js"]), "y = 'CD'");
		const resolved = g2.compositions[1] as CompositionRecord;
		assert.equal(resolved.rebased_onto, g1.candidateSha);
		assert.equal(resolved.baseline, second.run.baseline);
		const ctx = await ctxFor([runner.publicKeySpkiHex]);
		const state = await recordAll(authority(second.run.baseline), g2.compositions as CompositionRecord[], ctx);
		assert.equal(state.composition?.rebased_onto, g1.candidateSha);
		// Dropping rebased_onto breaks the parents check; relabelling it breaks the signature.
		const dropped = structuredClone(resolved);
		delete dropped.rebased_onto;
		await assert.rejects(recordAll(authority(second.run.baseline), [g2.compositions[0] as CompositionRecord, dropped], ctx), /parents are not the baseline/);
	});

	it("a rebased candidate whose witnesses fail on the new base is not published", async () => {
		const repo = mkRepo({ "a.js": "x = 0\n", "b.js": "y = 0\n" });
		const first = await conflict(repo);
		const second = await conflict(repo, [
			{ id: "t1", command: `printf "y = 'C'\\n" > b.js`, witness: `grep -q C b.js && ! grep -q BREAK a.js` },
			{ id: "t2", command: `printf "y = 'D'\\n" > b.js`, witness: `grep -q D b.js` },
		]);
		const g1 = await govern(repo, first, { command: `printf "x = 'AB' BREAK\\n" > a.js` });
		assert.equal(g1.status, "RESOLVED");
		const g2 = await governCrewResult(repo, second.run, { taskHash: TASK, contenderId: "c1", witnesses: second.witnesses, frozen: second.frozen, mode: "command", command: `printf "y = 'CD'\\n" > b.js` });
		assert.equal(g2.status, "REVIEW");
		assert.match((g2 as { review?: { reason?: string } }).review?.reason ?? "", /failed re-verification: witnesses REFUSE/);
		assert.equal(git(repo, ["rev-parse", "main"]), g1.candidateSha);
	});

	it("with MADGRIX_MAIN_REBASE_RETRIES=0 the loser is refused, and a conflicting rebase is refused", async () => {
		const repo = mkRepo({ "a.js": "x = 0\n", "b.js": "y = 0\n" });
		const first = await conflict(repo);
		const second = await conflict(repo, [
			{ id: "t1", command: `printf "y = 'C'\\n" > b.js`, witness: `grep -q C b.js` },
			{ id: "t2", command: `printf "y = 'D'\\n" > b.js`, witness: `grep -q D b.js` },
		]);
		const third = await conflict(repo, AB("3"));
		await govern(repo, first);
		process.env.MADGRIX_MAIN_REBASE_RETRIES = "0";
		try {
			const g2 = await governCrewResult(repo, second.run, { taskHash: TASK, contenderId: "c1", witnesses: second.witnesses, frozen: second.frozen, mode: "command", command: `printf "y = 'CD'\\n" > b.js` });
			assert.equal(g2.status, "REVIEW");
			assert.match((g2 as { review?: { reason?: string } }).review?.reason ?? "", /main moved/);
		} finally {
			delete process.env.MADGRIX_MAIN_REBASE_RETRIES;
		}
		const g3 = await govern(repo, third, { command: `printf "x = 'A3B3'\\n" > a.js` });
		assert.equal(g3.status, "REVIEW");
		assert.match((g3 as { review?: { reason?: string } }).review?.reason ?? "", /does not rebase cleanly/);
		assert.ok(MainMovedError);
	});
});

describe("round 4: a candidate tree-digest/v1 cannot bind is reported, not thrown", () => {
	it("a gitlink in a COMPOSED candidate yields admission_proof_error and no proof; the authority refuses it", async () => {
		const repo = mkRepo({ README: "r\n" });
		const nested = `mkdir -p vendor/x && cd vendor/x && git init -q && echo v > v && git add v && git -c user.email=a@b -c user.name=a commit -qm v`;
		const cfg = mkCrew([
			{ id: "s1", command: nested },
			{ id: "s2", command: `printf "z\\n" > z` },
		]);
		const crew = loadForkCrew(cfg);
		const run = await runCrewOnFork(repo, crew, undefined, noGate);
		const signer = await runnerKey();
		const g = await governCrewResult(repo, run, { taskHash: TASK, contenderId: "c1", witnesses: null, frozen: null, mode: "command", command: GOOD, witnessSigner: signer });
		assert.equal(g.status, "COMPOSED");
		assert.match(String(g.admission_proof_error), /tree-digest\/v1 cannot bind commit vendor\/x/);
		const composed = g.compositions.find((c: CompositionRecord) => c.status === "COMPOSED");
		assert.ok(composed && !("admission_proof" in composed));
		const ctx = await ctxFor([signer.publicKeySpkiHex]);
		await assert.rejects(recordAll(authority(run.baseline), g.compositions, ctx), /requires an admission_proof/);
	});
});
