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
 * The authority does not see the bytes. It requires a completed scan
 * record bound to this candidate and this tree
 * (specs/amendments/unresolved-merge-artifact-v1.md). A missing or
 * malformed record is not a clean scan. A completed record whose paths
 * are empty is the evaluation zone's statement that it found none. It
 * is not an independent reading of the tree.
 */

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

/** The only scanner id the authority accepts on a merge-artifact scan. */
export const MERGE_ARTIFACT_SCANNER_V1 = "madgrix-merge-artifact/v1";

/** A completed scan. `paths` is empty only when that scan found none. */
export interface MergeArtifactScan {
	status: "COMPLETE";
	scanner: typeof MERGE_ARTIFACT_SCANNER_V1;
	candidate_sha: string;
	tree_sha256: string;
	paths: string[];
}

/** The record the evaluator writes after it has actually scanned. */
export function completeMergeArtifactScan(input: {
	candidate_sha: string;
	tree_sha256: string;
	paths?: readonly string[];
}): MergeArtifactScan {
	return {
		status: "COMPLETE",
		scanner: MERGE_ARTIFACT_SCANNER_V1,
		candidate_sha: input.candidate_sha,
		tree_sha256: input.tree_sha256,
		paths: [...(input.paths ?? [])],
	};
}

type ScanBundle = {
	candidate_sha?: unknown;
	tree_sha256?: unknown;
	merge_artifact_scan?: unknown;
	unresolved_merge_artifacts?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A path list the authority can read: an array of non-empty strings. */
function pathList(value: unknown): string[] | null {
	if (!Array.isArray(value)) return null;
	if (!value.every((p) => typeof p === "string" && p !== "")) return null;
	return value as string[];
}

/**
 * Why `merge_artifact_scan` is not a completed scan of this bundle.
 * Null means the record is complete and bound. This does not fetch blobs
 * and does not prove the evaluation zone told the truth.
 */
export function mergeArtifactScanIssue(bundle: ScanBundle | undefined): string | null {
	if (!bundle || !isRecord(bundle.merge_artifact_scan)) return "missing";
	const scan = bundle.merge_artifact_scan;
	if (scan.status !== "COMPLETE") return "status";
	if (scan.scanner !== MERGE_ARTIFACT_SCANNER_V1) return "scanner";
	if (typeof scan.candidate_sha !== "string" || scan.candidate_sha !== bundle.candidate_sha) return "candidate_sha";
	if (typeof scan.tree_sha256 !== "string" || scan.tree_sha256 !== bundle.tree_sha256) return "tree_sha256";
	const paths = pathList(scan.paths);
	if (!paths) return "paths";
	if (bundle.unresolved_merge_artifacts !== undefined) {
		const bare = pathList(bundle.unresolved_merge_artifacts);
		if (!bare || bare.length !== paths.length || bare.some((p, i) => p !== paths[i])) return "legacy";
	}
	return null;
}

/** True when the scan record is complete, recognized, and bound to this bundle. */
export function mergeArtifactScanComplete(bundle: ScanBundle | undefined): boolean {
	return mergeArtifactScanIssue(bundle) === null;
}

/**
 * Paths named by a scan record or by the legacy list, when that value is
 * an array of strings. Malformed values contribute nothing here; completeness
 * rejects them separately.
 */
export function reportedMergeArtifactPaths(bundle: ScanBundle | undefined): string[] {
	if (!bundle) return [];
	if (isRecord(bundle.merge_artifact_scan) && Array.isArray(bundle.merge_artifact_scan.paths)) {
		const paths = bundle.merge_artifact_scan.paths;
		if (paths.every((p) => typeof p === "string")) return [...paths];
	}
	if (Array.isArray(bundle.unresolved_merge_artifacts) && bundle.unresolved_merge_artifacts.every((p) => typeof p === "string")) {
		return [...bundle.unresolved_merge_artifacts];
	}
	return [];
}

/**
 * True when the bundle names at least one unresolved merge artifact.
 * An absent record is not this signal. Completeness is a separate check.
 */
export function hasUnresolvedMergeArtifacts(bundle: ScanBundle | undefined): boolean {
	if (!bundle) return false;
	const lists: unknown[] = [];
	if (isRecord(bundle.merge_artifact_scan)) lists.push(bundle.merge_artifact_scan.paths);
	lists.push(bundle.unresolved_merge_artifacts);
	return lists.some(
		(paths) => Array.isArray(paths) && paths.some((p) => typeof p === "string" && p.length > 0),
	);
}

/**
 * True when a stored bundle must not be permitted or promoted: the scan
 * is missing or malformed, or it names an artifact. A missing bundle is
 * not this signal (the caller treats that as a missing evaluation).
 * A complete scan with `paths: []` returns false. That statement can be
 * a lie. The promotion container is the component that reads the blobs.
 */
export function mergeArtifactAdmissionRefuses(bundle: ScanBundle | undefined): boolean {
	if (!bundle) return false;
	return !mergeArtifactScanComplete(bundle) || hasUnresolvedMergeArtifacts(bundle);
}

/**
 * Harness and test bundles stand in for the trusted evaluator. When the
 * caller did not set `merge_artifact_scan`, attach a COMPLETE record bound
 * to this candidate. Paths are copied from `unresolved_merge_artifacts`
 * when that field is a list of non-empty strings. The authority never
 * calls this and never invents a scan for a submitted bundle.
 */
export function assumeCompleteMergeArtifactScan<T extends { candidate_sha: string; tree_sha256: string }>(rest: T): T {
	if (Object.hasOwn(rest, "merge_artifact_scan")) return rest;
	const bare = (rest as { unresolved_merge_artifacts?: unknown }).unresolved_merge_artifacts;
	const paths = pathList(bare) ?? [];
	return {
		...rest,
		merge_artifact_scan: completeMergeArtifactScan({
			candidate_sha: rest.candidate_sha,
			tree_sha256: rest.tree_sha256,
			paths,
		}),
	};
}
