/**
 * FakeArtifacts — IN-MEMORY TEST/SIMULATION SUBSTRATE (internal codename:
 * seam — NOT a public brand).
 *
 * Implements `ArtifactsPort` + `SimulatedGit` with a minimal git-like
 * model so the full vertical slice (task → fork → token → push → promote)
 * runs end-to-end in a local Node harness with no network and no
 * credentials.
 *
 * # What is real vs. fake
 *
 * REAL (matches the production binding contract):
 *   - fork lineage, token lifecycle (mint/revoke/expiry/scope), per-repo
 *     token namespaces, idempotent-fork convergence via list-then-create,
 *     32 MB per-blob and 1 GB per-repo limits, plaintext-once semantics.
 * FAKE (do NOT mistake for the real service):
 *   - Content addressing is SHA-256 over canonical JSON
 *     (`sha256Hex(canonicalJson({parents, tree, message}))`) — NOT real
 *     git SHA-1. Commit/tree ids from the fake NEVER equal production ids.
 *   - No network, no credentials, no rate limits, no pagination beyond a
 *     trivial cursor, no readOnly enforcement, no force-push checks.
 *   - `pushAsToken`/`readTreeAsToken`/`adminPush` have NO production
 *     equivalent in the Worker: real git operations travel over the Git
 *     protocol with tokens, performed by sandboxes — never by the Worker.
 *   - Fake allows token TTLs below the real binding's 60s minimum so
 *     expiry paths are testable (documented deviation).
 *
 * Erasable syntax only; `.ts` import extensions; `import type` for types.
 */

import { canonicalJson, randomHex, sha256Hex } from "./canonical.ts";
import {
	ArtifactAuthError,
	ArtifactLimitError,
	ArtifactStateError,
} from "./artifacts-port.ts";
import type {
	ArtifactsPort,
	ArtifactsRepo,
	CommitMetadata,
	CreateRepoResult,
	CreateTokenResult,
	LogOptions,
	RepoListResult,
	RepoSummary,
	SimulatedGit,
	TokenInfo,
	TokenScope,
	TokenState,
} from "./artifacts-port.ts";

/** Spec 5 §6: individual blob limit. */
export const FAKE_MAX_BLOB_BYTES = 32 * 1024 * 1024;
/** Spec 5 §6: repository storage limit. */
export const FAKE_MAX_REPO_BYTES = 1024 * 1024 * 1024;

interface FakeCommit {
	parents: string[];
	tree: Record<string, string>;
	message: string;
	treeHash: string;
}

interface FakeToken {
	id: string;
	plaintext: string;
	scope: TokenScope;
	createdAt: string;
	expiresAt: string;
	revoked: boolean;
}

interface FakeRepoState {
	name: string;
	defaultBranch: string;
	description: string | null;
	readOnly: boolean;
	createdAt: string;
	lastPushAt: string | null;
	commits: Map<string, FakeCommit>;
	branches: Map<string, string>;
	forkLineage?: { repo: string; commit: string };
	tokens: Map<string, FakeToken>;
	/** Unique blob contents (dedupe key = content) → byte size, for the 1 GB cap. */
	blobBytes: Map<string, number>;
}

function utf8Bytes(s: string): number {
	return new TextEncoder().encode(s).length;
}

function repoBytes(state: FakeRepoState): number {
	let total = 0;
	for (const b of state.blobBytes.values()) total += b;
	return total;
}

function tokenState(t: FakeToken, nowMs: number): TokenState {
	if (t.revoked) return "revoked";
	if (Date.parse(t.expiresAt) <= nowMs) return "expired";
	return "active";
}

function toTokenInfo(t: FakeToken, nowMs: number): TokenInfo {
	return {
		id: t.id,
		scope: t.scope,
		state: tokenState(t, nowMs),
		createdAt: t.createdAt,
		expiresAt: t.expiresAt,
	};
}

/* ------------------------------------------------------------------ */
/* FakeRepo — the ArtifactsRepo capability handle                      */
/* ------------------------------------------------------------------ */

