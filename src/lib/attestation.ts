/**
 * Attestation protocol: in-toto + DSSE + the ONE custom object
 * (spec 4: ATTESTATION_PROTOCOL.md).
 *
 * This REPLACES the old HMAC-with-shared-secret design (gap analysis
 * item 4): no proprietary envelope, no custom signature scheme. Every
 * attestation is an in-toto Statement bound to an immutable subject
 * digest; statements are wrapped as DSSE envelopes and signed by the
 * promotion-authority key held in the control plane (SLSA trust
 * boundary, spec 3 §2).
 *
 * Chain: work intent → in-toto Link → test result → verification
 * result → promotion authority → ship record. Each link's subject
 * digests MUST chain; a verifier recomputes the chain and any break
 * fails verification.
 *
 * Bit-for-bit promotion assumption (documented, NOT a spec change): the
 * "candidate digest" check in verifyBundle assumes promotion writes the
 * reviewed commit to the canonical repo bit-for-bit — same tree, same
 * message, same parents — so the shipped commit SHA is identical to the
 * reviewed candidate SHA. This holds by construction of the promotion
 * path: attemptPromotion (task-state.ts) emits a canonical_write effect
 * carrying only the reviewed tree_sha256 and the expected parent; the
 * promotion service (the ONLY canonical writer, spec 3 §2) creates no
 * merge commit and performs no re-encoding — it stores
 * SHA256(canonical_json({parents, tree, message})) with the candidate's
 * own tree/message and the reviewed parent (fake-artifacts.ts
 * storeCommit; the slice's harness asserts promotedSha === winner_sha).
 * If a future promotion path ever re-encodes or re-parents the candidate
 * tree, verifyBundle's candidate-digest check will fail closed rather
 * than silently bless a different artifact — that is the correct behavior
 * here, because "reviewed at SHA X ships at SHA X" is the binding the
 * attestation makes.
 *
 * The predicateType URIs for the reused in-toto predicates are
 * slice-level constants; spec 4 §8 leaves the exact reuse-vs-subtype
 * decision OPEN. The AgentPromotionAuthority/v1 URI is FROZEN by
 * spec 4 §4 (revisit when the public product name is chosen).
 */

import { canonicalJson, sha256Hex } from "./canonical.ts";
import { verifyLedgerChain } from "./ledger.ts";
import { buildPermitId } from "./permit.ts";
import type { LedgerEntry } from "./types.ts";

/* ------------------------------------------------------------------ */
/* in-toto statement                                                   */
/* ------------------------------------------------------------------ */

export interface InTotoStatement {
	_type: "https://in-toto.io/Statement/v1";
	subject: { digest: { sha256: string } }[];
	predicateType: string;
	predicate: unknown;
}

/** FROZEN by spec 4 §4. */
export const AGENT_PROMOTION_AUTHORITY_V1 = "https://seam.dev/AgentPromotionAuthority/v1";

/* Slice-level predicate types for the reused in-toto predicates
 * (spec 4 §8: exact URIs still OPEN — reuse as-is vs seam subtypes). */
export const LINK_PREDICATE_TYPE = "https://in-toto.io/attestation/link/v1";
export const TEST_RESULT_PREDICATE_TYPE = "https://in-toto.io/attestation/test-result/v1";
export const VERIFICATION_RESULT_PREDICATE_TYPE =
	"https://in-toto.io/attestation/verification-result/v1";

/* ------------------------------------------------------------------ */
/* The one custom object: AgentPromotionAuthority/v1 (spec 4 §4).      */
/* ------------------------------------------------------------------ */

export interface AgentPromotionAuthorityPredicate {
	intent: { digest: string };
	baseline: { git_commit: string };
	candidate: { repo: string; commit: string; tree_sha256: string };
	evaluation: { bundle_sha256: string };
	verification: { result: "PASSED" | "FAILED"; policy_sha256: string };
	destination: { repo: string; expected_parent: string };
	authority: { nonce: string; single_use: true; permit_id: string; issued_at: string };
	/**
	 * Head of the task authority's hash-chained ledger when the bundle was
	 * signed (authority-signing-v1). Signing it here binds the ledger the
	 * bundle carries; the verifier recomputes the chain to this head.
	 */
	ledger?: { head_sha256: string };
}

/* ------------------------------------------------------------------ */
/* DSSE                                                                */
/* ------------------------------------------------------------------ */

export interface Signer {
	sign(payload: Uint8Array): Promise<{ signature: string; keyid: string }>;
	verify(payload: Uint8Array, signature: string, keyid: string): Promise<boolean>;
}

export interface DsseEnvelope {
	payloadType: "application/vnd.in-toto+json";
	payload: string;
	signatures: { keyid: string; sig: string }[];
}

