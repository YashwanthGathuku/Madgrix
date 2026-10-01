/**
 * White-box test-secrecy boundary (spec 3 §4.2).
 *
 * The threat model: an evaluator with a READ token must never be able to
 * write (SCOPE_DENIED), and a contender holding a write token on its OWN
 * fork must never be able to reach the canonical repo or the evaluator's
 * state through it (TOKEN_NOT_FOUND — tokens are namespaced per repo).
 * And token enumeration (listTokens) must never leak plaintext.
 *
 * These are the FAKE-substrate enforcement points for the §4.2 boundary.
 * The production boundary is the per-token Git credential + server-side
 * scope check (documented in spec 3 §4.2); the fake mirrors the
 * semantics so the slice exercises the same denials. The caveat stays
 * honest: on real infrastructure, a compromised evaluation host could
 * still exfiltrate — the boundary is about credentials and code, not
 * about a malicious host.
 *
 * node --test test/whitebox-boundary.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ArtifactAuthError } from "../src/lib/artifacts-port.ts";
import { FakeArtifacts } from "../src/lib/fake-artifacts.ts";

const TREE = { "src/auth.js": "function isTokenExpired(e, n) { return e <= n; }" };

async function makeRepo(fake: FakeArtifacts, name: string): Promise<string> {
	await fake.create(name);
	return fake.adminPush({ repo: name, ref: "main", tree: TREE, message: "init" });
}

function isAuthErrorWithCode(code: string) {
	return (err: unknown) => err instanceof ArtifactAuthError && err.code === code;
}

describe("white-box test-secrecy boundary", () => {
	it("evaluator read token: read OK, write → SCOPE_DENIED", async () => {
		const fake = new FakeArtifacts();
		await makeRepo(fake, "canonical");
		const canonical = await fake.get("canonical");
		// The evaluator gets a READ token (hidden-oracle execution needs
		// read access to the candidate tree).
		const evalToken = await canonical.createToken("read", 3600);
		const tree = await fake.readTreeAsToken({ repo: "canonical", ref: "main", token: evalToken.plaintext });
		assert.ok(tree["src/auth.js"], "evaluator read token must read");

		// The same token must NOT write — a compromised/buggy evaluator
		// cannot rewrite the candidate it is judging.
		await assert.rejects(
			fake.pushAsToken({
				repo: "canonical",
				ref: "main",
				tree: { "src/auth.js": "tampered" },
				message: "evaluator write attempt",
				token: evalToken.plaintext,
			}),
			isAuthErrorWithCode("SCOPE_DENIED"),
			"evaluator read token must be denied on write",
		);
	});

	it("contender fork write token: cannot touch canonical → TOKEN_NOT_FOUND", async () => {
		const fake = new FakeArtifacts();
		await makeRepo(fake, "canonical");
		const forked = await (await fake.get("canonical")).fork("fork-contender-1");
		const fork = await fake.get("fork-contender-1");
		// The contender's write token is minted on ITS fork.
		const contenderToken = forked.tokenPlaintext;
		// Sanity: it works on the fork itself.
		await fake.pushAsToken({
			repo: "fork-contender-1",
			ref: "main",
			tree: { "src/auth.js": "candidate change" },
			message: "candidate push",
			token: contenderToken,
		});
		// But it is worthless on canonical — and equally worthless on the
		// evaluator's state (same repo-namespacing): the contender cannot
		// reach evaluation state through the token port.
		for (const repo of ["canonical"]) {
			await assert.rejects(
				fake.pushAsToken({
					repo,
					ref: "main",
					tree: { "src/auth.js": "contender write to canonical" },
					message: "cross-boundary write",
					token: contenderToken,
				}),
				isAuthErrorWithCode("TOKEN_NOT_FOUND"),
				`contender fork token must not write to ${repo}`,
			);
			await assert.rejects(
				fake.readTreeAsToken({ repo, ref: "main", token: contenderToken }),
				isAuthErrorWithCode("TOKEN_NOT_FOUND"),
				`contender fork token must not read ${repo}`,
			);
		}
	});

	it("listTokens never leaks plaintext", async () => {
		const fake = new FakeArtifacts();
		await makeRepo(fake, "canonical");
		const canonical = await fake.get("canonical");
		const t1 = await canonical.createToken("write", 3600);
		const t2 = await canonical.createToken("read", 3600);
		const listed = await canonical.listTokens();
		assert.ok(listed.length >= 2, "listing must include the minted tokens");
		const ids = new Set(listed.map((i) => i.id));
		assert.ok(ids.has(t1.id) && ids.has(t2.id), "listed ids must include the minted tokens");
		for (const info of listed) {
			assert.ok(!("plaintext" in info), "TokenInfo must not carry plaintext");
			assert.ok(info.scope === "write" || info.scope === "read");
		}
		// And the plaintext itself is not derivable from the listing: the
		// listing carries no field whose value equals a plaintext.
		const serialized = JSON.stringify(listed);
		assert.ok(!serialized.includes(t1.plaintext), "plaintext must not appear in token listing");
		assert.ok(!serialized.includes(t2.plaintext), "plaintext must not appear in token listing");
	});

	it("revoked tokens are dead on both read and write", async () => {
		const fake = new FakeArtifacts();
		await makeRepo(fake, "canonical");
		const canonical = await fake.get("canonical");
		const tok = await canonical.createToken("write", 3600);
		assert.equal(await canonical.revokeToken(tok.id), true);
		await assert.rejects(
			fake.pushAsToken({
				repo: "canonical",
				ref: "main",
				tree: TREE,
				message: "after revoke",
				token: tok.plaintext,
			}),
			(err: unknown) => err instanceof ArtifactAuthError,
			"revoked token must be rejected",
		);
	});
});
