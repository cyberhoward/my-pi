import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { materializePolicies } from "../policies.js";
import { loadPolicy } from "../src/config.js";
import type { RunnerSettings } from "../settings.js";

const sha = "a".repeat(64);
function settings(overrides: Partial<RunnerSettings> = {}): RunnerSettings {
  return { mode: "local", policies: [], pollIntervalSeconds: 60, standbyMinutes: 15, startOnLoad: false, automationEnabled: false, sizes: [{ name: "small", labels: ["build-linux"], quantity: 1, serverType: "cx23", location: "fsn1", image: "ubuntu-24.04", firewallId: "1", runnerVersion: "2.321.0", runnerArchiveSha256: sha, maxHourlyCostEur: 1, maxEligibilityCostEur: 2 }], sourcePath: "settings.json", ...overrides };
}
describe("policy materialization", () => {
  it("rejects unsupported active sizes before writing a policy", async () => {
    await expect(materializePolicies({ root: "/repo", repository: "owner/repo" }, settings({ sizes: [{ ...settings().sizes[0], serverType: "cax11" }] }))).rejects.toThrow("x86 CX, CPX, or CCX");
  });
  it("skips disabled draft sizes and returns an empty safe result when all are disabled", async () => {
    const draft = { ...settings().sizes[0], quantity: 0, firewallId: "", runnerVersion: "", runnerArchiveSha256: "", maxHourlyCostEur: 0, maxEligibilityCostEur: 0 };
    const empty = await materializePolicies({ root: "/repo", repository: "owner/repo" }, settings({ sizes: [draft] }));
    expect(empty.policies).toEqual([]);
    await empty.cleanup();
    const mixed = await materializePolicies({ root: "/repo", repository: "owner/repo" }, settings({ sizes: [draft, settings().sizes[0]] }));
    expect(mixed.policies).toHaveLength(1);
    await mixed.cleanup();
  });
  it("snapshots each legacy policy byte-for-byte", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-policy-")); const source = join(root, "legacy.yaml"); const bytes = await readFile(new URL("../examples/policy.yaml", import.meta.url)); await writeFile(source, bytes);
    const result = await materializePolicies({ root, repository: "owner/repository" }, settings({ policies: [source], sizes: [] }));
    await expect(readFile(result.policies[0].path)).resolves.toEqual(bytes);
    await result.cleanup();
  });
  it("materializes local and organization policies through the policy schema", async () => {
    const local = await materializePolicies({ root: "/repo", repository: "owner/repo" }, settings());
    await expect(loadPolicy(local.policies[0].path)).resolves.toMatchObject({ config: { repository: "owner/repo", inventory: { classificationLabels: { workload: "github-actions" } } } });
    await local.cleanup();
    const globalSettings = settings({ mode: "global", organization: { name: "acme", repositories: ["acme/widgets"], runnerGroupId: 1, runnerGroupName: "shared" } });
    const global = await materializePolicies({ root: "/repo", repository: "acme/widgets" }, globalSettings);
    await expect(loadPolicy(global.policies[0].path)).resolves.toMatchObject({ config: { organization: globalSettings.organization } });
    await global.cleanup();
  });
  it("clamps a 24-hour standby lifetime to the policy schema maximum", async () => {
    const materialized = await materializePolicies({ root: "/repo", repository: "owner/repo" }, settings({ standbyMinutes: 1440 }));
    await expect(loadPolicy(materialized.policies[0].path)).resolves.toMatchObject({ config: { pool: { idleGraceSeconds: 86400, maximumLifetimeSeconds: 86400 } } });
    await materialized.cleanup();
  });
  it("rejects explicit policies outside their configured scope", async () => {
    const binding = { root: "/repo", repository: "acme/widgets" };
    const globalSettings = settings({ mode: "global", organization: { name: "acme", repositories: ["acme/widgets"], runnerGroupId: 1, runnerGroupName: "shared" } });
    const generated = await materializePolicies(binding, globalSettings);
    const document = parse(await readFile(generated.policies[0].path, "utf8")) as { spec: { github: { repository: string; organization: { repositories: string[]; runnerGroupId: number } } } };
    await generated.cleanup();
    const directory = await mkdtemp(join(tmpdir(), "runner-policy-"));
    const assertRejected = async (name: string, mutate: (value: typeof document) => void) => {
      const value = structuredClone(document);
      mutate(value);
      const source = join(directory, `${name}.yaml`);
      await writeFile(source, stringify(value));
      await expect(materializePolicies(binding, { ...globalSettings, policies: [source], sizes: [] })).rejects.toThrow();
    };
    await assertRejected("wrong-repository", (value) => { value.spec.github.repository = "acme/other"; });
    await assertRejected("wrong-group", (value) => { value.spec.github.organization.runnerGroupId = 2; });
    await assertRejected("extra-repository", (value) => { value.spec.github.organization.repositories.push("acme/other"); });
  });
});