/* ------------------------------------------------------------------ */
/* Statement builders                                                  */
/* ------------------------------------------------------------------ */

function statement(predicateType: string, treeSha256: string, predicate: unknown): InTotoStatement {
	return {
		_type: "https://in-toto.io/Statement/v1",
		subject: [{ digest: { sha256: treeSha256 } }],
		predicateType,
		predicate,
	};
}

/** in-toto LINK: materials = baseline commit digest, subject = candidate. */
export async function buildLinkStatement(input: {
	baselineCommit: string;
	candidateCommit: string;
	treeSha256: string;
}): Promise<InTotoStatement> {
	return statement(LINK_PREDICATE_TYPE, input.treeSha256, {
		materials: [{ uri: `git:${input.baselineCommit}` }],
		byproducts: { candidate_commit: input.candidateCommit },
	});
}

/** Test result (in-toto test-result predicate): subject = candidate SHA-256,
 *  predicate carries test configuration digest + PASS/WARN/FAIL. */
export async function buildTestResultStatement(input: {
	treeSha256: string;
	candidateCommit: string;
	testConfigDigest: string;
	result: "PASS" | "WARN" | "FAIL";
}): Promise<InTotoStatement> {
	return statement(TEST_RESULT_PREDICATE_TYPE, input.treeSha256, {
		result: input.result,
		configuration: { digest: { sha256: input.testConfigDigest } },
		artifact: { commit: input.candidateCommit },
	});
}

/** Verification result (in-toto software-verification-result predicate):
 *  records which policy verified the artifact (policy_sha256). */
export async function buildVerificationResultStatement(input: {
	treeSha256: string;
	candidateCommit: string;
	policySha256: string;
	result: "PASSED" | "FAILED";
}): Promise<InTotoStatement> {
	return statement(VERIFICATION_RESULT_PREDICATE_TYPE, input.treeSha256, {
		result: input.result,
		policy: { digest: { sha256: input.policySha256 } },
		artifact: { commit: input.candidateCommit },
	});
}

/**
 * The ONE custom object (spec 4 §4). Rules enforced by construction:
 * - predicate.candidate.tree_sha256 MUST equal subject[0].digest.sha256
 * - single_use is always true (no multi-use promotion authority)
 * - nonce MUST be fresh per permit (cross-task replay defense)
 */
export async function buildPromotionAuthority(input: {
	taskHash: string;
	baselineCommit: string;
	candidateRepo: string;
	candidateCommit: string;
	treeSha256: string;
	evaluationBundleHash: string;
	verificationResult: "PASSED" | "FAILED";
	policySha256: string;
	destinationRepo: string;
	expectedParent: string;
	nonce: string;
	permitId: string;
	issuedAt: string;
	/** Ledger head at signing (authority-signing-v1). */
	ledgerHeadSha256?: string;
}): Promise<InTotoStatement> {
	const predicate: AgentPromotionAuthorityPredicate = {
		intent: { digest: input.taskHash },
		baseline: { git_commit: input.baselineCommit },
		candidate: {
			repo: input.candidateRepo,
			commit: input.candidateCommit,
			tree_sha256: input.treeSha256,
		},
		evaluation: { bundle_sha256: input.evaluationBundleHash },
		verification: { result: input.verificationResult, policy_sha256: input.policySha256 },
		destination: { repo: input.destinationRepo, expected_parent: input.expectedParent },
		authority: {
			nonce: input.nonce,
			single_use: true,
			permit_id: input.permitId,
			issued_at: input.issuedAt,
		},
		...(input.ledgerHeadSha256 === undefined ? {} : { ledger: { head_sha256: input.ledgerHeadSha256 } }),
	};
	return statement(AGENT_PROMOTION_AUTHORITY_V1, input.treeSha256, predicate);
}

/* ------------------------------------------------------------------ */
/* DSSE envelope sign/verify                                            */
/* ------------------------------------------------------------------ */

export async function signEnvelope(
	statement: InTotoStatement,
	signer: Signer,
): Promise<DsseEnvelope> {
	const payload = canonicalJson(statement);
	const { signature, keyid } = await signer.sign(new TextEncoder().encode(payload));
	return {
		payloadType: "application/vnd.in-toto+json",
		payload,
		signatures: [{ keyid, sig: signature }],
	};
}

