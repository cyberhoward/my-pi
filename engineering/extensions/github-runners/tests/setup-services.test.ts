import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { validPolicyYaml } from "../src/test/policy-fixtures.js";
import { createSetupServices } from "../setup-services.js";

const settings = { mode: "local" as const, policies: [], pollIntervalSeconds: 60, standbyMinutes: 15, startOnLoad: false, automationEnabled: false, sizes: [], sourcePath: "/tmp/settings.json" };

it("reports missing credentials without exposing values and uses gh only as a fallback", async () => {
  const run = vi.fn().mockRejectedValue(new Error("not logged in"));
  const service = createSetupServices({ root: "/tmp", repository: "o/r" }, { env: {}, run });
  await expect(service.credentials(settings)).resolves.toEqual({ hcloud: false, github: false, githubSource: "missing", guidance: expect.any(Array) });
  expect(JSON.stringify(await service.credentials(settings))).not.toContain("hidden");
});

it("uses configured environment credentials before invoking gh", async () => {
  const run = vi.fn();
  const service = createSetupServices({ root: "/tmp", repository: "o/r" }, { env: { HCLOUD_TOKEN: "hidden", RUNNER_MANAGER_GITHUB_TOKEN: "hidden" }, run });
  await expect(service.credentials(settings)).resolves.toMatchObject({ hcloud: true, github: true, githubSource: "environment" });
  expect(run).not.toHaveBeenCalled();
});

it("refuses validation when no active policy was generated", async () => {
  const fetcher = vi.fn();
  const service = createSetupServices({ root: "/tmp", repository: "o/r" }, { env: {}, fetcher });
  await expect(service.validate(settings)).rejects.toThrow("no active runner policy");
  expect(fetcher).not.toHaveBeenCalled();
});

it("previews authoritative legacy policy timing, caps, and quantity with only GET requests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "setup-preview-"));
  const path = join(directory, "legacy.yaml");
  await writeFile(path, validPolicyYaml((policy) => {
    policy.spec.credentials.hcloudTokenEnv = "LEGACY_HCLOUD";
    policy.spec.github.repository = "o/r";
    policy.spec.pool.selectedTier = "cpx-shared-x86";
    policy.spec.pool.maxSize = 3;
    policy.spec.pool.costs = { maxKnownHourlyPoolEur: 1, maxKnownEligibilityEur: 1 };
    policy.spec.pool.timing.maximumLifetimeSeconds = 7200;
    policy.spec.runner = { architecture: "x64", version: "2.321.0", archiveSha256: "a".repeat(64) };
    policy.spec.hetzner = { ...policy.spec.hetzner, serverType: "cpx11", location: "fsn1", firewallId: "1" };
  }));
  const rules = [["udp", "53"], ["tcp", "53"], ["udp", "123"], ["tcp", "80"], ["tcp", "443"]].map(([protocol, port]) => ({ direction: "out", protocol, port, destination_ips: ["0.0.0.0/0", "::/0"] }));
  const fetcher = vi.fn((input: string | URL, init?: RequestInit) => {
    expect(init?.method ?? "GET").toBe("GET");
    const url = String(input);
    if (url.includes("/firewalls/")) return json({ firewall: { id: 1, rules } });
    if (url.includes("/server_types?")) return json({ server_types: [{ name: "cpx11", architecture: "x86", deprecated: false, prices: [{ location: "fsn1", price_hourly: { net: "0.01" } }] }] });
    if (url.includes("/images?")) return json({ images: [{ name: "ubuntu-24.04", architecture: "x86", status: "available", deprecated: null }] });
    if (url.includes("/locations?")) return json({ locations: [{ name: "fsn1", deprecated: false, disabled: false }] });
    return json({ pricing: { primary_ips: [{ type: "ipv4", prices: [{ location: "fsn1", price_hourly: { net: "0.001" } }] }] } });
  });
  try {
    const preview = await createSetupServices({ root: directory, repository: "o/r" }, { env: { LEGACY_HCLOUD: "hidden" }, fetcher }).preview({ ...settings, policies: [path] });
    expect(preview).toHaveLength(1);
    expect(preview[0]).toMatchObject({ name: "legacy-1", config: { pool: { maxSize: 3, maximumLifetimeSeconds: 7200, maxKnownHourlyPoolCostEur: 1, maxKnownEligibilityCostEur: 1 } }, cost: { hourlyPoolEur: 0.033, maximumEligibilityEur: 0.066 } });
    expect(JSON.stringify(preview)).not.toContain("hidden");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("rejects unsupported legacy images before activation provider calls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "setup-image-"));
  const path = join(directory, "legacy.yaml");
  await writeFile(path, validPolicyYaml((policy) => {
    policy.spec.github.repository = "o/r";
    policy.spec.pool.selectedTier = "cpx-shared-x86";
    policy.spec.runner = { architecture: "x64", version: "2.321.0", archiveSha256: "a".repeat(64) };
    policy.spec.hetzner = { ...policy.spec.hetzner, serverType: "cpx11", location: "fsn1", firewallId: "1", image: "fedora-42" };
    policy.spec.mutation.enabled = true;
  }));
  const fetcher = vi.fn();
  try {
    await expect(createSetupServices({ root: directory, repository: "o/r" }, { env: { HCLOUD_TOKEN: "hidden", RUNNER_MANAGER_GITHUB_TOKEN: "hidden" }, fetcher }).validate({ ...settings, policies: [path] })).rejects.toThrow("not supported");
    expect(fetcher).not.toHaveBeenCalled();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("rejects nonexact legacy pins before provider calls", async () => {
  const directory = await mkdtemp(join(tmpdir(), "setup-pin-"));
  const path = join(directory, "legacy.yaml");
  await writeFile(path, validPolicyYaml((policy) => {
    policy.spec.github.repository = "o/r";
    policy.spec.pool.selectedTier = "cpx-shared-x86";
    policy.spec.runner = { architecture: "x64", version: "latest", archiveSha256: "a".repeat(64) };
    policy.spec.hetzner = { ...policy.spec.hetzner, serverType: "cpx11", location: "fsn1", firewallId: "1" };
    policy.spec.mutation.enabled = true;
  }));
  const fetcher = vi.fn();
  try {
    await expect(createSetupServices({ root: directory, repository: "o/r" }, { env: { HCLOUD_TOKEN: "hidden", RUNNER_MANAGER_GITHUB_TOKEN: "hidden" }, fetcher }).validate({ ...settings, policies: [path] })).rejects.toThrow("digits.digits.digits");
    expect(fetcher).not.toHaveBeenCalled();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
