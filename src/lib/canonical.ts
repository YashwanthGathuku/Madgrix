/**
 * Canonical JSON + hashing primitives.
 *
 * Works identically in Workers and in Node (WebCrypto). All hashes in the
 * protocol are SHA-256 over canonical JSON so that independent verifiers
 * recompute identical digests.
 */

/** Deterministic JSON: object keys sorted recursively, no whitespace. */
export function canonicalJson(value: unknown): string {
	if (value === null || value === undefined) return "null";
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
	}
	throw new Error(`canonicalJson: unsupported value type ${typeof value}`);
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
	const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
	const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomHex(bytes: number): string {
	const buf = new Uint8Array(bytes);
	crypto.getRandomValues(buf);
	return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The specs write hash inputs as `a || b || c`. Concatenation of
 * variable-length fields is ambiguous, so this module defines the single
 * encoding used everywhere: components joined with a NUL separator byte.
 * All components in our hashes are hex digests or short ASCII tokens, so
 * NUL never appears inside a component and the encoding is injective.
 * (An encoding clarification, not a contract change.)
 */
const HASH_PART_SEPARATOR = String.fromCharCode(0);
export function joinHashParts(...parts: string[]): string {
	return parts.join(HASH_PART_SEPARATOR);
}
