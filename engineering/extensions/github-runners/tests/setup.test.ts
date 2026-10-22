import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setupRunners } from "../setup.js";
import { loadSettings } from "../settings.js";
import type { SetupServices } from "../setup-types.js";
import type { RunnerManagerConfig } from "../src/types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const previewConfig: RunnerManagerConfig = {
  identity: { apiVersion: "runner-manager.pi.dev/v1alpha1", slotPrefix: "pi" },
  repository: "acme/widgets",
  pool: { name: "small", routingLabels: ["ci", "linux"], maxSize: 1, scaleUpDelaySeconds: 0, idleGraceSeconds: 900, bootstrapGraceSeconds: 60, drainQuiescenceSeconds: 60, drainProbeSeconds: 10, maximumLifetimeSeconds: 3_600, maxKnownHourlyPoolCostEur: 1.1, maxKnownEligibilityCostEur: 2.2 },
  hcloud: { serverType: "cpx21", location: "fsn1", image: "ubuntu-24.04", firewallId: "1", sshKeyIds: [], publicNet: { ipv4: true, ipv6: true } },
  coordination: { lockPath: "/tmp/runner.lock" },
  runner: { architecture: "x64", version: "2.321.0", archiveSha256: "a".repeat(64) },
  tier: { id: "cpx", family: "CPX", architecture: "x86", serverTypes: ["cpx21"], sources: ["test"] },
  inventory: { managedLabelValue: "test", classificationLabels: {} },
};

const catalog = {
  locations: [{ name: "fsn1", description: "Falkenstein" }],
  serverTypes: [
    { name: "cpx21", cores: 3, memoryGb: 4, diskGb: 80, locations: ["fsn1"] },
    { name: "cx22", cores: 2, memoryGb: 4, diskGb: 40, locations: ["fsn1"] },
  ],
  images: [{ name: "ubuntu-24.04", description: "Ubuntu" }],
  firewalls: [{ id: "1", name: "runners" }],
};

function services(overrides: Partial<SetupServices> = {}): SetupServices {
  return {
    credentials: vi.fn(async () => ({ hcloud: true, github: true, githubSource: "environment", guidance: [] })),
    catalog: vi.fn(async () => catalog),
    release: vi.fn(async () => ({ version: "2.321.0", sha256: "a".repeat(64), url: "https://example.test/runner.tgz" })),
    validateScope: vi.fn(),
    quote: vi.fn(async () => ({ perRunnerHourlyEur: 0.010001, hourlyPoolEur: 0.010001, maximumEligibilityEur: 0.1, maximumLifetimeSeconds: 900, excludes: ["VAT", "variable traffic"] })),
    preview: vi.fn(async () => [{
      name: "small",
      config: previewConfig,
      cost: { hourlyPoolEur: 0.010001, maximumEligibilityEur: 0.1 } as never,
    }]),
    validate: vi.fn(),
    ...overrides,
  };
}

async function root(): Promise<{ root: string; home: string }> {
  const directory = await mkdtemp(join(tmpdir(), "runner-setup-"));
  roots.push(directory);
  return { root: join(directory, "repository"), home: join(directory, "home") };
}

function scripted(selected: string[], inputs: Array<string | undefined> = [], confirms: boolean | boolean[] = true) {
  const answers = Array.isArray(confirms) ? [...confirms] : undefined;
  const select = vi.fn(async (_title: string, options: string[]) => {
    const choice = selected.shift();
    if (choice !== undefined && !options.includes(choice)) throw new Error(`impossible UI action ${choice}; options: ${options.join(" | ")}`);
    return choice;
  });
  return {
    hasUI: true,
    mode: "tui",
    ui: {
      select,
      input: vi.fn(async () => inputs.shift()),
      confirm: vi.fn(async () => answers ? answers.shift() ?? false : confirms),
      notify: vi.fn(),
    },
  };
}