export async function verifyEnvelope(
	env: DsseEnvelope,
	signer: Signer,
): Promise<{ valid: boolean; statement?: InTotoStatement; failure?: string }> {
	if (env.payloadType !== "application/vnd.in-toto+json") {
		return { valid: false, failure: `unexpected payloadType ${env.payloadType}` };
	}
	let parsed: InTotoStatement;
	try {
		parsed = JSON.parse(env.payload) as InTotoStatement;
	} catch {
		return { valid: false, failure: "payload is not valid JSON" };
	}
	if (!env.signatures || env.signatures.length === 0) {
		return { valid: false, failure: "envelope carries no signatures" };
	}
	const bytes = new TextEncoder().encode(env.payload);
	for (const s of env.signatures) {
		const ok = await signer.verify(bytes, s.sig, s.keyid);
		if (!ok) return { valid: false, failure: `signature by keyid ${s.keyid} did not verify` };
	}
	return { valid: true, statement: parsed };
}

/* ------------------------------------------------------------------ */
/* Promotion bundle verification (spec 4 §7 transcript).               */
/* ------------------------------------------------------------------ */

/** Promotion bundle, authority-signing-v1 (specs/amendments/authority-signing-v1.md). */
export interface PromotionBundle {
	version: 2;
	statements: DsseEnvelope[];
	ship: {
		repo: string;
		commit: string;
		tree_sha256: string;
		parent: string;
		permit_id: string;
	};
	/**
	 * The task authority's hash-chained ledger when the bundle was signed.
	 * `head_sha256` is also signed into the authority statement.
	 */
	ledger: { head_sha256: string; entries: LedgerEntry[] };
	/**
	 * SPKI DER (hex) of the authority key that signed the envelopes. A
	 * label, never a trust anchor: the verifier checks it equals the key it
	 * has pinned and verifies every signature with the pinned key.
	 */
	authority_pubkey_der_hex: string;
}

export interface VerifyLine {
	label: string;
	status: string;
	detail?: string;
}

function subjectDigest(s: InTotoStatement | null): string | null {
	return s?.subject?.[0]?.digest?.sha256 ?? null;
}

/**
 * `$ verify promotion.bundle` — the spec 4 §7 transcript as amended by
 * authority-signing-v1, IN ORDER. Any line failing → verified=false with
 * the failing line(s) named. Offline: the bundle carries everything except
 * the trust anchor. The caller pins the authority key: `signer` verifies
 * with it and `opts.trustedKeyDerHex` is its SPKI DER (hex). Statements
 * that do not verify under that key are not evaluated at all.
 */
