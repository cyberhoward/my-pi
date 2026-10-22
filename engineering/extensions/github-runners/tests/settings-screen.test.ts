import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { configureRunners } from "../settings-menu.js";
import { visibleWidth } from "@earendil-works/pi-tui";
import { RunnerSettingsScreen } from "../settings-screen.js";
import type { RunnerSettings } from "../settings.js";

const theme = { fg: (_token: string, text: string) => text, bold: (text: string) => text };
function settings(): RunnerSettings {
  return { mode: "local", policies: [], pollIntervalSeconds: 60, standbyMinutes: 15, startOnLoad: false, automationEnabled: false, sizes: [], sourcePath: "settings.json" };
}

describe("runner settings screen", () => {
  it("renders safely at narrow widths and uses native list keyboard and mouse actions", () => {
    initTheme("dark");
    const draft = settings();
    const actions: string[] = [];
    let accent = "one";
    const liveTheme = { fg: (_token: string, text: string) => `[${accent}]${text}`, bold: (text: string) => text };
    const screen = new RunnerSettingsScreen(draft, JSON.stringify(draft), liveTheme, action => actions.push(action.id));
    for (const width of [1, 8, 24, 80]) expect(screen.render(width).every(line => visibleWidth(line) <= width)).toBe(true);
    screen.handleInput(" ");
    expect(draft.mode).toBe("global");
    accent = "two";
    expect(screen.render(80).join("\n")).toContain("[two]GitHub runner settings • unsaved changes");
    screen.handleInput("s");
    screen.handleInput("t");
    screen.handleInput("a");
    screen.handleInput("r");
    screen.handleInput("t");
    screen.handleInput("\r");
    expect(draft.startOnLoad).toBe(true);
    screen.handleInput("\u001b");
    expect(actions).toContain("discard");
    const guidedScreen = new RunnerSettingsScreen(settings(), JSON.stringify(settings()), theme, action => actions.push(action.id));
    guidedScreen.settingsList.selectItem("guided-setup");
    guidedScreen.handleInput(" ");
    expect(actions).toContain("guided-setup");
    const mouseDraft = settings();
    const mouseScreen = new RunnerSettingsScreen(mouseDraft, JSON.stringify(mouseDraft), theme, () => undefined);
    mouseScreen.render(80);
    const event = { button: "left" as const, x: 0, y: 4, screenX: 0, screenY: 4, width: 80, height: 20, shift: false, alt: false, ctrl: false };
    expect(mouseScreen.handleMouse({ ...event, type: "press" })).toMatchObject({ handled: true, focus: true });
    expect(mouseScreen.handleMouse({ ...event, type: "click" })).toMatchObject({ handled: true });
    expect(mouseDraft.mode).toBe("global");
  });

  it("uses the custom TUI controller for edits, confirmations, selection restoration, and save", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-screen-"));
    await mkdir(join(root, ".pi"));
    const configPath = join(root, ".pi/github-runners.json");
    await writeFile(configPath, JSON.stringify({ sizes: [{ name: "small", labels: ["ci-small"], quantity: 1, serverType: "cpx21", location: "fsn1", image: "ubuntu-24.04", firewallId: "1", runnerVersion: "2.321.0", runnerArchiveSha256: "a".repeat(64), maxHourlyCostEur: 1, maxEligibilityCostEur: 2 }] }));
    const initial = await readFile(configPath, "utf8");
    const inputs = ["AcMe"];
    const confirms = [false, true];
    let calls = 0;
    const ctx = { hasUI: true, mode: "tui", ui: {
      select: async () => undefined,
      input: async () => inputs.shift(),
      editor: async () => undefined,
      confirm: async () => confirms.shift() ?? false,
      notify: () => undefined,
      custom: async <T>(factory: (tui: { requestRender(): void }, currentTheme: typeof theme, keybindings: unknown, done: (value: T) => void) => { handleInput(data: string): void; render(width: number): string[] }): Promise<T> => {
        let result: T | undefined;
        const component = await factory({ requestRender: () => undefined }, theme, {}, value => { result = value; });
        if (calls === 0) { component.handleInput("\u001b[B"); component.handleInput("\r"); }
        if (calls === 1) { for (let index = 0; index < 6; index++) component.handleInput("\u001b[B"); component.handleInput("\r"); }
        if (calls === 2) component.handleInput("\r");
        if (calls === 3) { component.handleInput("\u001b[B"); component.handleInput("\u001b[B"); component.handleInput("\r"); }
        if (calls < 3) expect(await readFile(configPath, "utf8")).toBe(initial);
        calls++;
        return result as T;
      },
    } };
    expect(await configureRunners(ctx, { root, repository: "acme/widgets" })).toBe(true);
    expect(calls).toBe(4);
    await expect(readFile(configPath, "utf8")).resolves.toContain('"organization": {\n    "name": "acme"');
    await expect(readFile(configPath, "utf8")).resolves.toContain('"automationEnabled": true');
  });

  it("rejects invalid native size JSON without losing the prior draft, then saves a valid replacement", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-screen-"));
    await mkdir(join(root, ".pi"));
    const configPath = join(root, ".pi/github-runners.json");
    const size = { name: "small", labels: ["ci-small"], quantity: 0, serverType: "cpx21", location: "fsn1", image: "ubuntu-24.04", firewallId: "", runnerVersion: "", runnerArchiveSha256: "", maxHourlyCostEur: 0, maxEligibilityCostEur: 0 };
    await writeFile(configPath, JSON.stringify({ sizes: [size] }));
    const editorResponses = ["{", "null", "{}", '[{"name":"incomplete"}]', JSON.stringify([{ ...size, name: "renamed" }])];
    const editorInitials: string[] = [];
    const notify = vi.fn();
    let calls = 0;
    const ctx = { hasUI: true, mode: "tui", ui: {
      select: async () => undefined, input: async () => undefined,
      editor: async (_title: string, initial: string) => { editorInitials.push(initial); return editorResponses.shift(); },
      confirm: async () => false, notify,
      custom: async <T>(factory: (tui: { requestRender(): void }, currentTheme: typeof theme, keybindings: unknown, done: (value: T) => void) => { handleInput(data: string): void }): Promise<T> => {
        let result: T | undefined;
        const component = await factory({ requestRender: () => undefined }, theme, {}, value => { result = value; });
        if (calls === 0) { for (let index = 0; index < 4; index++) component.handleInput("\u001b[B"); component.handleInput("\r"); }
        else if (calls < 5) component.handleInput("\r");
        else { for (let index = 0; index < 5; index++) component.handleInput("\u001b[B"); component.handleInput("\r"); }
        calls++;
        return result as T;
      },
    } };
    expect(await configureRunners(ctx, { root, repository: "acme/widgets" })).toBe(true);
    expect(calls).toBe(6);
    expect(editorInitials.slice(0, 5)).toEqual(Array(5).fill(JSON.stringify([size], null, 2)));
    expect(notify).toHaveBeenCalledTimes(4);
    await expect(readFile(configPath, "utf8")).resolves.toContain('"name": "renamed"');
    await expect(readFile(configPath, "utf8")).resolves.toContain('"quantity": 0');
  });

  it("confirms discard before navigating an unsaved advanced fallback draft", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-screen-"));
    await mkdir(join(root, ".pi"));
    const configPath = join(root, ".pi/github-runners.json");
    await writeFile(configPath, JSON.stringify({ startOnLoad: false }));
    const navigation = vi.fn(async () => false);
    let settingsMenuCalls = 0;
    const ctx = { hasUI: true, mode: "plain", ui: {
      select: async (title: string) => title === "Runner pool scope" ? "global" : settingsMenuCalls++ === 0 ? "Scope: local repository pool" : "Guided setup (scope, pools, quantities, infrastructure, costs)",
      input: async () => undefined, editor: async () => undefined, confirm: async () => true, notify: () => undefined,
    } };
    expect(await configureRunners(ctx, { root, repository: "acme/widgets" }, { onGuidedSetup: navigation })).toBe(false);
    expect(navigation).toHaveBeenCalledOnce();
    expect(await readFile(configPath, "utf8")).toContain('"startOnLoad":false');
  });

  it("discards a mutated native draft without persistence", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-screen-"));
    await mkdir(join(root, ".pi"));
    const configPath = join(root, ".pi/github-runners.json");
    const original = '{"startOnLoad":false}\n';
    await writeFile(configPath, original);
    let doneAction: unknown;
    const ctx = { hasUI: true, mode: "tui", ui: {
      select: async () => undefined, input: async () => undefined, editor: async () => undefined, confirm: async () => false, notify: () => undefined,
      custom: async <T>(factory: (tui: { requestRender(): void }, currentTheme: typeof theme, keybindings: unknown, done: (value: T) => void) => { handleInput(data: string): void }): Promise<T> => {
        let result: T | undefined;
        const component = await factory({ requestRender: () => undefined }, theme, {}, value => { doneAction = value; result = value; });
        for (let index = 0; index < 6; index++) component.handleInput("\u001b[B");
        component.handleInput("\r");
        component.handleInput("\u001b");
        return result as T;
      },
    } };
    expect(await configureRunners(ctx, { root, repository: "acme/widgets" })).toBe(false);
    expect(doneAction).toEqual({ id: "discard" });
    expect(await readFile(configPath, "utf8")).toBe(original);
  });
});
