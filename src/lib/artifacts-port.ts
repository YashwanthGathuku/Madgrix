/**
 * ArtifactsPort — platform-side abstraction over the Cloudflare Artifacts
 * binding (internal codename: seam — NOT a public brand).
 *
 * # Production-real vs. simulation substrate
 *
 * - `ArtifactsPort` / `ArtifactsRepo` mirror the REAL Cloudflare Artifacts
 *   binding surface 1:1 (see the JSDoc on each method for the exact binding
 *   method it maps to; shapes cross-checked against the generated workerd
 *   types for workerd@1.20260930.2). In production the Worker constructs
 *   `BindingArtifactsPort` (src/worker/index.ts) around `env.ARTIFACTS`.
 * - `FakeArtifacts` (src/lib/fake-artifacts.ts) is an IN-MEMORY TEST
 *   SUBSTRATE implementing the same interfaces. It exists because this
 *   machine cannot reach the remote Artifacts binding (TLS proxy blocker;
 *   see ../SETUP_STATUS.md). It is sufficient to exercise forks, pushes,
 *   SHAs, tokens, and the promotion path in a Node harness, and MUST NOT
 *   be mistaken for the real service (content addressing is SHA-256 over
 *   canonical JSON, NOT real git SHA-1; no network; no credentials).
 * - `SimulatedGit` is the simulation-only stand-in for the Git protocol.
 *   In production, git operations (clone/push/fetch) happen OVER THE GIT
 *   PROTOCOL using repo tokens; the Worker never sees them and has no
 *   equivalent of pushAsToken/readTreeAsToken/adminPush.
 *
 * Conventions: strict TypeScript, erasable syntax only (no enums —
 * string unions; no parameter properties; no namespaces), `.ts` import
 * extensions, `import type` for type-only imports.
 */

/* ------------------------------------------------------------------ */
/* Harness-level idempotent fork helper                                */
/* ------------------------------------------------------------------ */

/** Token scope — mirrors the binding's `'write' | 'read'`. */
export type TokenScope = "read" | "write";

/** Token lifecycle state — mirrors the binding's token metadata. */
export type TokenState = "active" | "expired" | "revoked";

/** Result of minting a token. Plaintext is delivered ONCE and MUST never
 *  be logged or persisted (spec 3 §5). */
export interface CreateTokenResult {
	/** Unique token id (safe to log; used for audit + revocation). */
	id: string;
	/** Plaintext token — handle exactly once, then drop. */
	plaintext: string;
	scope: TokenScope;
	/** RFC3339 expiry. */
	expiresAt: string;
}

/** Token metadata without plaintext — safe for audit surfaces. */
export interface TokenInfo {
	id: string;
	scope: TokenScope;
	state: TokenState;
	/** RFC3339. */
	createdAt: string;
	/** RFC3339. */
	expiresAt: string;
}

/** Result of creating/forking a repository. */
export interface CreateRepoResult {
	name: string;
	/** HTTPS git remote URL (production) or `fake://<name>` (simulation). */
	remote: string;
	/**
	 * Initial access token PLAINTEXT — delivered once at creation time,
	 * exactly like the real binding's `ArtifactsCreateRepoResult.token`.
	 * Never log or persist; revoke immediately if a shorter-lived token
	 * is minted on top of it.
	 */
	tokenPlaintext: string;
}

export interface RepoSummary {
	name: string;
	defaultBranch: string;
	/** RFC3339. */
	createdAt: string;
	/** RFC3339 of last push, or null if never pushed. */
	lastPushAt: string | null;
}

export interface RepoListResult {
	repos: RepoSummary[];
	total: number;
	cursor?: string;
}

/** Decoded commit metadata (subset of the binding's ArtifactsCommitMetadata). */
export interface CommitMetadata {
	/** Commit id. Real binding: lowercase 40-char SHA-1. Fake: 64-char SHA-256. */
	hash: string;
	/** Root tree id. Real binding: SHA-1. Fake: SHA-256 over canonical JSON. */
	treeHash: string;
	parents: string[];
	message: string;
}

export interface LogOptions {
	/** Branch, tag, or commit id. Defaults to the default branch. */
	ref?: string;
	/** Max results. */
	limit?: number;
	/** Commits to skip. */
	offset?: number;
}

/* ------------------------------------------------------------------ */
/* Typed errors                                                        */
/* ------------------------------------------------------------------ */

