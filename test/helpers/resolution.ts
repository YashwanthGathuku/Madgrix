/**
 * A well-formed resolution block for a state whose composition is CONFLICTED
 * or RESOLVING (specs/amendments/governed-resolution-v1.md §5). Tests that
 * exercise what happens after RESOLVED use it; tests of the resolution rules
 * themselves build their own blocks.
 */
import type { AuthorityState, CompositionResolution } from "../../src/lib/types.ts";

export function resolutionFor(state: AuthorityState, overrides: Partial<CompositionResolution> = {}): CompositionResolution {
	const current = state.composition;
	if (!current || typeof current.capsule_id !== "string") {
		throw new Error("resolutionFor: the state has no recorded conflict capsule");
	}
	return {
		format: "madgrix-resolution/v1",
		capsule_id: current.capsule_id,
		resolver_id: "test-resolver",
		rung: "command",
		order_agreement: null,
		lease: { paths: current.files.map((file) => file.path), precomposed_tree: "a".repeat(40) },
		witness: {
			witness_manifest_sha256: current.witness_manifest_sha256 ?? null,
			witness_report_sha256: "b".repeat(64),
			verdict: "ADMIT",
			review_cleared_by: null,
		},
		...overrides,
	};
}
