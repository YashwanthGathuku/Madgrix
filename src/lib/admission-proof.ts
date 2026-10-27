/**
 * Admission proof (specs/amendments/admission-proof-v1.md, v2 payload).
 *
 * The authority cannot run witnesses or read git objects. It pins one or
 * more witness runner keys (`Ctx.witnessRunnerKeys`, each with a key id, plus
 * a list of revoked key ids). A COMPOSED or RESOLVED record must carry
 * `admission_proof`:
 *
 * - `commit_object`: the candidate's raw git commit object (base64). Its
 *   SHA-1 object id must equal `candidate_sha`, and its parents must be the
 *   baseline and the contributing SHAs. A made-up candidate SHA has no such
 *   object.
 * - `tree_objects`: raw git tree objects (base64, keyed by object id) from the
 *   commit's root tree down to every bound file. Each is hashed, so the path
 *   walk proves which blob id (and mode) each bound file has in the candidate.
 * - `files`: the bound files (RESOLVED: the leased, conflicted paths;
 *   COMPOSED: the record's files), each with mode, git blob id and the
 *   SHA-256 of its bytes.
 * - `attestation`: an Ed25519 signature by a pinned, unrevoked runner key over
 *   a payload the authority rebuilds from its own record: task, contender,
 *   baseline, contributing SHAs, candidate SHA and tree, capsule, manifest,
 *   witness report digest and verdict (or none), the bound files, and the
 *   candidate's tree-digest/v1 (SHA-256 of every file's bytes).
 *
 * What is proven by hashing: candidate SHA → commit → tree → blob ids of the
 * bound files. What only the runner key vouches for: the witness report and
 * verdict, the per-file SHA-256 and the tree-digest/v1. Offline verify checks
 * the tree-digest/v1 against the promoted tree digest the bundle signs.
 */
import { canonicalJson } from "./canonical.ts";

export const WITNESS_ATTESTATION_FORMAT = "madgrix-witness-attestation/v2";

export interface BoundFile {
	path: string;
	mode: string;
	/** git blob id (SHA-1) */
	blob: string;
	/** SHA-256 of the file's bytes (runner-attested) */
	sha256: string;
}

export interface WitnessAttestationPayload {
	format: typeof WITNESS_ATTESTATION_FORMAT;
	key_id: string;
	task_hash: string;
	contender_id: string;
	baseline: string;
	rebased_onto: string | null;
	contributing_shas: string[];
	candidate_sha: string;
	candidate_tree: string;
	candidate_tree_digest_v1: string;
	capsule_id: string | null;
	witness_manifest_sha256: string | null;
	witness_report_sha256: string | null;
	verdict: "ADMIT" | "REVIEW" | "NONE";
	review_cleared_by: string | null;
	files: BoundFile[];
}

export interface AdmissionProof {
	/** Raw git commit object body, base64. */
	commit_object: string;
	/** Raw git tree object bodies, base64, keyed by object id. */
	tree_objects: Record<string, string>;
	files: BoundFile[];
	attestation: { key_id: string; payload: WitnessAttestationPayload; signature: string };
}

export interface WitnessRunnerKey {
	key_id: string;
	/** SPKI DER, hex */
	public_key: string;
}

export interface WitnessRunnerKeys {
	keys: WitnessRunnerKey[];
	/** Key ids that must no longer be accepted (compromised or retired). */
	revoked: string[];
}

const enc = new TextEncoder();
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

export function attestationBytes(payload: WitnessAttestationPayload): Uint8Array {
	return enc.encode(canonicalJson(payload));
}

function fromBase64(text: string): Uint8Array {
	const bin = atob(text);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
	return out;
}

