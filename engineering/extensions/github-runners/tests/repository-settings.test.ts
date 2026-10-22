import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectRepository, parseGitHubOrigin } from "../repository.js";
import { automationErrors, loadSettings, resolvePolicyPath, saveSettings, type RunnerSettings } from "../settings.js";

describe("repository binding", () => {
  it("accepts exact github.com HTTPS and SSH origins", () => {
    expect(parseGitHubOrigin("https://github.com/Owner/repo.git")).toBe("Owner/repo");
    expect(parseGitHubOrigin("git@github.com:Owner/repo.git")).toBe("Owner/repo");
    expect(parseGitHubOrigin("https://example.com/Owner/repo.git")).toBeUndefined();
  });
  it("fails closed for ambiguous origins", async () => {
    const run = async (_file: string, args: string[]) => ({ stdout: args[0] === "rev-parse" ? "/repo\n" : "git@github.com:one/repo.git\ngit@github.com:two/repo.git\n" });
    await expect(detectRepository("/repo", run)).resolves.toBeUndefined();
  });
});

describe("settings", () => {
  it("maps legacy configuration to safe defaults and resolves policies inside the git root", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-settings-"));
    await mkdir(join(root, ".pi"));
    await writeFile(join(root, ".pi/github-runners.json"), JSON.stringify({ policies: ["tools/policy.yaml"], pollIntervalSeconds: 90 }));
    await expect(loadSettings(root)).resolves.toMatchObject({ mode: "local", policies: [join(root, "tools/policy.yaml")], pollIntervalSeconds: 90, standbyMinutes: 15, automationEnabled: false, startOnLoad: false, sizes: [] });
    expect(() => resolvePolicyPath(root, "../elsewhere.yaml")).toThrow("inside the git root");
  });
  it("rejects invalid explicit configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-settings-"));
    await mkdir(join(root, ".pi"));
    await writeFile(join(root, ".pi/github-runners.json"), JSON.stringify({ command: "rm" }));
    await expect(loadSettings(root)).rejects.toThrow("unknown properties");
  });
  it("round-trips loaded absolute policy paths as root-relative paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-settings-"));
    await mkdir(join(root, ".pi"));
    await writeFile(join(root, ".pi/github-runners.json"), JSON.stringify({ policies: ["tools/policy.yaml"] }));
    const loaded = await loadSettings(root);
    await saveSettings(root, loaded);
    expect(JSON.parse(await readFile(join(root, ".pi/github-runners.json"), "utf8")).policies).toEqual(["tools/policy.yaml"]);
    await expect(loadSettings(root)).resolves.toMatchObject({ policies: [join(root, "tools/policy.yaml")] });
    await expect(saveSettings(root, { ...loaded, policies: ["/outside/policy.yaml"] })).rejects.toThrow("inside the git root");
  });
  it("accepts disabled draft sizes without treating them as automation-ready", async () => {
    const draft: RunnerSettings = { mode: "local", policies: [], pollIntervalSeconds: 60, standbyMinutes: 15, startOnLoad: false, automationEnabled: false, sourcePath: "settings.json", sizes: [{ name: "draft", labels: ["workload"], quantity: 0, serverType: "", location: "", image: "", firewallId: "", runnerVersion: "", runnerArchiveSha256: "", maxHourlyCostEur: 0, maxEligibilityCostEur: 0 }] };
    const root = await mkdtemp(join(tmpdir(), "runner-settings-"));
    await saveSettings(root, draft);
    await expect(loadSettings(root)).resolves.toMatchObject({ sizes: draft.sizes });
    expect(automationErrors(draft)).toContain("at least one runner size with quantity above zero is required");
    const active = { ...draft, sizes: [{ ...draft.sizes[0], quantity: 1 }] };
    expect(automationErrors(active).join(" ")).toMatch(/Hetzner.*pinned.*cost/i);
  });
  it("accepts safe SSH aliases containing underscores for an installed reaper", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-settings-"));
    await mkdir(join(root, ".pi"));
    await writeFile(join(root, ".pi/github-runners.json"), JSON.stringify({ reaper: { sshTarget: "controller_alias", installationId: "0123456789abcdef", environmentFile: "/private.env" } }));
    await expect(loadSettings(root)).resolves.toMatchObject({ reaper: { sshTarget: "controller_alias" } });
  });
  it("stores global settings globally and leaves only the local mode selection", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-settings-"));
    const home = await mkdtemp(join(tmpdir(), "runner-home-"));
    const settings: RunnerSettings = { mode: "global", policies: [], pollIntervalSeconds: 60, standbyMinutes: 15, startOnLoad: false, automationEnabled: false, organization: { name: "Acme", repositories: ["Acme/Widgets"], runnerGroupId: 12, runnerGroupName: "pi" }, sizes: [], sourcePath: "ignored" };
    await saveSettings(root, settings, { home });
    expect(JSON.parse(await readFile(join(root, ".pi/github-runners.json"), "utf8"))).toEqual({ mode: "global" });
    await expect(loadSettings(root, { home })).resolves.toMatchObject({ mode: "global", organization: { ...settings.organization, name: "acme", repositories: ["acme/widgets"] } });
  });
});