class FakeRepo implements ArtifactsRepo {
	private fake: FakeArtifacts;
	private repoName: string;

	constructor(fake: FakeArtifacts, repoName: string) {
		this.fake = fake;
		this.repoName = repoName;
	}

	get name(): string {
		return this.repoName;
	}

	get remote(): string {
		return `fake://${this.repoName}`;
	}

	private state(): FakeRepoState {
		return this.fake.requireRepo(this.repoName);
	}

	async fork(
		name: string,
		opts?: { description?: string; readOnly?: boolean; defaultBranchOnly?: boolean },
	): Promise<CreateRepoResult> {
		const src = this.state();
		if (this.fake.hasRepo(name)) {
			throw new ArtifactStateError("ALREADY_EXISTS", `repo already exists: ${name}`);
		}
		const head = src.branches.get(src.defaultBranch) ?? null;
		const now = this.fake.nowMs();
		const created: FakeRepoState = {
			name,
			defaultBranch: src.defaultBranch,
			description: opts?.description ?? null,
			readOnly: opts?.readOnly ?? false,
			createdAt: new Date(now).toISOString(),
			lastPushAt: head === null ? null : src.lastPushAt,
			commits: new Map(src.commits),
			branches: new Map(src.branches),
			forkLineage: head === null ? undefined : { repo: src.name, commit: head },
			tokens: new Map(),
			blobBytes: new Map(src.blobBytes),
		};
		this.fake.putRepo(created);
		const token = this.fake.mintToken(created, "write", 86400);
		return { name, remote: `fake://${name}`, tokenPlaintext: token.plaintext };
	}

	async createToken(scope: TokenScope = "write", ttl: number = 86400): Promise<CreateTokenResult> {
		if (!(ttl >= 1 && ttl <= 31536000)) {
			throw new ArtifactStateError("INVALID_INPUT", `ttl out of range: ${ttl}`);
		}
		const token = this.fake.mintToken(this.state(), scope, ttl);
		return { id: token.id, plaintext: token.plaintext, scope: token.scope, expiresAt: token.expiresAt };
	}

	async revokeToken(tokenOrId: string): Promise<boolean> {
		if (tokenOrId === "") {
			throw new ArtifactStateError("INVALID_INPUT", "tokenOrId must not be empty");
		}
		const st = this.state();
		for (const t of st.tokens.values()) {
			if (t.id === tokenOrId || t.plaintext === tokenOrId) {
				t.revoked = true;
				return true;
			}
		}
		return false;
	}

	async listTokens(): Promise<TokenInfo[]> {
		const now = this.fake.nowMs();
		return [...this.state().tokens.values()].map((t) => toTokenInfo(t, now));
	}

	async log(opts: LogOptions = {}): Promise<CommitMetadata[]> {
		const st = this.state();
		const ref = opts.ref ?? st.defaultBranch;
		const head = this.fake.resolveRef(st, ref);
		if (head === null) return [];
		const chain: CommitMetadata[] = [];
		let cur: string | null = head;
		while (cur !== null) {
			const c = st.commits.get(cur);
			if (!c) break;
			chain.push({ hash: cur, treeHash: c.treeHash, parents: [...c.parents], message: c.message });
			cur = c.parents.length > 0 ? c.parents[0] : null;
		}
		const offset = opts.offset ?? 0;
		const limit = opts.limit ?? 50;
		return chain.slice(offset, offset + limit);
	}

	async readCommit(hash: string): Promise<CommitMetadata | null> {
		const c = this.state().commits.get(hash);
		if (!c) return null;
		return { hash, treeHash: c.treeHash, parents: [...c.parents], message: c.message };
	}

	async getHead(ref: string = "main"): Promise<string | null> {
		return this.fake.resolveRef(this.state(), ref);
	}
}

/* ------------------------------------------------------------------ */
/* FakeArtifacts                                                       */
/* ------------------------------------------------------------------ */

export class FakeArtifacts implements ArtifactsPort, SimulatedGit {
	private repos = new Map<string, FakeRepoState>();
	private nowFn: () => number;

