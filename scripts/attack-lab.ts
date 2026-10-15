#!/usr/bin/env node
/**
 * Judge-facing adversarial demo over the REAL protocol modules.
 * No Cloudflare calls, no credentials, no mutation of live state.
 */

import { runBenchmark } from "../src/lib/benchmark.ts";

const report = await runBenchmark({ quick: true });
const checks = report.precommit_checklist.filter((row) => row.name.startsWith("Zero-tolerance:"));

console.log("MADGRIX ATTACK LAB");
console.log("Canonicality is a capability, not a branch permission.\n");
for (const row of checks) {
	const mark = row.status === "PASS" ? "BLOCKED" : "FAILED";
	console.log(`${mark.padEnd(8)}  ${row.name.replace(/^Zero-tolerance:\s*/, "")}`);
	console.log(`          ${row.note}`);
}
console.log("");
console.log(`${report.adversarial.trials_passed}/${report.adversarial.trials_total} adversarial trials passed`);
console.log(`unauthorized canonical promotions: ${report.zero_tolerance_ok ? 0 : "UNKNOWN"}`);
console.log(`ATTACK_LAB_${report.zero_tolerance_ok ? "VERIFIED" : "FAILED"}`);
process.exitCode = report.zero_tolerance_ok ? 0 : 1;