function poolChoices(name = "small", save = "Save disabled configuration", type = "cpx21"): string[] {
  return [
    "Repository pool for acme/widgets",
    "Continue to pools",
    "Add named pool",
    "Edit name",
    "Edit routing labels",
    "Edit quantity",
    "1",
    "Edit infrastructure",
    `${type} — ${type === "cpx21" ? "3 vCPU, 4 GB RAM, 80 GB disk" : "2 vCPU, 4 GB RAM, 40 GB disk"}`,
    "fsn1",
    "ubuntu-24.04 — Ubuntu",
    "1 — runners",
    "Update or edit runner pin",
    "Update to verified stable Linux x64 2.321.0",
    "Quote and set cost caps",
    "Done",
    "Continue to review",
    save,
  ];
}

const poolInputs = (name = "small", labels = "ci") => [name, labels, "0.0101", "0.1000"];

async function writeGenerated(paths: { root: string }, extra = ""): Promise<void> {
  await mkdir(join(paths.root, ".pi"), { recursive: true });
  await writeFile(join(paths.root, ".pi/github-runners.json"), JSON.stringify({
    sizes: [{ name: "small", labels: ["ci"], quantity: 1, serverType: "cpx21", location: "fsn1", image: "ubuntu-24.04", firewallId: "1", runnerVersion: "2.321.0", runnerArchiveSha256: "a".repeat(64), maxHourlyCostEur: 1, maxEligibilityCostEur: 2 }],
    ...JSON.parse(extra || "{}"),
  }));
}