	/**
	 * @param opts.now injectable clock (ms since epoch) — tests use this
	 * to advance past token expiry deterministically.
	 */
	constructor(opts?: { now?: () => number }) {
		this.nowFn = opts?.now ?? (() => Date.now());
	}

	nowMs(): number {
		return this.nowFn();
	}

	hasRepo(name: string): boolean {
		return this.repos.has(name);
	}

	requireRepo(name: string): FakeRepoState {
		const st = this.repos.get(name);
		if (!st) throw new ArtifactStateError("NOT_FOUND", `repo not found: ${name}`);
		return st;
	}

	putRepo(st: FakeRepoState): void {
		this.repos.set(st.name, st);
	}

	resolveRef(st: FakeRepoState, ref: string): string | null {
		const branch = st.branches.get(ref);
		if (branch !== undefined) return branch;
		if (st.commits.has(ref)) return ref;
		return null;
	}

	mintToken(st: FakeRepoState, scope: TokenScope, ttl: number): FakeToken {
		const now = this.nowMs();
		const t: FakeToken = {
			id: `tok_${randomHex(8)}`,
			plaintext: `seam_fake_${randomHex(32)}`,
			scope,
			createdAt: new Date(now).toISOString(),
			expiresAt: new Date(now + ttl * 1000).toISOString(),
			revoked: false,
		};
		st.tokens.set(t.id, t);
		return t;
	}

	/** Find a token by plaintext within a repo; throws typed auth errors. */
	private requireValidToken(st: FakeRepoState, plaintext: string, needWrite: boolean): FakeToken {
		let found: FakeToken | null = null;
		for (const t of st.tokens.values()) {
			if (t.plaintext === plaintext) {
				found = t;
				break;
			}
		}
		if (!found) {
			// A token minted on ANOTHER repo (or a garbage string) is not
			// present in this repo's token namespace → not authorized here.
			throw new ArtifactAuthError("TOKEN_NOT_FOUND", `token not found on repo ${st.name}`);
		}
		const state = tokenState(found, this.nowMs());
		if (state === "revoked") throw new ArtifactAuthError("TOKEN_REVOKED", `token ${found.id} revoked`);
		if (state === "expired") throw new ArtifactAuthError("TOKEN_EXPIRED", `token ${found.id} expired`);
		if (needWrite && found.scope !== "write") {
			throw new ArtifactAuthError("SCOPE_DENIED", `token ${found.id} has scope ${found.scope}; write required`);
		}
		return found;
	}

	/** Enforce the 32 MB / 1 GB limits; returns new unique blob bytes. */
	private checkLimits(st: FakeRepoState, tree: Record<string, string>): number {
		let newBytes = 0;
		for (const content of Object.values(tree)) {
			const size = utf8Bytes(content);
			if (size > FAKE_MAX_BLOB_BYTES) {
				throw new ArtifactLimitError(
					"BLOB_TOO_LARGE",
					`blob of ${size} bytes exceeds the 32 MB limit`,
				);
			}
			if (!st.blobBytes.has(content)) newBytes += size;
		}
		if (repoBytes(st) + newBytes > FAKE_MAX_REPO_BYTES) {
			throw new ArtifactLimitError(
				"REPO_QUOTA_EXCEEDED",
				`repo ${st.name} would exceed the 1 GB limit`,
			);
		}
		return newBytes;
	}

	private async storeCommit(
		st: FakeRepoState,
		ref: string,
		tree: Record<string, string>,
		message: string,
		parents?: string[],
	): Promise<string> {
		const resolvedParents = parents ?? (st.branches.has(ref) ? [st.branches.get(ref) as string] : []);
		this.checkLimits(st, tree);
		for (const content of Object.values(tree)) {
			if (!st.blobBytes.has(content)) st.blobBytes.set(content, utf8Bytes(content));
		}
		const treeHash = await sha256Hex(canonicalJson(tree));
		const hash = await sha256Hex(canonicalJson({ parents: resolvedParents, tree, message }));
		st.commits.set(hash, {
			parents: resolvedParents,
			tree: { ...tree },
			message,
			treeHash,
		});
		st.branches.set(ref, hash);
		st.lastPushAt = new Date(this.nowMs()).toISOString();
		return hash;
	}

