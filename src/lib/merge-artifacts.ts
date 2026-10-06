/**
 * Known unresolved merge-composition artifacts
 * (specs/amendments/unresolved-merge-artifact-v1.md).
 *
 * This is not a semantic-conflict detector. Two clean edits can still
 * contradict each other and produce none of the signals below. The only
 * thing recognized here is an artifact git (or a client imitating git)
 * leaves when a textual merge was not finished:
 *
 * - a conflict-marker pair in a blob: a line of N >= 7 "<" and a later
 *   line of N ">", each at the start of the line, the rest of that line
 *   empty or a single space plus a label. The usual "=======" separator
 *   is not required. A line of "=" by itself (a markdown rule) is not;
 * - an unmerged index entry (git ls-files --unmerged, stage 1, 2, or 3)
 *   when a caller has an index. A commit object does not store one:
 *   git will not commit an unmerged index, so a submitted SHA is caught
 *   by the blob scan, not by the index.
 *
 * Callers that never saw the bytes must not treat a missing list as a
 * scan. hasUnresolvedMergeArtifacts is false when the field is absent.
 */

import type { EvaluationBundle } from "./types.ts";

const MIN_MARKER = 7;

function compareUtf8(a: string, b: string): number {
	const x = new TextEncoder().encode(a);
	const y = new TextEncoder().encode(b);
	const n = Math.min(x.length, y.length);
	for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i] - y[i];
	return x.length - y.length;
}

/** Width of a leading "<" or ">" marker, or 0 when the line is not one. */
function markerWidth(line: Uint8Array, marker: number): number {
	let i = 0;
	while (i < line.length && line[i] === marker) i++;
	if (i < MIN_MARKER) return 0;
	if (i === line.length || line[i] === 0x20) return i;
	return 0;
}

/** True when `bytes` contains a start marker and a later end marker of the same width. */
export function blobHasConflictMarkers(bytes: Uint8Array): boolean {
	const seenStart = new Set<number>();
	let i = 0;
	while (i <= bytes.length) {
		let end = i;
		while (end < bytes.length && bytes[end] !== 0x0a) end++;
		let lineEnd = end;
		if (lineEnd > i && bytes[lineEnd - 1] === 0x0d) lineEnd--;
		const line = bytes.subarray(i, lineEnd);
		const start = markerWidth(line, 0x3c);
		if (start >= MIN_MARKER) seenStart.add(start);
		const close = markerWidth(line, 0x3e);
		if (close >= MIN_MARKER && seenStart.has(close)) return true;
		if (end >= bytes.length) break;
		i = end + 1;
	}
	return false;
}

/**
 * Paths from `git ls-files --unmerged` (or `-u`). One line is
 * `<mode> <object> <stage>\t<path>`. Stage 1, 2, or 3 is unmerged.
 * Anything else is ignored. Paths are returned in UTF-8 byte order.
 */
export function unmergedIndexPaths(lsFilesUnmerged: string): string[] {
	const paths = new Set<string>();
	for (const raw of lsFilesUnmerged.split("\n")) {
		const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
		if (line === "") continue;
		const tab = line.indexOf("\t");
		if (tab < 0) continue;
		const stage = Number(line.slice(0, tab).split(" ")[2]);
		if (stage === 1 || stage === 2 || stage === 3) paths.add(line.slice(tab + 1));
	}
	return [...paths].sort(compareUtf8);
}

/**
 * Blob hits, plus any paths the caller already classified, unioned with
 * unmerged-index paths. UTF-8 byte order. `paths` is for a caller that
 * scanned blobs itself and did not keep the bytes.
 */
export function unresolvedMergeArtifacts(input: {
	blobs?: Iterable<{ path: string; bytes: Uint8Array }>;
	paths?: readonly string[];
	unmergedIndex?: string;
}): string[] {
	const paths = new Set<string>(input.paths ?? []);
	if (input.blobs) {
		for (const blob of input.blobs) {
			if (blobHasConflictMarkers(blob.bytes)) paths.add(blob.path);
		}
	}
	if (input.unmergedIndex) {
		for (const path of unmergedIndexPaths(input.unmergedIndex)) paths.add(path);
	}
	return [...paths].sort(compareUtf8);
}

/**
 * True when an evaluation bundle names at least one unresolved merge
 * artifact. Absent or empty means the bundle did not report one. It does
 * not mean the tree was scanned.
 */
export function hasUnresolvedMergeArtifacts(
	bundle: Pick<EvaluationBundle, "unresolved_merge_artifacts"> | undefined,
): boolean {
	const paths = bundle?.unresolved_merge_artifacts;
	return Array.isArray(paths) && paths.some((p) => typeof p === "string" && p.length > 0);
}
