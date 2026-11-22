import type { RunnerSize } from "./settings.js";
import type { SetupCatalog } from "./setup-types.js";

export type RunnerPresetId = "small" | "medium" | "large";

export interface RunnerPreset {
  id: RunnerPresetId;
  name: string;
  serverType: "cpx21" | "cpx31" | "cpx41";
  label: string;
}

/**
 * These are intentionally disabled drafts. Location, firewall, runner pin, and
 * price/cost caps come from the operator's discovered catalog and review flow.
 */
export const RUNNER_PRESETS: readonly RunnerPreset[] = [
  { id: "small", name: "Small", serverType: "cpx21", label: "pi-runner-small" },
  { id: "medium", name: "Medium", serverType: "cpx31", label: "pi-runner-medium" },
  { id: "large", name: "Large", serverType: "cpx41", label: "pi-runner-large" },
] as const;

export function presetDraft(preset: RunnerPreset): RunnerSize {
  return {
    name: preset.id,
    labels: [preset.label],
    quantity: 0,
    serverType: preset.serverType,
    location: "",
    image: "ubuntu-24.04",
    firewallId: "",
    runnerVersion: "",
    runnerArchiveSha256: "",
    maxHourlyCostEur: 0,
    maxEligibilityCostEur: 0,
  };
}

export function presetCatalogSummary(preset: RunnerPreset, catalog?: SetupCatalog): string {
  const type = catalog?.serverTypes.find(item => item.name === preset.serverType);
  if (!catalog) return `${preset.serverType} · x86 Ubuntu 24.04 · disabled draft; resource details are confirmed during catalog discovery`;
  if (!type || !type.locations.length) return `${preset.serverType} · unavailable in the discovered Hetzner catalog — no substitution`;
  return `${preset.serverType} · ${type.cores} vCPU, ${type.memoryGb} GB RAM, ${type.diskGb} GB disk · x86 Ubuntu 24.04 · disabled draft`;
}

export function presetAvailable(preset: RunnerPreset, catalog?: SetupCatalog): boolean {
  return !catalog || catalog.serverTypes.some(item => item.name === preset.serverType && item.locations.length > 0);
}
