/**
 * The competition demo crew is the manifest roster, in order.
 * MADGRIX reads the YAML it ships. Agentfleet is not required.
 * When MADGRIX_FLEET_BIN is set, `fleet validate` is an extra roster
 * cross-check. It does not execute the sub-agents. An older fleet that
 * omits summary.agent_ids fails only that explicit path.
 *
 * node --test test/fleet-manifest.test.ts
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
	manifestRoster,
} from "../scripts/lib/fork-crew.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("competition fleet manifest", () => {
	it("pairs the demo crew with the four-agent manifest and the fork crew with the three-agent manifest", () => {
		assert.equal(fleetConfigForCrew(DEMO_COMPOSITION_CONFIG), DEMO_COMPOSITION_FLEET_CONFIG);
		assert.equal(fleetConfigForCrew(path.join(root, "configs/demo-composition.json")), DEMO_COMPOSITION_FLEET_CONFIG);
		assert.equal(fleetConfigForCrew(DEFAULT_FORK_CREW_CONFIG), DEFAULT_FORK_CREW_FLEET_CONFIG);
	});

	it("the demo manifest lists parent, sub-api, sub-ui, sub-test with the crew scopes", () => {
		const crew = loadForkCrew(DEMO_COMPOSITION_CONFIG);
		assert.deepEqual(
			manifestRoster(DEMO_COMPOSITION_FLEET_CONFIG).map((agent) => agent.id),
			["parent", "sub-api", "sub-ui", "sub-test"],
		);
		assert.deepEqual(assertFleetRoster(crew, DEMO_COMPOSITION_FLEET_CONFIG, {}), ["parent", "sub-api", "sub-ui", "sub-test"]);
		assert.deepEqual(
			crew.subs.map((sub) => sub.paths.length > 0 && !sub.paths.includes("**")),
			[true, true, true],
		);
	});

	it("the fork-crew manifest stays the three-id roster", () => {
		const crew = loadForkCrew();
		assert.deepEqual(
			manifestRoster(DEFAULT_FORK_CREW_FLEET_CONFIG).map((agent) => `${agent.id}:${agent.role}`),
			["parent:parent", "sub-api:api", "sub-ui:ui"],
		);
		assert.deepEqual(assertFleetRoster(crew, DEFAULT_FORK_CREW_FLEET_CONFIG, {}), ["parent", "sub-api", "sub-ui"]);
	});

	it("does not call fleet unless MADGRIX_FLEET_BIN is set", () => {
		const crew = loadForkCrew(DEMO_COMPOSITION_CONFIG);
		assert.deepEqual(assertFleetRoster(crew, DEMO_COMPOSITION_FLEET_CONFIG, { MADGRIX_FLEET_BIN: "" }), [
			"parent",
			"sub-api",
			"sub-ui",
			"sub-test",
		]);
		const bin = process.env.MADGRIX_FLEET_BIN;
		if (!bin) return;
		const ids = loadContenderIds({
			env: { MADGRIX_FLEET_BIN: bin },
			configPath: DEMO_COMPOSITION_FLEET_CONFIG,
			fleetBin: bin,
		});
		assert.deepEqual(ids, ["parent", "sub-api", "sub-ui", "sub-test"]);
		assert.deepEqual(assertFleetRoster(crew, DEMO_COMPOSITION_FLEET_CONFIG, { MADGRIX_FLEET_BIN: bin }), ids);
	});
});
