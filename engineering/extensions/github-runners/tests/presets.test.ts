import { describe, expect, it } from "vitest";
import { RUNNER_PRESETS, presetAvailable, presetCatalogSummary, presetDraft } from "../presets.js";

const catalog = {
  locations: [],
  serverTypes: [{ name: "cpx21", cores: 3, memoryGb: 4, diskGb: 80, locations: ["fsn1"] }],
  images: [],
  firewalls: [],
};

describe("runner pool presets", () => {
  it("maps Small, Medium, and Large to disabled Ubuntu x86 drafts without invented activation details", () => {
    expect(RUNNER_PRESETS.map(preset => [preset.name, preset.serverType, preset.label])).toEqual([
      ["Small", "cpx21", "pi-runner-small"],
      ["Medium", "cpx31", "pi-runner-medium"],
      ["Large", "cpx41", "pi-runner-large"],
    ]);
    for (const preset of RUNNER_PRESETS) {
      expect(presetDraft(preset)).toMatchObject({ name: preset.id, labels: [preset.label], quantity: 0, serverType: preset.serverType, image: "ubuntu-24.04", location: "", firewallId: "", runnerVersion: "", runnerArchiveSha256: "", maxHourlyCostEur: 0, maxEligibilityCostEur: 0 });
    }
  });

  it("uses discovered resources when available and clearly refuses unavailable preset types or locations", () => {
    expect(presetCatalogSummary(RUNNER_PRESETS[0], catalog)).toContain("3 vCPU, 4 GB RAM, 80 GB disk");
    expect(presetAvailable(RUNNER_PRESETS[0], catalog)).toBe(true);
    expect(presetAvailable(RUNNER_PRESETS[1], catalog)).toBe(false);
    expect(presetCatalogSummary(RUNNER_PRESETS[1], catalog)).toMatch(/unavailable.*no substitution/);
    const noLocations = { ...catalog, serverTypes: [{ ...catalog.serverTypes[0], locations: [] }] };
    expect(presetAvailable(RUNNER_PRESETS[0], noLocations)).toBe(false);
    expect(presetCatalogSummary(RUNNER_PRESETS[0], noLocations)).toMatch(/unavailable.*no substitution/);
  });
});
