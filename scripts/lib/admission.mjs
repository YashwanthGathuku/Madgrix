/**
 * Runner side of the admission proof (src/lib/admission-proof.ts): read the
 * candidate's commit object, the tree objects down to every bound file, the
 * bound files' blob ids and SHA-256, and the candidate's tree-digest/v1, then
 * sign the attestation payload with the witness runner key.
 */
import { createHash, createPublicKey, sign as cryptoSign } from "node:crypto";
import { WITNESS_ATTESTATION_FORMAT, attestationBytes, parseCommitObject, witnessKeyId } from "../../src/lib/admission-proof.ts";
import { treeDigestV1 } from "../../src/lib/tree-digest.ts";
import { safeGit, splitZ } from "./safe-git.mjs";

/**
 * @typedef {{ keyId: string, sign(payload: Uint8Array): Promise<{ signature: string }> }} WitnessSigner
 */

/**
 * Blob bytes for many object ids with one `git cat-file --batch`.
 * @param {string} repo
 * @param {string[]} ids
 * @returns {Map<string, Buffer>}
 */
function readBlobs(repo, ids) {
	/** @type {Map<string, Buffer>} */
	const out = new Map();
	const unique = [...new Set(ids)];
	if (unique.length === 0) return out;
	const raw = safeGit(repo, ["cat-file", "--batch"], { buffer: true, input: Buffer.from(`${unique.join("\n")}\n`) }).raw;
	if (!raw) throw new Error("admission proof: cat-file --batch returned nothing");
	let i = 0;
	while (i < raw.length) {
		const nl = raw.indexOf(10, i);
		const [id, type, size] = raw.subarray(i, nl).toString("utf8").split(" ");
		if (type === "missing" || size === undefined) throw new Error(`admission proof: object ${id} is missing`);
		const n = Number(size);
		out.set(id, raw.subarray(nl + 1, nl + 1 + n));
		i = nl + 1 + n + 1;
	}
	return out;
}

/** @param {Uint8Array} bytes */
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * @param {string} repo
 * @param {any} record a COMPOSED or RESOLVED composition record
 * @param {{ taskHash: string, capsuleId: string | null, signer: WitnessSigner }} opts
 */
export async function buildAdmissionProof(repo, record, opts) {
	const sha = record.candidate_sha;
	const commitRaw = safeGit(repo, ["cat-file", "commit", sha], { buffer: true }).raw;
	if (!commitRaw) throw new Error("admission proof: could not read the candidate commit");
	const commit = parseCommitObject(new Uint8Array(commitRaw));

	// Every file in the candidate: mode, type, blob id.
	/** @type {Map<string, { mode: string, type: string, id: string }>} */
	const entries = new Map();
	for (const line of splitZ(safeGit(repo, ["ls-tree", "-r", "-z", "--full-tree", sha]).stdout)) {
		const tab = line.indexOf("\t");
		const [mode, type, id] = line.slice(0, tab).split(" ");
		entries.set(line.slice(tab + 1), { mode, type, id });
	}
	const blobs = readBlobs(repo, [...entries.values()].filter((e) => e.type === "blob").map((e) => e.id));
	const digest = await treeDigestV1(
		[...entries].map(([file, e]) => ({ mode: e.mode, type: e.type, path: file, ...(e.type === "blob" ? { bytes: blobs.get(e.id) } : {}) })),
	);
	if (!digest.ok) throw new Error(`admission proof: tree-digest/v1 cannot bind ${digest.unsupported.type} ${digest.unsupported.path}`);

	const bound =
		record.status === "RESOLVED" && record.resolution
			? [...record.resolution.lease.paths]
			: (record.files ?? []).map((/** @type {{ path: string }} */ f) => f.path);
	/** @type {Record<string, string>} */
	const treeObjects = {};
	const addTree = (/** @type {string} */ id) => {
		if (treeObjects[id]) return;
		const raw = safeGit(repo, ["cat-file", "tree", id], { buffer: true }).raw;
		if (!raw) throw new Error(`admission proof: could not read tree ${id}`);
		treeObjects[id] = raw.toString("base64");
	};
	addTree(commit.tree);
	const files = [];
	for (const file of [...new Set(bound)].sort()) {
		const parts = file.split("/");
		for (let i = 1; i < parts.length; i += 1) {
			const dir = parts.slice(0, i).join("/");
			const r = safeGit(repo, ["rev-parse", "--verify", "--quiet", `${sha}:${dir}`], { allowFailure: true });
			if (r.status !== 0) break;
			const id = r.stdout.trim();
			if (safeGit(repo, ["cat-file", "-t", id]).stdout.trim() !== "tree") break;
			addTree(id);
		}
		const entry = entries.get(file);
		if (!entry || entry.type !== "blob") files.push({ path: file, mode: "0", blob: "0".repeat(40), sha256: sha256(new Uint8Array()) });
		else files.push({ path: file, mode: entry.mode, blob: entry.id, sha256: sha256(/** @type {Buffer} */ (blobs.get(entry.id))) });
	}

	const witness = record.status === "RESOLVED" ? record.resolution?.witness ?? null : record.witness_check ?? null;
	const payload = {
		format: WITNESS_ATTESTATION_FORMAT,
		key_id: opts.signer.keyId,
		task_hash: opts.taskHash,
		contender_id: record.contender_id,
		baseline: record.baseline,
		rebased_onto: record.rebased_onto ?? null,
		contributing_shas: [...record.contributing_shas].sort(),
		candidate_sha: sha,
		candidate_tree: commit.tree,
		candidate_tree_digest_v1: digest.digest,
		capsule_id: record.status === "RESOLVED" ? opts.capsuleId : null,
		witness_manifest_sha256: record.witness_manifest_sha256 ?? null,
		witness_report_sha256: witness?.witness_report_sha256 ?? null,
		verdict: witness?.verdict ?? "NONE",
		review_cleared_by: witness?.review_cleared_by ?? null,
		files,
	};
	const { signature } = await opts.signer.sign(attestationBytes(/** @type {any} */ (payload)));
	return {
		commit_object: commitRaw.toString("base64"),
		tree_objects: treeObjects,
		files,
		attestation: { key_id: opts.signer.keyId, payload, signature },
	};
}

/**
 * A witness signer over a node KeyObject (Ed25519 private key). Its key id is
 * derived from the public key (witnessKeyId).
 * @param {import("node:crypto").KeyObject} privateKey
 * @returns {Promise<WitnessSigner & { publicKeySpkiHex: string }>}
 */
export async function witnessSignerFromKey(privateKey) {
	const publicKeySpkiHex = createPublicKey(privateKey).export({ type: "spki", format: "der" }).toString("hex");
	return {
		keyId: await witnessKeyId(publicKeySpkiHex),
		publicKeySpkiHex,
		sign: async (payload) => ({ signature: cryptoSign(null, payload, privateKey).toString("base64") }),
	};
}