export async function verifyBundle(
	bundle: PromotionBundle,
	signer: Signer,
	opts: { policyHash: string; trustedKeyDerHex: string },
): Promise<{ lines: VerifyLine[]; verified: boolean }> {
	const lines: VerifyLine[] = [];
	const fail = (label: string, detail: string): void => {
		lines.push({ label, status: "FAIL", detail });
	};

	// Parse + verify every envelope first.
	const parsed: (InTotoStatement | null)[] = [];
	let signaturesOk = true;
	let signatureDetail: string | undefined;
	for (const env of bundle.statements) {
		const r = await verifyEnvelope(env, signer);
		if (!r.valid) {
			signaturesOk = false;
			signatureDetail = r.failure;
			parsed.push(null);
		} else {
			parsed.push(r.statement as InTotoStatement);
		}
	}
	const byType = (t: string): InTotoStatement | null =>
		parsed.find((s) => s !== null && s.predicateType === t) ?? null;
	const link = byType(LINK_PREDICATE_TYPE);
	const test = byType(TEST_RESULT_PREDICATE_TYPE);
	const verif = byType(VERIFICATION_RESULT_PREDICATE_TYPE);
	const auth = byType(AGENT_PROMOTION_AUTHORITY_V1);
	const ap = (auth?.predicate ?? null) as AgentPromotionAuthorityPredicate | null;

	// 1. subject digest — recomputes from the ship tree.
	if (subjectDigest(auth) !== null && subjectDigest(auth) === bundle.ship.tree_sha256) {
		lines.push({ label: "subject digest", status: "OK" });
	} else {
		fail(
			"subject digest",
			`authority subject ${subjectDigest(auth)} != ship tree ${bundle.ship.tree_sha256}`,
		);
	}

	// 2. candidate digest — candidate commit+tree match the attested digests.
	// ASSUMPTION (documented in this module's doc comment): promotion
	// preserves the reviewed commit bit-for-bit — the promotion path
	// (task-state.ts attemptPromotion → canonical_write effect → sole
	// canonical writer) creates no merge commit and performs no
	// re-encoding; the commit hash is a pure function of
	// {parents, tree, message}, so the shipped commit IS the reviewed
	// candidate SHA. Any re-encoding/re-parenting upstream would land
	// here as a FAIL, which is the correct fail-closed behavior (reviewed
	// at SHA X must ship at SHA X; spec 3 §6 attack #7).
	if (
		ap !== null &&
		ap.candidate.commit === bundle.ship.commit &&
		ap.candidate.tree_sha256 === bundle.ship.tree_sha256
	) {
		lines.push({ label: "candidate digest", status: "OK" });
	} else {
		fail("candidate digest", "candidate commit+tree do not match the attested digests");
	}

	// 3. chain integrity — link → test → verification → authority subjects chain.
	const chain = [link, test, verif, auth].map(subjectDigest);
	if (chain.every((d) => d !== null && d === chain[0])) {
		lines.push({ label: "chain integrity", status: "OK" });
	} else {
		fail(
			"chain integrity",
			`link→test→verification→authority subjects do not chain: ${JSON.stringify(chain)}`,
		);
	}

	// 4. hidden evaluation — verification predicate result.
	const verifResult = (verif?.predicate as { result?: string } | undefined)?.result;
	if (verifResult === "PASSED") {
		lines.push({ label: "hidden evaluation", status: "PASSED" });
	} else {
		fail("hidden evaluation", `verification predicate result is ${verifResult ?? "missing"}`);
	}

	// 5. policy digest — selector policy hash matches the frozen policy.
	const verifPolicy = (
		verif?.predicate as { policy?: { digest?: { sha256?: string } } } | undefined
	)?.policy?.digest?.sha256;
	if (verifPolicy === opts.policyHash && ap?.verification.policy_sha256 === opts.policyHash) {
		lines.push({ label: "policy digest", status: "OK" });
	} else {
		fail("policy digest", "selector policy hash does not match the frozen policy");
	}

	// 6. destination parent — expected_parent matches the ship parent.
	if (ap !== null && ap.destination.expected_parent === bundle.ship.parent) {
		lines.push({ label: "destination parent", status: "OK" });
	} else {
		fail(
			"destination parent",
			`expected_parent ${ap?.destination.expected_parent} != ship parent ${bundle.ship.parent}`,
		);
	}

	// 7. authority key — the key the bundle names is the key the verifier
	// pinned. The embedded key is a label, never a trust anchor.
	if (
		typeof bundle.authority_pubkey_der_hex === "string" &&
		bundle.authority_pubkey_der_hex.toLowerCase() === opts.trustedKeyDerHex.toLowerCase()
	) {
		lines.push({ label: "authority key", status: "PINNED" });
	} else {
		fail("authority key", "the bundle's authority key is not the pinned authority key");
	}

	// 8. signature — every envelope verifies under the pinned key (offline).
	if (signaturesOk) {
		lines.push({ label: "signature", status: "VALID" });
	} else {
		fail("signature", signatureDetail ?? "a DSSE signature did not verify");
	}

	// 9. permit id — recomputes from the fields it binds (spec 1 §10,
	// spec 4 §4) and is the permit the ship record names. Whether a permit
	// was consumed once cannot be established offline; line 10 checks what
	// the authority's signed ledger records.
	const recomputedPermitId =
		ap === null
			? null
			: await buildPermitId(
					{
						task_hash: ap.intent?.digest,
						baseline_commit: ap.baseline?.git_commit,
						winning_tree_sha256: ap.candidate?.tree_sha256,
						evaluation_bundle_hash: ap.evaluation?.bundle_sha256,
						selector_policy_hash: ap.verification?.policy_sha256,
						expected_destination_head: ap.destination?.expected_parent,
					},
					sha256Hex,
				);
	if (ap !== null && recomputedPermitId === ap.authority?.permit_id && bundle.ship.permit_id === ap.authority.permit_id) {
		lines.push({ label: "permit id", status: "RECOMPUTED FROM BOUND FIELDS" });
	} else {
		fail("permit id", "permit_id does not recompute from its bound fields, or the ship record names another permit");
	}

	// 10. ledger chain — the entries hash-chain to the head signed into the
	// authority statement, and that signed ledger records this promotion
	// exactly once.
	const ledgerChain = await verifyLedgerChain(bundle.ledger?.entries, sha256Hex);
	if (!ledgerChain.ok) {
		fail("ledger chain", ledgerChain.detail);
	} else if (ledgerChain.head !== bundle.ledger.head_sha256 || ledgerChain.head !== ap?.ledger?.head_sha256) {
		fail("ledger chain", "the ledger does not end at the head signed into the authority statement");
	} else {
		const promotionPayloadHash = await sha256Hex(
			canonicalJson({ permit_id: bundle.ship.permit_id, tree_sha256: bundle.ship.tree_sha256 }),
		);
		const recorded = bundle.ledger.entries.filter(
			(e) => e.kind === "promotion_succeeded" && e.payload_hash === promotionPayloadHash,
		).length;
		if (recorded === 1) lines.push({ label: "ledger chain", status: "OK" });
		else fail("ledger chain", `the signed ledger records this promotion ${recorded} times (must be exactly once)`);
	}

	return { lines, verified: lines.every((l) => l.status !== "FAIL") };
}
