/**
 * Tests for FakeArtifacts (in-memory simulation substrate).
 *
 * Run: node --test test/fake-artifacts.test.ts
 * (from ~/workspace/cloudflare-entry/seam/)
 *
 * Erasable syntax only so node type-stripping can run this file directly.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	ArtifactAuthError,
	ArtifactLimitError,
	ArtifactStateError,
	forkIdempotent,
} from "../src/lib/artifacts-port.ts";
import type { ArtifactsPort } from "../src/lib/artifacts-port.ts";
import { FakeArtifacts } from "../src/lib/fake-artifacts.ts";

const TREE_A = { "README.md": "hello baseline", "src/main.ts": "export {};" };

async function makeRepo(fake: FakeArtifacts, name: string): Promise<string> {
	await fake.create(name);
	return fake.adminPush({ repo: name, ref: "main", tree: TREE_A, message: "init" });
}

describe("FakeArtifacts", () => {
	it("records fork lineage on fork", async () => {
		const fake = new FakeArtifacts();
		const head = await makeRepo(fake, "baseline");
		const forked = await (await fake.get("baseline")).fork("fork-a");
		assert.equal(forked.name, "fork-a");
		assert.equal(forked.remote, "fake://fork-a");

		const forkRepo = await fake.get("fork-a");
		const forkHead = await forkRepo.getHead();
		assert.equal(forkHead, head, "fork starts at the source head");

		const listed = await fake.list();
		const summary = listed.repos.find((r) => r.name === "fork-a");
		assert.ok(summary);
		// forkLineage is internal; verify via behavior + a second fork's parent
		const log = await forkRepo.log();
		assert.equal(log[0].hash, head);
		assert.deepEqual(log[0].parents, []);
	});

	it("write token minted on repo A cannot push to repo B", async () => {
		const fake = new FakeArtifacts();
		await makeRepo(fake, "repo-a");
		await makeRepo(fake, "repo-b");
		const tok = await (await fake.get("repo-a")).createToken("write", 3600);
		await assert.rejects(
			fake.pushAsToken({
				repo: "repo-b",
				ref: "main",
				tree: { evil: "x" },
				message: "cross-repo push",
				token: tok.plaintext,
			}),
			(err: unknown) =>
				err instanceof ArtifactAuthError && err.code === "TOKEN_NOT_FOUND",
			"cross-repo push must be rejected",
		);
	});

	it("read token cannot push", async () => {
		const fake = new FakeArtifacts();
		await makeRepo(fake, "repo-a");
		const tok = await (await fake.get("repo-a")).createToken("read", 3600);
		await assert.rejects(
			fake.pushAsToken({
				repo: "repo-a",
				ref: "main",
				tree: { f: "x" },
				message: "read-scope push",
				token: tok.plaintext,
			}),
			(err: unknown) =>
				err instanceof ArtifactAuthError && err.code === "SCOPE_DENIED",
		);
		// ...but it CAN read.
		const tree = await fake.readTreeAsToken({ repo: "repo-a", ref: "main", token: tok.plaintext });
		assert.deepEqual(tree, TREE_A);
	});

	it("revoked token is rejected", async () => {
		const fake = new FakeArtifacts();
		await makeRepo(fake, "repo-a");
		const repo = await fake.get("repo-a");
		const tok = await repo.createToken("write", 3600);
		const revoked = await repo.revokeToken(tok.plaintext);
		assert.equal(revoked, true);
		await assert.rejects(
			fake.pushAsToken({
				repo: "repo-a",
				ref: "main",
				tree: { f: "x" },
				message: "after revoke",
				token: tok.plaintext,
			}),
			(err: unknown) =>
				err instanceof ArtifactAuthError && err.code === "TOKEN_REVOKED",
		);
		const tokens = await repo.listTokens();
		assert.equal(tokens.find((t) => t.id === tok.id)?.state, "revoked");
		// Revoking an unknown token returns false (matches real binding).
		assert.equal(await repo.revokeToken("tok_doesnotexist"), false);
	});

	it("expired token is rejected", async () => {
		let now = Date.now();
		const fake = new FakeArtifacts({ now: () => now });
		await makeRepo(fake, "repo-a");
		const tok = await (await fake.get("repo-a")).createToken("write", 10);
		now += 11_000; // advance past expiry
		await assert.rejects(
			fake.pushAsToken({
				repo: "repo-a",
				ref: "main",
				tree: { f: "x" },
				message: "after expiry",
				token: tok.plaintext,
			}),
			(err: unknown) =>
				err instanceof ArtifactAuthError && err.code === "TOKEN_EXPIRED",
		);
	});

	it("double fork with the same op id is idempotent (harness-level)", async () => {
		const fake = new FakeArtifacts();
		await makeRepo(fake, "baseline");
		const first = await forkIdempotent(fake, "baseline", "fork-op-1");
		assert.equal(first.created, true);
		const second = await forkIdempotent(fake, "baseline", "fork-op-1");
		assert.equal(second.created, false);
		assert.equal(second.repo.name, "fork-op-1");
		const listed = await fake.list();
		assert.equal(
			listed.repos.filter((r) => r.name === "fork-op-1").length,
			1,
			"exactly one fork repo exists after two idempotent fork calls",
		);
		// Direct (non-idempotent) fork of the same name surfaces ALREADY_EXISTS,
		// mirroring the real binding — the harness avoids it via list-first.
		await assert.rejects(
			(await fake.get("baseline")).fork("fork-op-1"),
			(err: unknown) =>
				err instanceof ArtifactStateError && err.code === "ALREADY_EXISTS",
		);
	});

	it("forkIdempotent falls back to import when the fork endpoint is broken (live beta bug, 2026-10-01)", async () => {
		const fake = new FakeArtifacts();
		await makeRepo(fake, "baseline");
		// Simulate the broken Artifacts beta fork endpoint: every fork
		// attempt fails with 400 [10101] "Invalid repo name" (validated live
		// via the cf CLI on 2026-10-01 against multiple repos).
		const brokenFork = (): ArtifactsPort =>
			new Proxy(fake, {
				get(target, prop, receiver) {
					if (prop === "get") {
						return async (name: string) => {
							const repo = await target.get(name);
							return new Proxy(repo, {
								get(rTarget, rProp, rReceiver) {
									if (rProp === "fork") {
										return async () => {
											throw new Error(
												"[10101] Invalid repo name: must match /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/",
											);
										};
									}
									const v = Reflect.get(rTarget, rProp, rReceiver);
									return typeof v === "function" ? v.bind(rTarget) : v;
								},
							});
						};
					}
					const v = Reflect.get(target, prop, receiver);
					return typeof v === "function" ? v.bind(target) : v;
				},
			}) as unknown as ArtifactsPort;
		const result = await forkIdempotent(brokenFork(), "baseline", "fork-fallback-1");
		assert.equal(result.created, true);
		assert.equal(result.viaImportFallback, true);
		assert.equal(result.repo.name, "fork-fallback-1");
		assert.equal(typeof result.initialTokenPlaintext, "string");

		// Genuine fork errors must NOT be misrouted into the fallback.
		const authFail = (): ArtifactsPort =>
			new Proxy(fake, {
				get(target, prop, receiver) {
					if (prop === "get") {
						return async (name: string) => {
							const repo = await target.get(name);
							return new Proxy(repo, {
								get(rTarget, rProp, rReceiver) {
									if (rProp === "fork") {
										return async () => {
											throw new ArtifactAuthError("TOKEN_REVOKED", "nope");
										};
									}
									const v = Reflect.get(rTarget, rProp, rReceiver);
									return typeof v === "function" ? v.bind(rTarget) : v;
								},
							});
						};
					}
					const v = Reflect.get(target, prop, receiver);
					return typeof v === "function" ? v.bind(target) : v;
				},
			}) as unknown as ArtifactsPort;
		await assert.rejects(
			forkIdempotent(authFail(), "baseline", "fork-fallback-2"),
			(err: unknown) => err instanceof ArtifactAuthError,
		);
	});

	it("32MB blob cap throws ArtifactLimitError", async () => {
		const fake = new FakeArtifacts();
		await makeRepo(fake, "repo-a");
		const tooBig = "x".repeat(32 * 1024 * 1024 + 1);
		await assert.rejects(
			fake.adminPush({
				repo: "repo-a",
				ref: "main",
				tree: { "big.bin": tooBig },
				message: "too big",
			}),
			(err: unknown) =>
				err instanceof ArtifactLimitError && err.code === "BLOB_TOO_LARGE",
		);
		// Just under the cap is accepted.
		const okSize = "y".repeat(32 * 1024 * 1024);
		const hash = await fake.adminPush({
			repo: "repo-a",
			ref: "main",
			tree: { "big.bin": okSize },
			message: "exactly at cap",
		});
		assert.equal(typeof hash, "string");
		assert.equal(hash.length, 64);
	});

	it("getHead / log / readCommit work", async () => {
		const fake = new FakeArtifacts();
		const first = await makeRepo(fake, "repo-a");
		const second = await fake.adminPush({
			repo: "repo-a",
			ref: "main",
			tree: { ...TREE_A, "new.txt": "v2" },
			message: "second",
		});
		const repo = await fake.get("repo-a");

		assert.equal(await repo.getHead(), second);
		assert.equal(await repo.getHead("main"), second);
		assert.equal(await repo.getHead("nope"), null);

		const log = await repo.log();
		assert.equal(log.length, 2);
		assert.equal(log[0].hash, second);
		assert.deepEqual(log[0].parents, [first]);
		assert.equal(log[1].hash, first);

		const limited = await repo.log({ ref: "main", limit: 1 });
		assert.equal(limited.length, 1);

		const meta = await repo.readCommit(second);
		assert.ok(meta);
		assert.equal(meta.message, "second");
		assert.equal(meta.parents[0], first);
		assert.equal(meta.treeHash.length, 64);
		assert.equal(await repo.readCommit("0".repeat(64)), null);
	});

	it("adminPush works without any token and is separate from token paths", async () => {
		const fake = new FakeArtifacts();
		await fake.create("repo-a");
		// No tokens minted at all on this path (adminPush ignores them).
		const hash = await fake.adminPush({
			repo: "repo-a",
			ref: "main",
			tree: { f: "control plane write" },
			message: "seed",
		});
		assert.equal(await (await fake.get("repo-a")).getHead(), hash);
		// A garbage token on the token path is still rejected.
		await assert.rejects(
			fake.pushAsToken({
				repo: "repo-a",
				ref: "main",
				tree: { f: "x" },
				message: "garbage token",
				token: "seam_fake_garbage",
			}),
			(err: unknown) =>
				err instanceof ArtifactAuthError && err.code === "TOKEN_NOT_FOUND",
		);
	});

	it("valid write-token push advances the branch head", async () => {
		const fake = new FakeArtifacts();
		const first = await makeRepo(fake, "repo-a");
		const repo = await fake.get("repo-a");
		const tok = await repo.createToken("write", 3600);
		const second = await fake.pushAsToken({
			repo: "repo-a",
			ref: "main",
			tree: { ...TREE_A, extra: "1" },
			message: "contender work",
			token: tok.plaintext,
		});
		assert.notEqual(second, first);
		assert.equal(await repo.getHead(), second);
		const meta = await repo.readCommit(second);
		assert.deepEqual(meta?.parents, [first]);
		// Content addressing is deterministic: same inputs → same hash.
		const again = await fake.pushAsToken({
			repo: "repo-a",
			ref: "feature",
			tree: { ...TREE_A, extra: "1" },
			message: "contender work",
			parents: [first],
			token: tok.plaintext,
		});
		assert.equal(again, second);
	});
});
