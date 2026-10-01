/**
 * Tests for the benchmark harness (harness-validation on synthetic data).
 * node --test test/benchmark.test.ts
 *
 * Runs runBenchmark({quick:true}) programmatically (6x3) and asserts:
 *   - report shape complete (all strata, counts per the frozen scope)
 *   - 26/26 adversarial trials pass (zero-tolerance, real modules)
 *   - regret is a valid probability; oracle availability reported separately
 *   - paired bootstrap CIs sane (lower <= upper)
 *   - determinism: identical seed => identical metrics across runs
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	BENCHMARK_SEED,
	formatSummary,
	generateCandidateSet,
	runBenchmark,
	verifierAnonymizedLabels,
} from "../src/lib/benchmark.ts";

describe("benchmark harness (quick mode, synthetic)", () => {
	it("report shape is complete per the frozen scope", async () => {
		const r = await runBenchmark({ quick: true });
		assert.equal(r.mode, "quick");
		assert.equal(r.seed, BENCHMARK_SEED);
		assert.ok(r.scope_note.length > 0, "scope note must be present");
		// Ordinary stratum: 6x3 in quick mode (20x3 full).
		assert.equal(r.ordinary.tasks, 6);
		assert.equal(r.ordinary.contenders_per_task, 3);
		for (const arm of ["b", "c", "d"] as const) {
			assert.ok(r.ordinary.arms[arm] !== undefined, `arm ${arm} metrics present`);
		}
		// Adversarial stratum: 13 classes x 2 = 26 trials.
		assert.equal(r.adversarial.trials_total, 26);
		assert.equal(r.adversarial.results.length, 26);
		assert.ok(r.adversarial.showcase.length > 0, "showcase narrative present");
		// Conflict stratum: 30 pairs.
		assert.equal(r.conflict.pairs, 30);
		assert.equal(
			r.conflict.by_construction_label.green +
				r.conflict.by_construction_label.amber +
				r.conflict.by_construction_label.red_blocked,
			30,
		);
		// Precommit checklist: 1 primary + 6 zero-tolerance + 1 softer = 8.
		assert.equal(r.precommit_checklist.length, 8);
	});

	it("all 26 adversarial trials pass (zero-tolerance on real modules)", async () => {
		const r = await runBenchmark({ quick: true });
		assert.equal(r.adversarial.trials_passed, 26);
		assert.equal(r.zero_tolerance_ok, true);
		for (const t of r.adversarial.results) {
			assert.equal(t.passed, true, `trial ${t.trial} (${t.name}) must pass: ${t.detail}`);
		}
	});

	it("regret is a valid probability; oracle availability reported separately", async () => {
		const r = await runBenchmark({ quick: true });
		for (const arm of ["b", "c", "d"] as const) {
			const m = r.ordinary.arms[arm];
			if (m.regret !== null) {
				assert.ok(m.regret >= 0 && m.regret <= 1, `arm ${arm} regret must be a probability, got ${m.regret}`);
			}
			assert.ok(
				m.false_accept_rate >= 0 && m.false_accept_rate <= 1,
				`arm ${arm} false accept rate must be a probability`,
			);
		}
		// Oracle Availability is its own field, never folded into regret:
		// it must equal oracle_tasks/tasks exactly.
		assert.ok(r.ordinary.oracle_availability >= 0 && r.ordinary.oracle_availability <= 1);
		assert.equal(r.ordinary.oracle_availability, r.ordinary.oracle_tasks / r.ordinary.tasks);
	});

	it("paired bootstrap CIs are sane (lower <= upper)", async () => {
		const r = await runBenchmark({ quick: true });
		for (const ci of [r.ordinary.bootstrap_d_minus_c, r.ordinary.bootstrap_d_minus_b]) {
			// resamples with zero oracle tasks are skipped by design (documented in
			// pairedBootstrapCI); in quick mode (6 tasks) a few skips are expected.
			assert.ok(ci.resamples <= 1000 && ci.resamples >= 900, `resamples sane, got ${ci.resamples}`);
			assert.equal(ci.confidence, 0.95);
			assert.ok(Number.isFinite(ci.lower) && Number.isFinite(ci.upper), "CI bounds finite");
			assert.ok(ci.lower <= ci.upper, `CI sane: lower=${ci.lower} <= upper=${ci.upper}`);
		}
	});

	it("deterministic: identical seed => identical metrics", async () => {
		const r1 = await runBenchmark({ quick: true });
		const r2 = await runBenchmark({ quick: true });
		assert.deepEqual(r1.ordinary.arms, r2.ordinary.arms);
		assert.deepEqual(r1.ordinary.oracle_availability, r2.ordinary.oracle_availability);
		assert.deepEqual(
			{ tp: r1.conflict.true_positives, fp: r1.conflict.false_positives },
			{ tp: r2.conflict.true_positives, fp: r2.conflict.false_positives },
		);
		assert.deepEqual(r1.adversarial.trials_passed, r2.adversarial.trials_passed);
	});

	it("showcase narrative names the AUTHORIZED vs PRESENTED mismatch", async () => {
		const r = await runBenchmark({ quick: true });
		assert.match(r.adversarial.showcase, /AUTHORIZED_TREE/);
		assert.match(r.adversarial.showcase, /PRESENTED_TREE/);
		assert.match(r.adversarial.showcase, /TREE_MISMATCH/);
	});

	it("seed threads through to the candidate sets (not silently ignored)", async () => {
		// Same (seed, task) => identical sets.
		const a = await generateCandidateSet(BENCHMARK_SEED, 0);
		const b = await generateCandidateSet(BENCHMARK_SEED, 0);
		assert.deepEqual(a, b);
		// Different seed => different candidate sets (the seed option must
		// actually change what the arms see, not just the bootstrap stream).
		const c = await generateCandidateSet(424242, 0);
		assert.notEqual(c.task_hash, a.task_hash, "custom seed must change task_hash");
		assert.notDeepEqual(
			c.candidates.map((x) => x.candidate_sha),
			a.candidates.map((x) => x.candidate_sha),
			"custom seed must change candidate shas",
		);
		// runBenchmark honors opts.seed end to end and records it.
		const r = await runBenchmark({ quick: true, seed: 424242 });
		assert.equal(r.seed, 424242);
		const r2 = await runBenchmark({ quick: true, seed: 424242 });
		assert.deepEqual(r.ordinary.arms, r2.ordinary.arms);
	});

	it("verifier anonymized labels are collision-free on sha-prefix collisions", () => {
		// Three candidates sharing the first 4 hex nibbles must still get
		// distinct anonymized labels (index-based, never sha-prefix-based).
		const shas = [
			"abcd" + "1".repeat(60),
			"abcd" + "2".repeat(60),
			"abcd" + "3".repeat(60),
		];
		const labels = verifierAnonymizedLabels(shas);
		assert.equal(labels.size, 3, "one label per candidate even with colliding prefixes");
		const labelSet = new Set(labels.keys());
		assert.equal(labelSet.size, 3, "labels must be unique");
		for (const [label, sha] of labels) {
			assert.ok(shas.includes(sha), `label ${label} maps to a real candidate sha`);
		}
	});

	it("every printed section carries the verbatim validation label", async () => {
		const r = await runBenchmark({ quick: true });
		assert.equal(r.validation_label, "harness validation, not evidence");
		const summary = formatSummary(r);
		assert.match(summary, /\[harness validation, not evidence\]/);
		for (const line of summary.split("\n")) {
			if (line.startsWith("--- ")) {
				assert.match(
					line,
					/\[harness validation, not evidence\]/,
					`section header must carry the label: ${line}`,
				);
			}
		}
	});
});
