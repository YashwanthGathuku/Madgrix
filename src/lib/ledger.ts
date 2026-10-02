/**
 * Hash-chained task ledger (specs/amendments/authority-signing-v1.md).
 *
 *   entry_hash = SHA-256(canonical_json({ seq, ts, kind, payload_hash, prev_hash }))
 *   prev_hash  = entry_hash of the previous entry; LEDGER_GENESIS_PREV_HASH
 *                (64 zeros) for the genesis entry.
 *
 * The head (the last entry_hash) commits to every entry before it. A
 * promotion bundle carries the entries plus a head signed by the task
 * authority, so an offline verifier detects any changed, inserted, removed
 * or reordered entry.
 */

import { canonicalJson } from "./canonical.ts";
import type { LedgerEntry } from "./types.ts";

export const LEDGER_GENESIS_PREV_HASH = "0".repeat(64);

type Sha256Hex = (input: string) => Promise<string>;

export function ledgerEntryHash(entry: Omit<LedgerEntry, "entry_hash">, sha256Hex: Sha256Hex): Promise<string> {
	return sha256Hex(
		canonicalJson({
			seq: entry.seq,
			ts: entry.ts,
			kind: entry.kind,
			payload_hash: entry.payload_hash,
			prev_hash: entry.prev_hash,
		}),
	);
}

function isSealed(entry: LedgerEntry): boolean {
	return typeof entry.entry_hash === "string" && entry.entry_hash !== "";
}

/**
 * Link and hash, in order, every entry not yet sealed: the genesis entry
 * (createAuthority is synchronous and cannot hash) and entries persisted
 * before the ledger was chained. Sealed entries are kept as they are.
 */
export async function sealLedger(entries: LedgerEntry[], sha256Hex: Sha256Hex): Promise<LedgerEntry[]> {
	if (entries.every(isSealed)) return entries;
	const sealed: LedgerEntry[] = [];
	let prev = LEDGER_GENESIS_PREV_HASH;
	for (const entry of entries) {
		if (isSealed(entry)) {
			sealed.push(entry);
		} else {
			const fields = { seq: entry.seq, ts: entry.ts, kind: entry.kind, payload_hash: entry.payload_hash, prev_hash: prev };
			sealed.push({ ...fields, entry_hash: await ledgerEntryHash(fields, sha256Hex) });
		}
		prev = sealed[sealed.length - 1].entry_hash;
	}
	return sealed;
}

/** Recompute the chain from genesis: the head hash, or the first break. */
export async function verifyLedgerChain(
	entries: unknown,
	sha256Hex: Sha256Hex,
): Promise<{ ok: true; head: string } | { ok: false; detail: string }> {
	if (!Array.isArray(entries) || entries.length === 0) return { ok: false, detail: "bundle carries no ledger entries" };
	let prev = LEDGER_GENESIS_PREV_HASH;
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i] as LedgerEntry;
		if (entry === null || typeof entry !== "object") return { ok: false, detail: `entry ${i} is not an object` };
		if (entry.seq !== i) return { ok: false, detail: `entry ${i} has seq ${entry.seq}` };
		if (entry.prev_hash !== prev) return { ok: false, detail: `entry ${i} does not link to the entry before it` };
		if (entry.entry_hash !== (await ledgerEntryHash(entry, sha256Hex))) {
			return { ok: false, detail: `entry ${i} hash does not recompute` };
		}
		prev = entry.entry_hash;
	}
	return { ok: true, head: prev };
}
