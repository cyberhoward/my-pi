import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configureRunners } from "../settings-menu.js";
import { loadSettings } from "../settings.js";

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