export type ArtifactAuthErrorCode =
	| "TOKEN_NOT_FOUND"
	| "TOKEN_REVOKED"
	| "TOKEN_EXPIRED"
	| "SCOPE_DENIED"
	| "REPO_MISMATCH";

export type ArtifactLimitErrorCode = "BLOB_TOO_LARGE" | "REPO_QUOTA_EXCEEDED";

export type ArtifactStateErrorCode = "ALREADY_EXISTS" | "NOT_FOUND" | "INVALID_INPUT";

/** Authorization failure on a token-scoped operation. */
export class ArtifactAuthError extends Error {
	readonly code: ArtifactAuthErrorCode;
	constructor(code: ArtifactAuthErrorCode, message: string) {
		super(message);
		this.name = "ArtifactAuthError";
		this.code = code;
	}
}

/** A spec-5 §6 limit was hit (32 MB blob / 1 GB repo). */
export class ArtifactLimitError extends Error {
	readonly code: ArtifactLimitErrorCode;
	constructor(code: ArtifactLimitErrorCode, message: string) {
		super(message);
		this.name = "ArtifactLimitError";
		this.code = code;
	}
}

/** Repository lifecycle failure (already exists / not found / bad input). */
export class ArtifactStateError extends Error {
	readonly code: ArtifactStateErrorCode;
	constructor(code: ArtifactStateErrorCode, message: string) {
		super(message);
		this.name = "ArtifactStateError";
		this.code = code;
	}
}

/* ------------------------------------------------------------------ */
/* ArtifactsRepo — mirrors the real ArtifactsRepo capability            */
/* ------------------------------------------------------------------ */

export interface ArtifactsRepo {
	readonly name: string;
	readonly remote: string;

	/**
	 * Fork this repo to a new repo.
	 * Maps to: `ArtifactsRepo.fork(name, opts?)` on the real binding.
	 * Real binding throws ALREADY_EXISTS if the target exists.
	 */
	fork(
		name: string,
		opts?: { description?: string; readOnly?: boolean; defaultBranchOnly?: boolean },
	): Promise<CreateRepoResult>;

	/**
	 * Mint an access token for this repo.
	 * Maps to: `ArtifactsRepo.createToken(scope?, ttl?)` on the real binding
	 * (scope: "write" default | "read"; ttl seconds, real binding min 60).
	 * Plaintext is returned ONCE — never log or persist it (spec 3 §5).
	 */
	createToken(scope?: TokenScope, ttl?: number): Promise<CreateTokenResult>;

	/**
	 * Revoke a token by plaintext or id.
	 * Maps to: `ArtifactsRepo.revokeToken(tokenOrId)` on the real binding
	 * (returns true if revoked, false if not found).
	 */
	revokeToken(tokenOrId: string): Promise<boolean>;

	/**
	 * List token metadata (no plaintext) for audit.
	 * Maps to: `ArtifactsRepo.listTokens()` on the real binding.
	 */
	listTokens(): Promise<TokenInfo[]>;

	/**
	 * List commits along the first-parent chain, newest first.
	 * Maps to: `ArtifactsRepo.log({ ref?, limit?, offset? })` on the real binding.
	 */
	log(opts?: LogOptions): Promise<CommitMetadata[]>;

	/**
	 * Decode a commit by id.
	 * Maps to: `ArtifactsRepo.readCommit(hash)` on the real binding
	 * (returns null if the object is missing).
	 */
	readCommit(hash: string): Promise<CommitMetadata | null>;

	/**
	 * Resolve the current HEAD commit id for a branch (default: "main").
	 * CONVENIENCE — no direct binding equivalent; implemented as
	 * `log({ ref, limit: 1 })` against the real binding.
	 * Returns null if the ref cannot be resolved.
	 */
	getHead(ref?: string): Promise<string | null>;
}

/* ------------------------------------------------------------------ */
/* ArtifactsPort — mirrors the real Artifacts binding (namespace level) */
/* ------------------------------------------------------------------ */

export interface ArtifactsPort {
	/**
	 * Create a new repository with an initial access token.
	 * Maps to: `Artifacts.create(name, opts?)` on the real binding.
	 */
	create(
		name: string,
		opts?: { readOnly?: boolean; description?: string; setDefaultBranch?: string },
	): Promise<CreateRepoResult>;

	/**
	 * Get a handle to an existing repository.
	 * Maps to: `Artifacts.get(name)` on the real binding
	 * (throws NOT_FOUND if the repo does not exist).
	 */
	get(name: string): Promise<ArtifactsRepo>;

