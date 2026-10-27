/**
 * tree-digest/v1 (specs/amendments/tree-digest-v1.md) over a list of tree
 * entries: SHA-256 over `mode NUL path NUL SHA256(blob-bytes) NUL` for every
 * blob, in `git ls-tree -r --full-tree` order, which is the byte order of the
 * full paths. Any non-blob entry (a gitlink) has no v1 digest.
 *
 * container/promote.sh computes the same digest with git and coreutils;
 * src/lib/git-promotion.ts uses this one to model it, and
 * test/promotion-fixtures.test.ts checks that both print the same value.
 *
 * Pure: hashing goes through crypto.subtle (Workers and Node).
 */

import { sha256Hex } from "./canonical.ts";

export interface TreeDigestEntry {
	/** git's octal mode, e.g. "100644", "100755", "160000". */
	mode: string;
	/** git's object type: "blob" for files and symlinks, "commit" for gitlinks. */
	type: string;
	path: string;
	/** The blob's bytes (blobs only). */
	bytes?: Uint8Array;
}

export type TreeDigestResult =
	| { ok: true; digest: string }
	| { ok: false; unsupported: { type: string; path: string } };

const utf8 = new TextEncoder();

function compareBytes(a: Uint8Array, b: Uint8Array): number {
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
	return a.length - b.length;
}

export async function treeDigestV1(entries: TreeDigestEntry[]): Promise<TreeDigestResult> {
	const sorted = entries
		.map((entry) => ({ entry, path: utf8.encode(entry.path) }))
		.sort((a, b) => compareBytes(a.path, b.path));
	const chunks: Uint8Array[] = [];
	for (const { entry, path } of sorted) {
		if (entry.type !== "blob" || entry.bytes === undefined) {
			return { ok: false, unsupported: { type: entry.type, path: entry.path } };
		}
		chunks.push(utf8.encode(`${entry.mode}\0`), path, utf8.encode(`\0${await sha256Hex(entry.bytes)}\0`));
	}
	const stream = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
	let offset = 0;
	for (const c of chunks) {
		stream.set(c, offset);
		offset += c.length;
	}
	return { ok: true, digest: await sha256Hex(stream) };
}

/** tree-digest/v1 of plain files (mode 100644), keyed by path. */
export async function treeDigestOfFiles(files: Record<string, string>): Promise<string> {
	const result = await treeDigestV1(
		Object.entries(files).map(([path, content]) => ({ mode: "100644", type: "blob", path, bytes: utf8.encode(content) })),
	);
	if (!result.ok) throw new Error(`tree-digest/v1: unsupported ${result.unsupported.type} entry ${result.unsupported.path}`);
	return result.digest;
}
