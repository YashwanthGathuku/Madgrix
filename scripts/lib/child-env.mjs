/**
 * Process-environment boundary for every child process the live-run scripts
 * spawn (docs/SECURITY.md "Process environment boundaries";
 * specs/amendments/process-env-boundaries.md).
 *
 * A child never inherits process.env. It gets the few variables a shell and
 * git need to function plus exactly the extras its caller names, so a
 * credential reaches a child only where the spawning code says so.
 */

/** The only variables copied from the parent, each only when it is set. */
export const BASE_ENV_VARS = Object.freeze(["PATH", "HOME", "LANG", "TMPDIR", "TERM"]);

/**
 * PATH, HOME, LANG, TMPDIR and TERM from this process, plus `extra`.
 * Extras whose value is undefined are left out, so optional settings can be
 * forwarded as `{ NAME: process.env.NAME }`.
 *
 * @param {Record<string, string | undefined>} [extra]
 * @returns {Record<string, string>}
 */
export function minimalEnv(extra = {}) {
	/** @type {Record<string, string>} */
	const env = {};
	for (const name of BASE_ENV_VARS) {
		const value = process.env[name];
		if (value !== undefined) env[name] = value;
	}
	for (const [name, value] of Object.entries(extra)) {
		if (value === undefined) continue;
		if (typeof value !== "string") throw new TypeError(`child env ${name} must be a string`);
		env[name] = value;
	}
	return env;
}

/**
 * Never passed through to a coding agent: the MADGRIX_ namespace (zone
 * service tokens and harness settings; the runner sets the agent's own
 * MADGRIX_* variables itself), anything named like a service token, and
 * Cloudflare credentials, which reach Artifacts and Workers directly and
 * would bypass the per-fork token scope.
 */
const NEVER_PASSED_TO_AGENT = /^MADGRIX_|SERVICE_TOKEN|CLOUDFLARE|^CF_/i;

/**
 * Parse MADGRIX_AGENT_ENV_ALLOWLIST: comma-separated names of variables the
 * operator explicitly passes through to the agent command (for the agent's
 * own model API key). Throws on a malformed entry, without echoing it, and
 * on a name that is never passed to an agent.
 *
 * @param {string | undefined} raw
 * @returns {string[]}
 */
export function parseAgentEnvAllowlist(raw) {
	const names = (raw ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	names.forEach((name, i) => {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
			// An entry like NAME=value would carry a secret; do not print it.
			throw new Error(`MADGRIX_AGENT_ENV_ALLOWLIST entry ${i + 1} is not an environment variable name`);
		}
		if (NEVER_PASSED_TO_AGENT.test(name)) {
			throw new Error(
				`MADGRIX_AGENT_ENV_ALLOWLIST names ${name}; MADGRIX_*, service-token and Cloudflare ` +
					"variables are never passed to the agent command",
			);
		}
	});
	return [...new Set(names)];
}

/**
 * The named variables that are set in this process, as minimalEnv() extras.
 *
 * @param {string[]} names
 * @returns {Record<string, string>}
 */
export function pickEnv(names) {
	/** @type {Record<string, string>} */
	const picked = {};
	for (const name of names) {
		const value = process.env[name];
		if (value !== undefined) picked[name] = value;
	}
	return picked;
}
