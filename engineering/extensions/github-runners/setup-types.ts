import type { RunnerSettings, RunnerSize } from "./settings.js";
import type { KnownCost } from "./src/ports.js";
import type { RunnerManagerConfig } from "./src/types.js";

export interface SetupCredentials {
  hcloud: boolean;
  github: boolean;
  githubSource: "environment" | "gh" | "missing";
  guidance: string[];
}

export interface SetupCatalog {
  locations: { name: string; description: string }[];
  serverTypes: { name: string; cores: number; memoryGb: number; diskGb: number; locations: string[] }[];
  images: { name: string; description: string }[];
  firewalls: { id: string; name: string }[];
}

export interface SetupRelease {
  version: string;
  sha256: string;
  url: string;
}

export interface SetupPolicyPreview {
  name: string;
  config: RunnerManagerConfig;
  cost: KnownCost;
}

export interface SetupQuote {
  perRunnerHourlyEur: number;
  hourlyPoolEur: number;
  maximumEligibilityEur: number;
  maximumLifetimeSeconds: number;
  excludes: ["VAT", "variable traffic"];
}

export interface SetupServices {
  credentials(settings: RunnerSettings): Promise<SetupCredentials>;
  catalog(): Promise<SetupCatalog>;
  release(): Promise<SetupRelease>;
  validateScope(settings: RunnerSettings): Promise<void>;
  quote(size: RunnerSize, standbyMinutes: number): Promise<SetupQuote>;
  preview(settings: RunnerSettings): Promise<SetupPolicyPreview[]>;
  validate(settings: RunnerSettings): Promise<void>;
}