describe("setupRunners bounded wizard", () => {
  it("lets generated users edit polling, rejects an invalid value, and saves the retry", async () => {
    const paths = await root();
    const ctx = scripted(["Repository pool for acme/widgets", "Edit polling interval", "Edit polling interval", "Continue to pools", "Add named pool", "Edit quantity", "0", "Done", "Continue to review", "Save disabled configuration"], ["4", "5"]);
    await expect(setupRunners(ctx, { root: paths.root, repository: "acme/widgets" }, services(), { home: paths.home })).resolves.toBe(true);
    await expect(loadSettings(paths.root, { home: paths.home })).resolves.toMatchObject({ pollIntervalSeconds: 5, sizes: [{ quantity: 0 }] });
    expect(ctx.ui.notify).toHaveBeenCalledWith("Polling interval must be an integer from 5 to 3600.", "error");
  });

  it("saves generated pools disabled with finite accepted caps", async () => {
    const paths = await root();
    await expect(setupRunners(scripted(poolChoices(), poolInputs()), { root: paths.root, repository: "acme/widgets" }, services(), { home: paths.home })).resolves.toBe(true);
    await expect(loadSettings(paths.root, { home: paths.home })).resolves.toMatchObject({ automationEnabled: false, startOnLoad: false, sizes: [{ name: "small", quantity: 1, maxHourlyCostEur: 0.0101 }] });
  });

  it("allows remote pool quantity and infrastructure edits while preserving installation identity and blocking local enable", async () => {
    const paths = await root();
    await writeGenerated(paths, JSON.stringify({ reaper: { sshTarget: "runner-host", installationId: "a".repeat(16), environmentFile: "/srv/runners.env" } }));
    const fixture = services();
    const choices = ["Continue to pools", "Edit 1: small: 1 runner · cpx21 · fsn1 · ci", "Edit quantity", "2", "Edit infrastructure", "cx22 — 2 vCPU, 4 GB RAM, 40 GB disk", "fsn1", "ubuntu-24.04 — Ubuntu", "1 — runners", "Done", "Continue to review", "Save disabled configuration"];
    await expect(setupRunners(scripted(choices), { root: paths.root, repository: "acme/widgets" }, fixture, { home: paths.home })).resolves.toBe(true);
    await expect(loadSettings(paths.root, { home: paths.home })).resolves.toMatchObject({ reaper: { installationId: "a".repeat(16) }, sizes: [{ quantity: 2, serverType: "cx22" }], automationEnabled: false });
    expect(fixture.validate).not.toHaveBeenCalled();
  });

  it("shows generated draft fields and fresh aggregate review details", async () => {
    const paths = await root();
    const ctx = scripted(poolChoices(), poolInputs());
    await expect(setupRunners(ctx, { root: paths.root, repository: "acme/widgets" }, services(), { home: paths.home })).resolves.toBe(true);
    const notices = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.map(([message]) => String(message)).join("\n");
    expect(notices).toContain("SHA-256");
    expect(notices).toContain("workflow runs-on: [\"self-hosted\",\"linux\",\"x64\",\"ci\"]");
    expect(notices).toContain("Aggregate estimate: €0.010001/hour");
    expect(notices).toContain("VAT and variable traffic are excluded.");
  });

  it("keeps generated review fields visible when preview is unavailable", async () => {
    const paths = await root();
    const ctx = scripted(poolChoices(), poolInputs());
    await expect(setupRunners(ctx, { root: paths.root, repository: "acme/widgets" }, services({ preview: async () => { throw new Error("offline"); } }), { home: paths.home })).resolves.toBe(true);
    const notices = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.map(([message]) => String(message)).join("\n");
    expect(notices).toContain("Generated pool small");
    expect(notices).toContain("Fresh policy estimates unavailable; accepted caps are ceilings, not quotes.");
  });

  it("shows authoritative legacy timing and cost fields without catalog discovery", async () => {
    const paths = await root();
    await mkdir(join(paths.root, ".pi"), { recursive: true });
    const policy = join(paths.root, "legacy.yaml");
    await writeFile(policy, await readFile(new URL("../examples/policy.yaml", import.meta.url)));
    await writeFile(join(paths.root, ".pi/github-runners.json"), JSON.stringify({ policies: ["legacy.yaml"] }));
    const fixture = services();
    const ctx = scripted(["Keep existing legacy policies unchanged", "Continue to review", "Save disabled configuration"]);
    await expect(setupRunners(ctx, { root: paths.root, repository: "owner/repository" }, fixture, { home: paths.home })).resolves.toBe(true);
    const notices = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.map(([message]) => String(message)).join("\n");
    expect(notices).toContain("actual idle 900s, max lifetime 3600s");
    expect(notices).toContain("policy caps €1.1/hour");
    expect(fixture.catalog).not.toHaveBeenCalled();
  });

  it("keeps duplicate named pools editable instead of saving them", async () => {
    const paths = await root();
    const choices = ["Repository pool for acme/widgets", "Continue to pools", "Add named pool", "Edit name", "Done", "Add named pool", "Edit name", "Done", "Continue to review", "Edit 2: SMALL: 0 runners · unresolved · no location · no custom routing labels", "Edit name", "Done", "Continue to review", "Save disabled configuration"];
    const ctx = scripted(choices, ["small", "SMALL", "large"]);
    await expect(setupRunners(ctx, { root: paths.root, repository: "acme/widgets" }, services(), { home: paths.home })).resolves.toBe(true);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("unique name"), "error");
    await expect(loadSettings(paths.root, { home: paths.home })).resolves.toMatchObject({ sizes: [{ name: "small" }, { name: "large" }] });
  });

  it("returns directly to the pool editor after cancelling nested infrastructure selection", async () => {
    const paths = await root();
    const ctx = scripted(["Repository pool for acme/widgets", "Continue to pools", "Add named pool", "Edit infrastructure", "Done", "Continue to review", "Save disabled configuration"]);
    const select = ctx.ui.select;
    ctx.ui.select = async (title, options) => title === "Hetzner server type" ? undefined : select(title, options);
    await expect(setupRunners(ctx, { root: paths.root, repository: "acme/widgets" }, services(), { home: paths.home })).resolves.toBe(true);
    await expect(loadSettings(paths.root, { home: paths.home })).resolves.toMatchObject({ sizes: [{ quantity: 0, location: "" }] });
  });

  it("handles thrown credential discovery with a configuration-only save", async () => {
    const paths = await root();
    const fixture = services({ credentials: async () => { throw new Error("no keychain"); } });
    const ctx = scripted(["Repository pool for acme/widgets", "Continue configuration-only", "Continue to pools", "Add named pool", "Edit quantity", "0", "Done", "Continue to review", "Save disabled configuration"]);
    await expect(setupRunners(ctx, { root: paths.root, repository: "acme/widgets" }, fixture, { home: paths.home })).resolves.toBe(true);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Credential discovery failed: no keychain"), "warning");
  });

  it("retains an existing verified pin when release discovery fails", async () => {
    const paths = await root();
    await writeGenerated(paths);
    const fixture = services({ release: async () => { throw new Error("offline"); } });
    await expect(setupRunners(scripted(["Repository pool for acme/widgets", "Continue to pools", "Edit 1: small: 1 runner · cpx21 · fsn1 · ci", "Done", "Continue to review", "Save disabled configuration"]), { root: paths.root, repository: "acme/widgets" }, fixture, { home: paths.home })).resolves.toBe(true);
    await expect(loadSettings(paths.root, { home: paths.home })).resolves.toMatchObject({ sizes: [{ runnerVersion: "2.321.0", runnerArchiveSha256: "a".repeat(64) }] });
  });

  it("supports multiple quantities and types and removing a pool", async () => {
    const paths = await root();
    const choices = ["Repository pool for acme/widgets", "Continue to pools", "Add named pool", "Edit name", "Edit routing labels", "Edit quantity", "1", "Edit infrastructure", "cpx21 — 3 vCPU, 4 GB RAM, 80 GB disk", "fsn1", "ubuntu-24.04 — Ubuntu", "1 — runners", "Update or edit runner pin", "Update to verified stable Linux x64 2.321.0", "Quote and set cost caps", "Done", "Add named pool", "Edit name", "Edit routing labels", "Edit quantity", "2", "Edit infrastructure", "cx22 — 2 vCPU, 4 GB RAM, 40 GB disk", "fsn1", "ubuntu-24.04 — Ubuntu", "1 — runners", "Update or edit runner pin", "Update to verified stable Linux x64 2.321.0", "Quote and set cost caps", "Done", "Edit 1: first: 1 runner · cpx21 · fsn1 · ci", "Remove pool", "Continue to review", "Save disabled configuration"];
    await expect(setupRunners(scripted(choices, [...poolInputs("first"), "second", "ci-two", "0.0200", "0.2000"]), { root: paths.root, repository: "acme/widgets" }, services(), { home: paths.home })).resolves.toBe(true);
    await expect(loadSettings(paths.root, { home: paths.home })).resolves.toMatchObject({ sizes: [{ name: "second", quantity: 2, serverType: "cx22" }] });
  });

  it.each([
    ["cost", [false]],
    ["sole-writer", [true, false]],
  ])("does not enable when %s consent is declined", async (_name, confirms) => {
    const paths = await root();
    const choices = [...poolChoices("small", "Save and enable local automation"), "Save disabled configuration"];
    await expect(setupRunners(scripted(choices, poolInputs(), confirms), { root: paths.root, repository: "acme/widgets" }, services(), { home: paths.home })).resolves.toBe(true);
    await expect(loadSettings(paths.root, { home: paths.home })).resolves.toMatchObject({ automationEnabled: false });
  });

  it.each(["local", "global"])("refuses a concurrent %s configuration change", async (kind) => {
    const paths = await root();
    const target = kind === "local" ? join(paths.root, ".pi/github-runners.json") : join(paths.home, ".pi/agent/github-runners.json");
    const ctx = scripted(["Repository pool for acme/widgets", "Continue to pools", "Add named pool", "Edit quantity", "0", "Done", "Continue to review", "Save disabled configuration"]);
    const originalSelect = ctx.ui.select;
    ctx.ui.select = async (title, options) => {
      const answer = await originalSelect(title, options);
      if (answer === "Save disabled configuration") {
        await mkdir(join(target, ".."), { recursive: true });
        await writeFile(target, "{}\n");
      }
      return answer;
    };
    if (kind === "global") {
      ctx.ui.select = async (_title, options) => options.includes("Shared organization pool") ? "Shared organization pool" : originalSelect(_title, options);
    }
    if (kind === "global") {
      const globalCtx = scripted(["Shared organization pool", "Continue configuration-only", "Continue to pools", "Add named pool", "Edit quantity", "0", "Done", "Continue to review", "Save disabled configuration"], ["acme", "acme/widgets", "shared", "1"]);
      const select = globalCtx.ui.select;
      globalCtx.ui.select = async (title, options) => {
        const answer = await select(title, options);
        if (answer === "Save disabled configuration") {
          await mkdir(join(paths.home, ".pi/agent"), { recursive: true });
          await writeFile(join(paths.home, ".pi/agent/github-runners.json"), "{}\n");
        }
        return answer;
      };
      await expect(setupRunners(globalCtx, { root: paths.root, repository: "acme/widgets" }, services({ credentials: async () => ({ hcloud: false, github: false, githubSource: "missing", guidance: [] }) }), { home: paths.home })).resolves.toBe(false);
    } else {
      await expect(setupRunners(ctx, { root: paths.root, repository: "acme/widgets" }, services(), { home: paths.home })).resolves.toBe(false);
    }
  });

  it.each([
    ["accepts", true, true],
    ["declines", false, false],
  ])("%s conversion of unresolved capacity to a zero draft", async (_name, accept, saved) => {
    const paths = await root();
    const choices = ["Repository pool for acme/widgets", "Continue to pools", "Add named pool", "Edit quantity", "1", "Done", "Continue to review", ...(accept ? ["Save disabled configuration"] : ["Cancel setup"])];
    await expect(setupRunners(scripted(choices, [], accept), { root: paths.root, repository: "acme/widgets" }, services(), { home: paths.home })).resolves.toBe(saved);
    if (saved) await expect(loadSettings(paths.root, { home: paths.home })).resolves.toMatchObject({ sizes: [{ quantity: 0 }] });
  });

  it.each(["rpc", "json", "print", undefined, "unknown"])('refuses hasUI sessions in %s mode before opening a dialog', async (mode) => {
    const paths = await root();
    const ui = { select: vi.fn(), input: vi.fn(), confirm: vi.fn(), notify: vi.fn() };
    const fixture = services();
    await expect(setupRunners({ hasUI: true, mode, ui }, { root: paths.root, repository: "acme/widgets" }, fixture, { home: paths.home })).resolves.toBe(false);
    expect(ui.select).not.toHaveBeenCalled();
    expect(ui.input).not.toHaveBeenCalled();
    expect(ui.confirm).not.toHaveBeenCalled();
    expect(fixture.credentials).not.toHaveBeenCalled();
  });

  it("activates a generated pool only after fresh validation, fresh typed preview, both confirmations, and a prewarm choice", async () => {
    const paths = await root();
    const fixture = services();
    const ctx = scripted([...poolChoices("small", "Save and enable local automation"), "Prewarm selected pool quantities once, then expire normally"], poolInputs(), [true, true]);
    await expect(setupRunners(ctx, { root: paths.root, repository: "acme/widgets" }, fixture, { home: paths.home })).resolves.toBe(true);
    await expect(loadSettings(paths.root, { home: paths.home })).resolves.toMatchObject({ automationEnabled: true, startOnLoad: true });
    expect(fixture.validate).toHaveBeenCalledWith(expect.objectContaining({ automationEnabled: true }));
    expect(fixture.preview).toHaveBeenCalledTimes(2);
    expect(fixture.validate.mock.invocationCallOrder[0]).toBeGreaterThan(fixture.preview.mock.invocationCallOrder[0]);
    expect(fixture.preview.mock.invocationCallOrder[1]).toBeGreaterThan(fixture.validate.mock.invocationCallOrder[0]);
    expect(ctx.ui.confirm).toHaveBeenCalledTimes(2);
  });

  it("activates legacy policies without catalog or release discovery and shows preview timing and cap fields", async () => {
    const paths = await root();
    await mkdir(join(paths.root, ".pi"), { recursive: true });
    await writeFile(join(paths.root, "legacy.yaml"), await readFile(new URL("../examples/policy.yaml", import.meta.url)));
    await writeFile(join(paths.root, ".pi/github-runners.json"), JSON.stringify({ policies: ["legacy.yaml"] }));
    const fixture = services();
    const ctx = scripted(["Keep existing legacy policies unchanged", "Continue to review", "Save and enable local automation", "Polling only; do not prewarm"], [], [true, true]);
    await expect(setupRunners(ctx, { root: paths.root, repository: "owner/repository" }, fixture, { home: paths.home })).resolves.toBe(true);
    await expect(loadSettings(paths.root, { home: paths.home })).resolves.toMatchObject({ automationEnabled: true, startOnLoad: false, policies: [join(paths.root, "legacy.yaml")] });
    expect(fixture.catalog).not.toHaveBeenCalled();
    expect(fixture.release).not.toHaveBeenCalled();
    const notices = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock.calls.map(([message]) => String(message)).join("\n");
    expect(notices).toContain("actual idle 900s, max lifetime 3600s");
    expect(notices).toContain("policy caps €1.1/hour");
  });

  it("keeps a generated configuration disabled when fresh activation validation fails", async () => {
    const paths = await root();
    const fixture = services({ validate: vi.fn(async () => { throw new Error("scope changed"); }) });
    const ctx = scripted([...poolChoices("small", "Save and enable local automation"), "Save disabled configuration"], poolInputs());
    await expect(setupRunners(ctx, { root: paths.root, repository: "acme/widgets" }, fixture, { home: paths.home })).resolves.toBe(true);
    await expect(loadSettings(paths.root, { home: paths.home })).resolves.toMatchObject({ automationEnabled: false, startOnLoad: false });
    expect(fixture.preview).toHaveBeenCalledTimes(2);
    expect(ctx.ui.confirm).not.toHaveBeenCalled();
  });

  it.each([
    ["missing credentials dismissed", services({ credentials: vi.fn(async () => ({ hcloud: false, github: false, githubSource: "missing", guidance: [] })) }), ["Repository pool for acme/widgets"], "Credentials before discovery"],
    ["missing credentials explicitly cancelled", services({ credentials: vi.fn(async () => ({ hcloud: false, github: false, githubSource: "missing", guidance: [] })) }), ["Repository pool for acme/widgets", "Cancel setup"], "Credentials before discovery"],
    ["failed catalog dismissed", services({ catalog: vi.fn(async () => { throw new Error("offline"); }) }), ["Repository pool for acme/widgets"], "Discovery needs attention"],
    ["failed catalog explicitly cancelled", services({ catalog: vi.fn(async () => { throw new Error("offline"); }) }), ["Repository pool for acme/widgets", "Cancel setup"], "Discovery needs attention"],
  ])("cancels %s without changing bytes or returning to scope", async (_name, fixture, choices, terminalTitle) => {
    const paths = await root();
    await writeGenerated(paths);
    const target = join(paths.root, ".pi/github-runners.json");
    const before = await readFile(target);
    const ctx = scripted([...choices]);
    await expect(setupRunners(ctx, { root: paths.root, repository: "acme/widgets" }, fixture, { home: paths.home })).resolves.toBe(false);
    expect(await readFile(target)).toEqual(before);
    expect((ctx.ui.select as ReturnType<typeof vi.fn>).mock.calls.filter(([title]) => title === "1 of 5 — Runner scope")).toHaveLength(1);
    expect((ctx.ui.select as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0]).toBe(terminalTitle);
  });

  it.each(["legacy", "remote"])("bounds %s runtime cancellation after an idle-input dismissal", async (kind) => {
    const paths = await root();
    if (kind === "legacy") {
      await mkdir(join(paths.root, ".pi"), { recursive: true });
      await writeFile(join(paths.root, "legacy.yaml"), await readFile(new URL("../examples/policy.yaml", import.meta.url)));
      await writeFile(join(paths.root, ".pi/github-runners.json"), JSON.stringify({ policies: ["legacy.yaml"] }));
    } else {
      await writeGenerated(paths, JSON.stringify({ reaper: { sshTarget: "runner-host", installationId: "a".repeat(16), environmentFile: "/srv/runners.env" } }));
    }
    const ctx = scripted(kind === "legacy" ? ["Keep existing legacy policies unchanged", "Edit idle expiry", "Cancel setup"] : ["Edit idle expiry", "Cancel setup"]);
    await expect(setupRunners(ctx, { root: paths.root, repository: "acme/widgets" }, services(), { home: paths.home })).resolves.toBe(false);
    expect((ctx.ui.select as ReturnType<typeof vi.fn>).mock.calls.filter(([title]) => title === "Runtime settings")).toHaveLength(2);
  });

  it.each(["legacy", "remote"])("returns false for an explicit %s runtime cancellation", async (kind) => {
    const paths = await root();
    if (kind === "legacy") {
      await mkdir(join(paths.root, ".pi"), { recursive: true });
      await writeFile(join(paths.root, "legacy.yaml"), await readFile(new URL("../examples/policy.yaml", import.meta.url)));
      await writeFile(join(paths.root, ".pi/github-runners.json"), JSON.stringify({ policies: ["legacy.yaml"] }));
    } else {
      await writeGenerated(paths, JSON.stringify({ reaper: { sshTarget: "runner-host", installationId: "a".repeat(16), environmentFile: "/srv/runners.env" } }));
    }
    const ctx = scripted(kind === "legacy" ? ["Keep existing legacy policies unchanged", "Cancel setup"] : ["Cancel setup"]);
    await expect(setupRunners(ctx, { root: paths.root, repository: "acme/widgets" }, services(), { home: paths.home })).resolves.toBe(false);
    expect((ctx.ui.select as ReturnType<typeof vi.fn>).mock.calls.filter(([title]) => title === "Runtime settings")).toHaveLength(1);
  });

  it("preserves completed pool fields when infrastructure selection and the editor are backed out", async () => {
    const paths = await root();
    const initialPool = poolChoices();
    const choices = [...initialPool.slice(0, initialPool.indexOf("Continue to review")), "Edit 1: small: 1 runner · cpx21 · fsn1 · ci", "Edit infrastructure", "Back", "Continue to review", "Save disabled configuration"];
    const ctx = scripted(choices, poolInputs());
    const select = ctx.ui.select;
    let infrastructureVisits = 0;
    ctx.ui.select = vi.fn(async (title, options) => {
      if (title === "Hetzner server type" && ++infrastructureVisits === 2) return undefined;
      return select(title, options);
    });
    await expect(setupRunners(ctx, { root: paths.root, repository: "acme/widgets" }, services(), { home: paths.home })).resolves.toBe(true);
    await expect(loadSettings(paths.root, { home: paths.home })).resolves.toMatchObject({ sizes: [{ name: "small", quantity: 1, serverType: "cpx21", location: "fsn1", image: "ubuntu-24.04", firewallId: "1" }] });
  });

  it("warns before accepting a generated identity transition, preserves bytes on decline, and permits restoration after acceptance", async () => {
    const paths = await root();
    await writeGenerated(paths, JSON.stringify({ automationEnabled: true, startOnLoad: true }));
    const target = join(paths.root, ".pi/github-runners.json");
    const original = await readFile(target);
    const decline = scripted(["Repository pool for acme/widgets", "Continue to pools", "Edit 1: small: 1 runner · cpx21 · fsn1 · ci", "Edit name", "Done", "Continue to review", "Save disabled configuration", "Cancel without saving"], ["renamed"], false);
    await expect(setupRunners(decline, { root: paths.root, repository: "acme/widgets" }, services(), { home: paths.home })).resolves.toBe(false);
    expect(await readFile(target)).toEqual(original);
    expect(decline.ui.confirm).toHaveBeenCalledWith("Generated pool identity changed", expect.stringContaining("no automatic cleanup occurs"));

    const accept = scripted(["Repository pool for acme/widgets", "Continue to pools", "Edit 1: small: 1 runner · cpx21 · fsn1 · ci", "Edit name", "Done", "Continue to review", "Save disabled configuration"], ["renamed"], true);
    await expect(setupRunners(accept, { root: paths.root, repository: "acme/widgets" }, services(), { home: paths.home })).resolves.toBe(true);
    await expect(loadSettings(paths.root, { home: paths.home })).resolves.toMatchObject({ sizes: [{ name: "renamed" }], automationEnabled: false });
    await writeFile(target, original);
    await expect(loadSettings(paths.root, { home: paths.home })).resolves.toMatchObject({ sizes: [{ name: "small" }], automationEnabled: true, startOnLoad: true });
  });

  it.each([
    ["standby", ["Repository pool for acme/widgets", "Edit idle expiry", "Continue to pools", "Edit 1: small: 1 runner · cpx21 · fsn1 · ci", "Done", "Continue to review", "Save disabled configuration", "Cancel without saving"], ["16"]],
    ["quantity", ["Repository pool for acme/widgets", "Continue to pools", "Edit 1: small: 1 runner · cpx21 · fsn1 · ci", "Edit quantity", "2", "Done", "Continue to review", "Save disabled configuration", "Cancel without saving"], []],
    ["removal", ["Repository pool for acme/widgets", "Continue to pools", "Edit 1: small: 1 runner · cpx21 · fsn1 · ci", "Remove pool", "Continue to review", "Save disabled configuration", "Cancel without saving"], []],
  ])("does not save an active generated pool %s identity transition when it is declined", async (_change, choices, inputs) => {
    const paths = await root();
    await writeGenerated(paths, JSON.stringify({ automationEnabled: true, startOnLoad: true }));
    const target = join(paths.root, ".pi/github-runners.json");
    const original = await readFile(target);
    const ctx = scripted([...choices], [...inputs], false);
    await expect(setupRunners(ctx, { root: paths.root, repository: "acme/widgets" }, services(), { home: paths.home })).resolves.toBe(false);
    expect(ctx.ui.confirm).toHaveBeenCalledWith("Generated pool identity changed", expect.stringContaining("no automatic cleanup occurs"));
    expect(await readFile(target)).toEqual(original);
  });

  it("does not overwrite an existing global target when confirmation is declined and names both target paths", async () => {
    const paths = await root();
    await mkdir(join(paths.root, ".pi"), { recursive: true });
    await mkdir(join(paths.home, ".pi/agent"), { recursive: true });
    await writeFile(join(paths.root, ".pi/github-runners.json"), JSON.stringify({ mode: "global" }) + "\n");
    await writeFile(join(paths.home, ".pi/agent/github-runners.json"), JSON.stringify({ organization: { name: "acme", repositories: ["acme/widgets"], runnerGroupName: "shared", runnerGroupId: 1 }, sizes: [{ name: "small", labels: ["ci"], quantity: 1, serverType: "cpx21", location: "fsn1", image: "ubuntu-24.04", firewallId: "1", runnerVersion: "2.321.0", runnerArchiveSha256: "a".repeat(64), maxHourlyCostEur: 1, maxEligibilityCostEur: 2 }] }) + "\n");
    const local = await readFile(join(paths.root, ".pi/github-runners.json"));
    const global = await readFile(join(paths.home, ".pi/agent/github-runners.json"));
    const ctx = scripted(["Shared organization pool", "Continue to pools", "Edit 1: small: 1 runner · cpx21 · fsn1 · ci", "Done", "Continue to review", "Save disabled configuration", "Cancel without saving"], ["acme", "acme/widgets", "shared", "1"], false);
    await expect(setupRunners(ctx, { root: paths.root, repository: "acme/widgets" }, services(), { home: paths.home })).resolves.toBe(false);
    expect(await readFile(join(paths.root, ".pi/github-runners.json"))).toEqual(local);
    expect(await readFile(join(paths.home, ".pi/agent/github-runners.json"))).toEqual(global);
    expect(ctx.ui.confirm).toHaveBeenCalledWith("Overwrite existing global runner configuration?", expect.stringContaining(`saves to ${join(paths.home, ".pi/agent/github-runners.json")}`));
    expect(ctx.ui.confirm).toHaveBeenCalledWith("Overwrite existing global runner configuration?", expect.stringContaining(`local selector ${join(paths.root, ".pi/github-runners.json")}`));
  });

  it("retains legacy YAML and rejects non-TUI sessions", async () => {
    const paths = await root();
    await mkdir(join(paths.root, ".pi"), { recursive: true });
    const policy = join(paths.root, "legacy.yaml");
    const yaml = await readFile(new URL("../examples/policy.yaml", import.meta.url));
    await writeFile(policy, yaml);
    await writeFile(join(paths.root, ".pi/github-runners.json"), JSON.stringify({ policies: ["legacy.yaml"] }));
    await expect(setupRunners(scripted(["Keep existing legacy policies unchanged", "Continue to review", "Save disabled configuration"]), { root: paths.root, repository: "owner/repository" }, services(), { home: paths.home })).resolves.toBe(true);
    expect(await readFile(policy)).toEqual(yaml);
    await expect(setupRunners({ hasUI: false, ui: { select: async () => undefined, input: async () => undefined, confirm: async () => false, notify: vi.fn() } }, { root: paths.root, repository: "owner/repository" }, services(), { home: paths.home })).resolves.toBe(false);
  });
});