	/* ------------------------- ArtifactsPort ------------------------ */

	async create(
		name: string,
		opts?: { readOnly?: boolean; description?: string; setDefaultBranch?: string },
	): Promise<CreateRepoResult> {
		if (!/^[A-Za-z0-9._-]+$/.test(name)) {
			throw new ArtifactStateError("INVALID_INPUT", `invalid repo name: ${name}`);
		}
		if (this.repos.has(name)) {
			throw new ArtifactStateError("ALREADY_EXISTS", `repo already exists: ${name}`);
		}
		const st: FakeRepoState = {
			name,
			defaultBranch: opts?.setDefaultBranch ?? "main",
			description: opts?.description ?? null,
			readOnly: opts?.readOnly ?? false,
			createdAt: new Date(this.nowMs()).toISOString(),
			lastPushAt: null,
			commits: new Map(),
			branches: new Map(),
			tokens: new Map(),
			blobBytes: new Map(),
		};
		this.repos.set(name, st);
		const token = this.mintToken(st, "write", 86400);
		return { name, remote: `fake://${name}`, tokenPlaintext: token.plaintext };
	}

	async get(name: string): Promise<ArtifactsRepo> {
		this.requireRepo(name);
		return new FakeRepo(this, name);
	}

	async list(opts?: { limit?: number; cursor?: string }): Promise<RepoListResult> {
		const all = [...this.repos.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
		const start = opts?.cursor === undefined ? 0 : Number.parseInt(opts.cursor, 10);
		const limit = opts?.limit ?? 50;
		const page = all.slice(start, start + limit);
		const summaries: RepoSummary[] = page.map((st) => ({
			name: st.name,
			defaultBranch: st.defaultBranch,
			createdAt: st.createdAt,
			lastPushAt: st.lastPushAt,
		}));
		const next = start + limit < all.length ? String(start + limit) : undefined;
		return { repos: summaries, total: all.length, cursor: next };
	}

	async delete(name: string): Promise<boolean> {
		if (!/^[A-Za-z0-9._-]+$/.test(name)) {
			throw new ArtifactStateError("INVALID_INPUT", `invalid repo name: ${name}`);
		}
		return this.repos.delete(name);
	}

	/* ------------------------- SimulatedGit ------------------------- */
	/* TEST/SIMULATION ONLY — no production equivalents in the Worker.  */

	async pushAsToken(args: {
		repo: string;
		ref: string;
		tree: Record<string, string>;
		message: string;
		parents?: string[];
		token: string;
	}): Promise<string> {
		const st = this.requireRepo(args.repo);
		this.requireValidToken(st, args.token, true);
		return this.storeCommit(st, args.ref, args.tree, args.message, args.parents);
	}

	async readTreeAsToken(args: {
		repo: string;
		ref: string;
		token: string;
	}): Promise<Record<string, string>> {
		const st = this.requireRepo(args.repo);
		this.requireValidToken(st, args.token, false);
		const resolved = this.resolveRef(st, args.ref);
		if (resolved === null) {
			throw new ArtifactStateError("NOT_FOUND", `ref not found: ${args.ref}`);
		}
		const commit = st.commits.get(resolved);
		if (!commit) throw new ArtifactStateError("NOT_FOUND", `commit not found: ${resolved}`);
		return { ...commit.tree };
	}

	async adminPush(args: {
		repo: string;
		ref: string;
		tree: Record<string, string>;
		message: string;
		parents?: string[];
	}): Promise<string> {
		// CONTROL-PLANE ONLY: bypasses token checks entirely (in production
		// this is the merge sandbox with a merge-scoped token — unreachable
		// from contenders). Size limits still enforced.
		const st = this.requireRepo(args.repo);
		return this.storeCommit(st, args.ref, args.tree, args.message, args.parents);
	}
}
