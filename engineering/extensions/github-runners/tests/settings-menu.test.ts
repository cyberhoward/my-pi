import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { configureRunners } from "../settings-menu.js";
import { loadSettings } from "../settings.js";
import { validPolicyYaml } from "../src/test/policy-fixtures.js";

describe("runner settings menu", () => {
  it("does not mutate settings in a noninteractive context", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-menu-"));
    const ctx = { hasUI: false, ui: { select: async () => undefined, input: async () => undefined, confirm: async () => false, notify: () => undefined } };
    await expect(configureRunners(ctx, { root, repository: "acme/widgets" })).resolves.toBe(false);
  });
  it("canonicalizes organization identities entered through the menu", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-menu-"));
    const responses = ["Organization: not configured", "Allowed repositories: not configured", "Save and close"];
    const inputs = ["AcMe", "AcMe/Widgets, acme/widgets"];
    const ctx = { hasUI: true, ui: {
      select: async () => responses.shift(), input: async () => inputs.shift(), confirm: async () => false, notify: () => undefined,
      editor: async () => undefined,
    } };
    expect(await configureRunners(ctx, { root, repository: "acme/widgets" })).toBe(true);
    await expect(loadSettings(root)).resolves.toMatchObject({ organization: { name: "acme", repositories: ["acme/widgets"] } });
  });
  it("enables valid explicit legacy YAML automation only after confirmation", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-menu-"));
    await mkdir(join(root, ".pi"));
    await writeFile(join(root, ".pi/github-runners.json"), JSON.stringify({ policies: ["policy.yaml"] }));
    await writeFile(join(root, "policy.yaml"), validPolicyYaml(policy => {
      policy.spec.mutation.enabled = true;
      policy.spec.github.repository = "acme/widgets";
      policy.spec.runner = { architecture: "x64", version: "2.321.0", archiveSha256: "a".repeat(64) };
      policy.spec.hetzner.serverType = "cx23"; policy.spec.hetzner.location = "fsn1"; policy.spec.hetzner.firewallId = "1";
    }));
    const responses = ["Automation: disabled", "Save and close"];
    const confirm = vi.fn(async () => true);
    const ctx = { hasUI: true, ui: { select: async () => responses.shift(), input: async () => undefined, confirm, notify: () => undefined, editor: async () => undefined } };
    expect(await configureRunners(ctx, { root, repository: "acme/widgets" })).toBe(true);
    await expect(loadSettings(root)).resolves.toMatchObject({ automationEnabled: true });
    expect(confirm).toHaveBeenCalledOnce();
  });
  it.each(["disabled", "cross-scope"])("refuses %s explicit legacy YAML without changing settings", async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "runner-menu-"));
    await mkdir(join(root, ".pi"));
    await writeFile(join(root, ".pi/github-runners.json"), JSON.stringify({ policies: ["policy.yaml"] }));
    await writeFile(join(root, "policy.yaml"), validPolicyYaml(policy => {
      policy.spec.mutation.enabled = kind !== "disabled";
      policy.spec.github.repository = kind === "cross-scope" ? "acme/other" : "acme/widgets";
      policy.spec.runner = { architecture: "x64", version: "2.321.0", archiveSha256: "a".repeat(64) };
      policy.spec.hetzner.serverType = "cx23"; policy.spec.hetzner.location = "fsn1"; policy.spec.hetzner.firewallId = "1";
    }));
    const responses = ["Automation: disabled", "Save and close"];
    const confirm = vi.fn(async () => true); const notify = vi.fn();
    const ctx = { hasUI: true, ui: { select: async () => responses.shift(), input: async () => undefined, confirm, notify, editor: async () => undefined } };
    expect(await configureRunners(ctx, { root, repository: "acme/widgets" })).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(kind === "disabled" ? /mutation/i : /active repository/i), "error");
    expect(JSON.parse(await readFile(join(root, ".pi/github-runners.json"), "utf8"))).toEqual({ policies: ["policy.yaml"] });
  });
  it.each(["malformed YAML", "incomplete provisioning"])('refuses %s policy automation without changing settings', async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "runner-menu-"));
    await mkdir(join(root, ".pi"));
    const configPath = join(root, ".pi/github-runners.json");
    const original = '{"policies":["policy.yaml"]}\n';
    await writeFile(configPath, original);
    const policy = kind === "malformed YAML" ? "spec: [" : validPolicyYaml(value => {
      value.spec.mutation.enabled = true;
      value.spec.github.repository = "acme/widgets";
      value.spec.runner = { architecture: "x64", version: "2.321.0", archiveSha256: "a".repeat(64) };
      value.spec.hetzner.serverType = "cx23"; value.spec.hetzner.location = "fsn1"; value.spec.hetzner.firewallId = "";
    });
    await writeFile(join(root, "policy.yaml"), policy);
    const responses = ["Automation: disabled", "Save and close"];
    const confirm = vi.fn(async () => true); const notify = vi.fn();
    const ctx = { hasUI: true, ui: { select: async () => responses.shift(), input: async () => undefined, confirm, notify, editor: async () => undefined } };
    expect(await configureRunners(ctx, { root, repository: "acme/widgets" })).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/cannot enable automation/i), "error");
    expect(await readFile(configPath, "utf8")).toBe(original);
  });
  it("enables a valid generated runner size after cost confirmation", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-menu-"));
    await mkdir(join(root, ".pi"));
    await writeFile(join(root, ".pi/github-runners.json"), JSON.stringify({ sizes: [{ name: "small", labels: ["ci-small"], quantity: 1, serverType: "cpx21", location: "fsn1", image: "ubuntu-24.04", firewallId: "1", runnerVersion: "2.321.0", runnerArchiveSha256: "a".repeat(64), maxHourlyCostEur: 1, maxEligibilityCostEur: 2 }] }));
    const responses = ["Automation: disabled", "Save and close"];
    const ctx = { hasUI: true, ui: { select: async () => responses.shift(), input: async () => undefined, confirm: async () => true, notify: vi.fn(), editor: async () => undefined } };
    expect(await configureRunners(ctx, { root, repository: "acme/widgets" })).toBe(true);
    await expect(loadSettings(root)).resolves.toMatchObject({ automationEnabled: true });
  });
  it("leaves the configuration byte-for-byte unchanged when cost confirmation is declined", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-menu-"));
    await mkdir(join(root, ".pi"));
    const configPath = join(root, ".pi/github-runners.json");
    const original = '{"sizes":[{"name":"small","labels":["ci-small"],"quantity":1,"serverType":"cpx21","location":"fsn1","image":"ubuntu-24.04","firewallId":"1","runnerVersion":"2.321.0","runnerArchiveSha256":"' + "a".repeat(64) + '","maxHourlyCostEur":1,"maxEligibilityCostEur":2}]}\n';
    await writeFile(configPath, original);
    const responses = ["Automation: disabled", "Save and close"];
    const confirm = vi.fn(async () => false);
    const ctx = { hasUI: true, ui: { select: async () => responses.shift(), input: async () => undefined, confirm, notify: vi.fn(), editor: async () => undefined } };
    expect(await configureRunners(ctx, { root, repository: "acme/widgets" })).toBe(false);
    expect(confirm).toHaveBeenCalledOnce();
    expect(await readFile(configPath, "utf8")).toBe(original);
  });
  it("persists explicit menu selections without enabling automation", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-menu-"));
    const responses = ["Standby expiry: 15 minutes", "Save and close"];
    const ctx = { hasUI: true, ui: {
      select: async () => responses.shift(), input: async () => "20", confirm: async () => false, notify: () => undefined,
      editor: async () => undefined,
    } };
    expect(await configureRunners(ctx, { root, repository: "acme/widgets" })).toBe(true);
    await expect(loadSettings(root)).resolves.toMatchObject({ mode: "local", standbyMinutes: 20, automationEnabled: false });
  });
});
