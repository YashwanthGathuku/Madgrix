/**
 * The competition demo crew is the fleet roster, in manifest order.
 * This runs `fleet validate --config <manifest> --json`, the same command
 * live-e2e uses. It does not parse the YAML itself.
 *
 * node --test test/fleet-manifest.test.ts
 *
 * The fleet binary must be Agentfleet paper-hardening 49032db or newer:
 * that build puts agent ids in summary.agent_ids. Set MADGRIX_FLEET_BIN
 * when `fleet` on PATH is an older build.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { loadContenderIds } from "../scripts/lib/agentfleet-slots.mjs";
import {
	DEMO_COMPOSITION_CONFIG,
	DEMO_COMPOSITION_FLEET_CONFIG,
	DEFAULT_FORK_CREW_CONFIG,
	DEFAULT_FORK_CREW_FLEET_CONFIG,
	assertFleetRoster,
	fleetConfigForCrew,
	loadForkCrew,
} from "../scripts/lib/fork-crew.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fleetEnv(): { MADGRIX_FLEET_BIN?: string } {
	const bin = process.env.MADGRIX_FLEET_BIN;
	return bin ? { MADGRIX_FLEET_BIN: bin } : {};
}

describe("competition fleet manifest", () => {
	it("pairs the demo crew with the four-agent manifest and the fork crew with the three-agent manifest", () => {
		assert.equal(fleetConfigForCrew(DEMO_COMPOSITION_CONFIG), DEMO_COMPOSITION_FLEET_CONFIG);
		assert.equal(fleetConfigForCrew(path.join(root, "configs/demo-composition.json")), DEMO_COMPOSITION_FLEET_CONFIG);
		assert.equal(fleetConfigForCrew(DEFAULT_FORK_CREW_CONFIG), DEFAULT_FORK_CREW_FLEET_CONFIG);
	});

	it("fleet validate lists parent, sub-api, sub-ui, sub-test in that order", () => {
		const ids = loadContenderIds({
			env: fleetEnv(),
			configPath: DEMO_COMPOSITION_FLEET_CONFIG,
		});
		assert.deepEqual(ids, ["parent", "sub-api", "sub-ui", "sub-test"]);
		const crew = loadForkCrew(DEMO_COMPOSITION_CONFIG);
		assert.deepEqual(assertFleetRoster(crew, fleetConfigForCrew(DEMO_COMPOSITION_CONFIG), fleetEnv()), ids);
	});

	it("fleet validate still lists the two-sub-agent crew in crew order", () => {
		const ids = loadContenderIds({
			env: fleetEnv(),
			configPath: DEFAULT_FORK_CREW_FLEET_CONFIG,
		});
		assert.deepEqual(ids, ["parent", "sub-api", "sub-ui"]);
		assert.deepEqual(assertFleetRoster(loadForkCrew(), DEFAULT_FORK_CREW_FLEET_CONFIG, fleetEnv()), ids);
	});
});