	/**
	 * List repositories with cursor pagination.
	 * Maps to: `Artifacts.list({ limit?, cursor? })` on the real binding.
	 */
	list(opts?: { limit?: number; cursor?: string }): Promise<RepoListResult>;

	/**
	 * Delete a repository and all associated tokens.
	 * Maps to: `Artifacts.delete(name)` on the real binding
	 * (true if deleted, false if not found).
	 */
	delete(name: string): Promise<boolean>;
}

/* ------------------------------------------------------------------ */
/* SimulatedGit — TEST/SIMULATION ONLY                                 */
/* ------------------------------------------------------------------ */

/**
 * TEST/SIMULATION-ONLY stand-in for the Git protocol.
 *
 * In production, ALL git operations (clone, fetch, push) happen OVER THE
 * GIT PROTOCOL between sandboxes and the Artifacts git remotes, using the
 * tokens minted via `ArtifactsRepo.createToken`. The Worker never performs
 * git operations and has NO equivalent of these methods — they exist only
 * so the local Node harness can drive the same platform code paths
 * (fork → token → push → read → promote) without a network.
 *
 * `FakeArtifacts` implements both `ArtifactsPort` and `SimulatedGit`.
 * `BindingArtifactsPort` (production) implements `ArtifactsPort` ONLY.
 */
export interface SimulatedGit {
	/**
	 * SIMULATION ONLY. Push a commit as a token holder, enforcing the
	 * token's scope/expiry/revocation and the spec-5 §6 size limits.
	 * Production equivalent: `git push` over HTTPS with the token as the
	 * password, performed by a sandbox — never by the Worker.
	 */
	pushAsToken(args: {
		repo: string;
		/** Branch name to update (created if absent). */
		ref: string;
		/** path → file contents (UTF-8 text). */
		tree: Record<string, string>;
		message: string;
		/** Defaults to the current branch head (fast-forward). */
		parents?: string[];
		/** Token PLAINTEXT. */
		token: string;
	}): Promise<string>;

	/**
	 * SIMULATION ONLY. Read a tree as a token holder.
	 * Production equivalent: `git archive` / `git fetch` + `git read-tree`
	 * over the Git protocol with the token.
	 */
	readTreeAsToken(args: {
		repo: string;
		/** Branch name or commit id. */
		ref: string;
		/** Token PLAINTEXT. */
		token: string;
	}): Promise<Record<string, string>>;

	/**
	 * SIMULATION ONLY — CONTROL-PLANE ONLY. Write a commit bypassing token
	 * checks (size limits still enforced).
	 * Production equivalent: the MERGE SANDBOX pushing with a merge-scoped
	 * token issued by the promotion service (spec 5 §7) — unreachable from
	 * contenders, evaluators, and verifiers. The Worker calls this only
	 * through the promotion path, never on a contender's behalf.
	 */
	adminPush(args: {
		repo: string;
		ref: string;
		tree: Record<string, string>;
		message: string;
		parents?: string[];
	}): Promise<string>;
}

/* ------------------------------------------------------------------ */
/* Harness-level idempotent fork helper                                */
/* ------------------------------------------------------------------ */

/**
 * Idempotent fork (spec 5 §5): the fork operation id is
 * `H(task_id, contender_id)` and the fork NAME is derived from it, so a
 * Workflow-step retry MUST converge to the same fork instead of creating
 * a second one. This helper checks for the existing fork (via list/get)
 * before creating — the same logic the Worker's contender route uses.
 *
 * Works against ANY ArtifactsPort (real binding or FakeArtifacts).
 */
export async function forkIdempotent(
	port: ArtifactsPort,
	sourceRepoName: string,
	forkName: string,
): Promise<{ repo: ArtifactsRepo; created: boolean; initialTokenPlaintext: string | null }> {
	let cursor: string | undefined;
	do {
		const page = await port.list(cursor === undefined ? undefined : { cursor });
		if (page.repos.some((r) => r.name === forkName)) {
			return { repo: await port.get(forkName), created: false, initialTokenPlaintext: null };
		}
		cursor = page.cursor;
	} while (cursor !== undefined);
	const source = await port.get(sourceRepoName);
	const created = await source.fork(forkName, {
		description: "seam contender fork (internal codename; not a public brand)",
	});
	return {
		repo: await port.get(forkName),
		created: true,
		initialTokenPlaintext: created.tokenPlaintext,
	};
}
