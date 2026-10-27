/**
 * The promotion container, simulated over FakeArtifacts (SIMULATION ONLY;
 * specs/amendments/rebase-ancestry-v1.md).
 *
 * src/lib/git-promotion.ts models container/promote.sh and
 * container/rebase.sh over an abstract git; this module gives those models
 * FakeArtifacts repositories to work on, so the in-memory harnesses
 * (head-move.ts, slice.ts) promote and rebase the way the real container
 * does: fast-forward only, refusing a candidate that does not descend from
 * the permit-bound head, and rebasing into a new commit.
 * test/fixtures/promotion-cases.json runs every case through the real
 * scripts and through these adapters.
 *
 * A FakeArtifacts tree is `path → content string`. A gitlink, which has no
 * file content, is written as FAKE_GITLINK_PREFIX + the commit it points at.
 */

import type { FakeArtifacts } from "../lib/fake-artifacts.ts";
import {
	promotionHttpResult,
	rebaseHttpResult,
	runPromoteModel,
	runRebaseModel,
	type PromoteGit,
	type PromotionResult,
	type RebaseGit,
	type RebaseResult,
	type ScriptRun,
} from "../lib/git-promotion.ts";
import type { TreeDigestEntry } from "../lib/tree-digest.ts";

export const FAKE_GITLINK_PREFIX = "\u0000gitlink ";

/** `git merge-base --is-ancestor a b`, walking b's history in the first repo that has each commit. */
function isAncestorIn(fake: FakeArtifacts, repos: string[], a: string, b: string): boolean {
	const seen = new Set<string>();
	const stack = [b];
	while (stack.length > 0) {
		const cur = stack.pop() as string;
		if (cur === a) return true;
		if (seen.has(cur)) continue;
		seen.add(cur);
		for (const repo of repos) {
			const commit = fake.readCommitObject(repo, cur);
			if (commit) {
				stack.push(...commit.parents);
				break;
			}
		}
	}
	return false;
}

function readFrom(fake: FakeArtifacts, repos: string[], sha: string) {
	for (const repo of repos) {
		const commit = fake.readCommitObject(repo, sha);
		if (commit) return commit;
	}
	return null;
}

async function mainOf(fake: FakeArtifacts, repo: string): Promise<string | null> {
	return (await fake.get(repo)).getHead("main");
}

/**
 * Simulation-only options for the adapters below: `rejectPush` makes the
 * remote refuse the push (a hook, an auth failure); `concurrentPush` is a
 * commit another writer pushes to the ref just before ours (a race), which
 * must already be stored in that repository.
 */
export interface FakeRemoteOptions {
	rejectPush?: boolean;
	concurrentPush?: string;
}

/** promote.sh's git: `source` is the contender fork, `destination` the canonical repo. */
export function fakePromoteGit(
	fake: FakeArtifacts,
	opts: { source: string; destination: string } & FakeRemoteOptions,
): PromoteGit {
	const repos = [opts.destination, opts.source];
	return {
		fetchDestinationMain: () => mainOf(fake, opts.destination),
		fetchSource: async (sha) => (fake.isReachable(opts.source, sha) ? sha : null),
		async treeEntries(sha) {
			const commit = readFrom(fake, repos, sha);
			if (!commit) throw new Error(`fake container: unknown commit ${sha}`);
			const utf8 = new TextEncoder();
			return Object.entries(commit.tree).map(([path, content]): TreeDigestEntry =>
				content.startsWith(FAKE_GITLINK_PREFIX)
					? { mode: "160000", type: "commit", path }
					: { mode: "100644", type: "blob", path, bytes: utf8.encode(content) },
			);
		},
		isAncestor: async (a, b) => isAncestorIn(fake, repos, a, b),
		parentOf: async (sha) => readFrom(fake, repos, sha)?.parents[0] ?? null,
		async pushDestinationMain(sha) {
			if (opts.concurrentPush) fake.casRef(opts.destination, "main", await mainOf(fake, opts.destination), opts.concurrentPush);
			if (opts.rejectPush) return false;
			const current = await mainOf(fake, opts.destination);
			// A push without force is a fast-forward or nothing.
			if (current !== null && !isAncestorIn(fake, repos, current, sha)) return false;
			if (!fake.importHistory(opts.source, opts.destination, sha)) return false;
			return fake.casRef(opts.destination, "main", current, sha);
		},
	};
}

/** rebase.sh's git: `fork` is the contender fork, `destination` the canonical repo. */
export function fakeRebaseGit(
	fake: FakeArtifacts,
	opts: { fork: string; destination: string } & FakeRemoteOptions,
): RebaseGit {
	const repos = [opts.fork, opts.destination];
	return {
		fetchForkMain: () => mainOf(fake, opts.fork),
		async fetchDestination(sha) {
			if (!fake.isReachable(opts.destination, sha)) return null;
			// The fetched history is local to the rebase from here on.
			fake.importHistory(opts.destination, opts.fork, sha);
			return sha;
		},
		isAncestor: async (a, b) => isAncestorIn(fake, repos, a, b),
		readCommit: async (sha) => readFrom(fake, repos, sha),
		writeCommit: (commit) => fake.writeCommit(opts.fork, commit),
		async pushForkMainWithLease(sha, expected) {
			if (opts.concurrentPush) fake.casRef(opts.fork, "main", await mainOf(fake, opts.fork), opts.concurrentPush);
			return !opts.rejectPush && fake.casRef(opts.fork, "main", expected, sha);
		},
	};
}

/** Run the promote model and map it as PromotionContainer.ts maps promote.sh. */
export async function fakePromote(
	fake: FakeArtifacts,
	opts: { source: string; destination: string; candidate_sha: string; expected_head: string; winning_tree_sha256: string },
): Promise<{ run: ScriptRun; status: number; body: PromotionResult }> {
	const run = await runPromoteModel(
		{ candidate_sha: opts.candidate_sha, expected_head: opts.expected_head, winning_tree_sha256: opts.winning_tree_sha256 },
		fakePromoteGit(fake, { source: opts.source, destination: opts.destination }),
	);
	return { run, ...promotionHttpResult(run.exit, run.stdout, run.stderr) };
}

/** Run the rebase model and map it as PromotionContainer.ts maps rebase.sh. */
export async function fakeRebase(
	fake: FakeArtifacts,
	opts: { fork: string; destination: string; candidate_sha: string; onto: string },
): Promise<{ run: ScriptRun; status: number; body: RebaseResult }> {
	const run = await runRebaseModel(
		{ candidate_sha: opts.candidate_sha, onto: opts.onto },
		fakeRebaseGit(fake, { fork: opts.fork, destination: opts.destination }),
	);
	return { run, ...rebaseHttpResult(run.exit, run.stdout, run.stderr) };
}