function hex(bytes: ArrayBuffer | Uint8Array): string {
	return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(text: string): Uint8Array {
	if (!/^(?:[0-9a-f]{2})+$/i.test(text)) throw new Error("not hex");
	const out = new Uint8Array(text.length / 2);
	for (let i = 0; i < out.length; i += 1) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
	return out;
}

/** Key id of a witness runner key: "wr-" + the first 16 bytes of SHA-256(SPKI DER), hex. */
export async function witnessKeyId(publicKeySpkiHex: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", fromHex(publicKeySpkiHex.trim().toLowerCase()) as unknown as BufferSource);
	return `wr-${hex(digest).slice(0, 32)}`;
}

/**
 * Pinned keys from configuration text: SPKI hex keys separated by commas or
 * whitespace, and revoked key ids likewise. Empty text pins nothing.
 */
export async function parseWitnessRunnerKeys(keysText: string | null | undefined, revokedText?: string | null): Promise<WitnessRunnerKeys | null> {
	const raw = (keysText ?? "").split(/[\s,]+/).map((k) => k.trim().toLowerCase()).filter(Boolean);
	if (raw.length === 0) return null;
	const keys: WitnessRunnerKey[] = [];
	for (const key of raw) {
		if (!/^(?:[0-9a-f]{2})+$/.test(key)) throw new Error("witness runner key is not hex SPKI DER");
		keys.push({ key_id: await witnessKeyId(key), public_key: key });
	}
	const revoked = (revokedText ?? "").split(/[\s,]+/).map((k) => k.trim()).filter(Boolean);
	return { keys, revoked };
}

async function gitObjectId(type: "commit" | "tree", body: Uint8Array): Promise<string> {
	const header = enc.encode(`${type} ${body.length}\0`);
	const full = new Uint8Array(header.length + body.length);
	full.set(header, 0);
	full.set(body, header.length);
	return hex(await crypto.subtle.digest("SHA-1", full as unknown as BufferSource));
}

/** Git object id (SHA-1) of a commit object body. */
export function gitCommitId(body: Uint8Array): Promise<string> {
	return gitObjectId("commit", body);
}

/** Tree and parents from a commit object body (header lines only). */
export function parseCommitObject(body: Uint8Array): { tree: string; parents: string[] } {
	const text = new TextDecoder().decode(body);
	const end = text.indexOf("\n\n");
	const head = (end === -1 ? text : text.slice(0, end)).split("\n");
	let tree = "";
	const parents: string[] = [];
	for (const line of head) {
		if (line.startsWith("tree ")) tree = line.slice(5);
		else if (line.startsWith("parent ")) parents.push(line.slice(7));
	}
	if (!HEX40.test(tree)) throw new Error("admission proof: commit object has no tree");
	return { tree, parents };
}

/** Entries of a raw git tree object: `<mode> <name>\0<20-byte id>` repeated. */
export function parseTreeObject(body: Uint8Array): Array<{ mode: string; name: string; id: string }> {
	const out: Array<{ mode: string; name: string; id: string }> = [];
	const dec = new TextDecoder();
	let i = 0;
	while (i < body.length) {
		const space = body.indexOf(0x20, i);
		const nul = body.indexOf(0, space + 1);
		if (space === -1 || nul === -1 || nul + 21 > body.length) throw new Error("admission proof: malformed tree object");
		out.push({ mode: dec.decode(body.subarray(i, space)), name: dec.decode(body.subarray(space + 1, nul)), id: hex(body.subarray(nul + 1, nul + 21)) });
		i = nul + 21;
	}
	return out;
}

export async function verifyEd25519(publicKeySpkiHex: string, payload: Uint8Array, signatureBase64: string): Promise<boolean> {
	try {
		const key = await crypto.subtle.importKey("spki", fromHex(publicKeySpkiHex) as unknown as BufferSource, { name: "Ed25519" }, false, ["verify"]);
		return await crypto.subtle.verify({ name: "Ed25519" }, key, fromBase64(signatureBase64) as unknown as BufferSource, payload as unknown as BufferSource);
	} catch {
		return false;
	}
}

export interface AdmissionExpectation {
	task_hash: string;
	contender_id: string;
	baseline: string;
	/** Set when the candidate was rebased onto a newer main: its first parent. */
	rebased_onto: string | null;
	contributing_shas: string[];
	candidate_sha: string;
	capsule_id: string | null;
	witness_manifest_sha256: string | null;
	/** The verdict the record claims, or null when it carries none. */
	witness: { witness_report_sha256: string; verdict: string; review_cleared_by: string | null } | null;
	/** Paths whose contents the proof must bind. */
	bound_paths: string[];
	/** When known (offline verify): the promoted tree-digest/v1 the attestation must name. */
	tree_digest_v1?: string | null;
}

/**
 * Throws unless `raw` proves `expected` under one of the pinned, unrevoked
 * keys. Returns the proof in normalized form, for storage.
 * `label` prefixes error messages ("recordComposition", "verify").
 */
export async function verifyAdmissionProof(
	raw: unknown,
	expected: AdmissionExpectation,
	pinned: WitnessRunnerKeys,
	label = "recordComposition",
): Promise<AdmissionProof> {
	const fail = (msg: string): never => {
		throw new Error(`${label}: ${msg}`);
	};
	if (typeof raw !== "object" || raw === null) fail("a pinned witness runner key requires an admission_proof");
	const proof = raw as Partial<AdmissionProof>;
	if (typeof proof.commit_object !== "string" || proof.commit_object === "") fail("admission_proof has no commit object");
	let body: Uint8Array = new Uint8Array();
	try {
		body = fromBase64(proof.commit_object as string);
	} catch {
		fail("admission_proof commit object is not base64");
	}
	if ((await gitCommitId(body)) !== expected.candidate_sha) fail("admission_proof commit object is not the candidate SHA");
	const commit = parseCommitObject(body);
	const want = [expected.rebased_onto ?? expected.baseline, ...expected.contributing_shas].sort();
	if (canonicalJson([...commit.parents].sort()) !== canonicalJson(want)) {
		fail(`the candidate commit's parents are not the ${expected.rebased_onto ? "rebased-onto main" : "baseline"} and the contributing SHAs`);
	}

	// Content: walk hashed tree objects from the root to every bound path.
	const trees = new Map<string, Array<{ mode: string; name: string; id: string }>>();
	const rawTrees = proof.tree_objects;
	if (typeof rawTrees !== "object" || rawTrees === null || Array.isArray(rawTrees)) fail("admission_proof has no tree objects");
	const treeObjects: Record<string, string> = {};
	for (const [id, b64] of Object.entries(rawTrees as Record<string, unknown>)) {
		if (typeof b64 !== "string") fail("admission_proof tree object is not base64");
		let bytes: Uint8Array = new Uint8Array();
		try {
			bytes = fromBase64(b64 as string);
		} catch {
			fail("admission_proof tree object is not base64");
		}
		if ((await gitObjectId("tree", bytes)) !== id) fail(`admission_proof tree object ${id.slice(0, 12)} does not hash to its id`);
		trees.set(id, parseTreeObject(bytes));
		treeObjects[id] = b64 as string;
	}
	const lookup = (file: string): { mode: string; id: string } | null => {
		let tree = commit.tree;
		const parts = file.split("/");
		for (let i = 0; i < parts.length; i += 1) {
			const entries = trees.get(tree);
			if (!entries) fail(`admission_proof is missing the tree object on the path to ${file}`);
			const entry = (entries as Array<{ mode: string; name: string; id: string }>).find((e) => e.name === parts[i]);
			if (!entry) return null;
			if (i === parts.length - 1) return { mode: entry.mode, id: entry.id };
			if (entry.mode !== "40000") return null;
			tree = entry.id;
		}
		return null;
	};
	if (!Array.isArray(proof.files)) fail("admission_proof names no bound files");
	const files: BoundFile[] = [];
	for (const f of proof.files as unknown[]) {
		const file = f as Partial<BoundFile>;
		if (typeof file?.path !== "string" || typeof file.mode !== "string" || typeof file.blob !== "string" || !HEX40.test(file.blob) || typeof file.sha256 !== "string" || !HEX64.test(file.sha256)) {
			fail("admission_proof has a malformed bound file");
		}
		files.push({ path: file.path as string, mode: file.mode as string, blob: file.blob as string, sha256: file.sha256 as string });
	}
	files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	const boundPaths = [...new Set(expected.bound_paths)].sort();
	if (canonicalJson(files.map((f) => f.path)) !== canonicalJson(boundPaths)) fail("admission_proof does not bind exactly the record's files");
	for (const file of files) {
		const found = lookup(file.path);
		if (found === null) {
			if (file.blob !== "0".repeat(40) || file.mode !== "0") fail(`admission_proof binds ${file.path}, which the candidate tree does not have`);
		} else if (found.id !== file.blob || found.mode !== file.mode) {
			fail(`admission_proof's blob for ${file.path} is not the candidate tree's`);
		}
	}

	const att = proof.attestation;
	if (!att || typeof att.signature !== "string" || typeof att.key_id !== "string" || typeof att.payload !== "object" || att.payload === null) {
		fail("the admission proof carries no witness runner attestation");
	}
	const attestation = att as AdmissionProof["attestation"];
	if (pinned.revoked.includes(attestation.key_id)) fail(`the witness attestation is signed by revoked key ${attestation.key_id}`);
	const key = pinned.keys.find((k) => k.key_id === attestation.key_id);
	if (!key) fail(`the witness attestation is signed by key ${attestation.key_id}, which is not pinned`);
	const digest = attestation.payload.candidate_tree_digest_v1;
	if (typeof digest !== "string" || !HEX64.test(digest)) fail("the witness attestation names no tree-digest/v1");
	if (expected.tree_digest_v1 !== undefined && expected.tree_digest_v1 !== null && digest !== expected.tree_digest_v1) {
		fail("the attested tree-digest/v1 is not the promoted tree's");
	}
	const payload: WitnessAttestationPayload = {
		format: WITNESS_ATTESTATION_FORMAT,
		key_id: attestation.key_id,
		task_hash: expected.task_hash,
		contender_id: expected.contender_id,
		baseline: expected.baseline,
		rebased_onto: expected.rebased_onto,
		contributing_shas: [...expected.contributing_shas].sort(),
		candidate_sha: expected.candidate_sha,
		candidate_tree: commit.tree,
		candidate_tree_digest_v1: digest,
		capsule_id: expected.capsule_id,
		witness_manifest_sha256: expected.witness_manifest_sha256,
		witness_report_sha256: expected.witness?.witness_report_sha256 ?? null,
		verdict: (expected.witness?.verdict ?? "NONE") as WitnessAttestationPayload["verdict"],
		review_cleared_by: expected.witness?.review_cleared_by ?? null,
		files,
	};
	// The authority checks ITS view of the record, not the payload the caller
	// sent: any field that differs fails the signature.
	if (!(await verifyEd25519((key as WitnessRunnerKey).public_key, attestationBytes(payload), attestation.signature))) {
		fail("the witness attestation does not verify under the pinned witness runner key");
	}
	return { commit_object: proof.commit_object as string, tree_objects: treeObjects, files, attestation: { key_id: attestation.key_id, payload, signature: attestation.signature } };
}
