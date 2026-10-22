import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { RepositoryBinding } from "./repository.js";
import { automationErrors, loadSettings, parseRunnerSizes, saveSettings, type RunnerSettings } from "./settings.js";
import { materializePolicies } from "./policies.js";
import { assertLiveConfig, loadPolicy } from "./src/config.js";
import { RunnerSettingsScreen, type SettingsScreenAction } from "./settings-screen.js";

type MenuContext = {
  hasUI?: boolean;
  mode?: string;
  ui: Pick<ExtensionUIContext, "select" | "input" | "editor" | "confirm" | "notify"> & Partial<Pick<ExtensionUIContext, "custom">>;
};
type ConfigureResult = boolean | "guided-setup";
export interface ConfigureRunnersOptions { onGuidedSetup?: () => Promise<boolean>; }

const sizeTemplate = [{
  name: "small-linux", labels: ["pi-runner-small"], quantity: 0,
  serverType: "cpx21", location: "fsn1", image: "ubuntu-24.04", firewallId: "",
  runnerVersion: "2.x", runnerArchiveSha256: "REPLACE_WITH_PINNED_SHA256",
  maxHourlyCostEur: 0, maxEligibilityCostEur: 0,
}];

function notice(ctx: MenuContext, message: string, type: "info" | "warning" | "error" = "info"): void { ctx.ui.notify?.(message, type); }
function clone(settings: RunnerSettings): RunnerSettings { return JSON.parse(JSON.stringify(settings)) as RunnerSettings; }
function parseList(value: string): string[] { return [...new Set(value.split(/[,\n]/).map((item) => item.trim().toLowerCase()).filter(Boolean))].sort((left, right) => left.localeCompare(right)); }
function updateOrganization(settings: RunnerSettings, value: Partial<NonNullable<RunnerSettings["organization"]>>): void {
  settings.organization = { name: "", repositories: [], runnerGroupId: 0, runnerGroupName: "", ...settings.organization, ...value };
}
async function validateAutomation(binding: RepositoryBinding, settings: RunnerSettings): Promise<void> {
  const materialized = await materializePolicies(binding, { ...settings, automationEnabled: true });
  try {
    if (!materialized.policies.length) throw new Error("no runner policies are configured");
    for (const policy of materialized.policies) {
      const loaded = await loadPolicy(policy.path);
      if (!loaded.mutationEnabled) throw new Error(`${policy.name} must explicitly enable mutations`);
      assertLiveConfig(loaded.config);
    }
  } finally { await materialized.cleanup(); }
}
async function changeAutomation(ctx: MenuContext, binding: RepositoryBinding, settings: RunnerSettings): Promise<void> {
  if (settings.automationEnabled) { settings.automationEnabled = false; return; }
  const errors = automationErrors(settings);
  if (errors.length) { notice(ctx, `Cannot enable automation:\n${errors.join("\n")}`, "error"); return; }
  try { await validateAutomation(binding, settings); }
  catch (error) { notice(ctx, `Cannot enable automation:\n${error instanceof Error ? error.message : "runner policies could not be validated"}`, "error"); return; }
  if (await ctx.ui.confirm("Enable runner automation?", "This can incur cloud costs. Confirm workflow routing uses each size's custom labels, this session is the single writer, and any remote controller has been stopped.")) settings.automationEnabled = true;
}
async function editDraft(ctx: MenuContext, settings: RunnerSettings, id: Extract<SettingsScreenAction["id"], "organization" | "repositories" | "runner-group" | "sizes" | "standby">): Promise<void> {
  if (id === "organization") {
    const value = await ctx.ui.input("GitHub organization name", settings.organization?.name ?? "");
    if (value !== undefined) updateOrganization(settings, { name: value.trim().toLowerCase() });
  } else if (id === "repositories") {
    const value = await ctx.ui.input("Allowed organization repositories (comma separated owner/repo)", settings.organization?.repositories.join(", ") ?? "");
    if (value !== undefined) updateOrganization(settings, { repositories: parseList(value) });
  } else if (id === "runner-group") {
    const name = await ctx.ui.input("GitHub runner group name", settings.organization?.runnerGroupName ?? "");
    if (name !== undefined) {
      const value = await ctx.ui.input("GitHub runner group ID", String(settings.organization?.runnerGroupId ?? ""));
      if (value !== undefined) updateOrganization(settings, { runnerGroupName: name.trim(), runnerGroupId: Number(value) });
    }
  } else if (id === "sizes") {
    if (!ctx.ui.editor) { notice(ctx, "This Pi version does not provide the structured editor", "error"); return; }
    const text = await ctx.ui.editor("Runner size mappings (JSON; custom routing labels required)", JSON.stringify(settings.sizes.length ? settings.sizes : sizeTemplate, null, 2));
    if (text !== undefined) {
      try { settings.sizes = parseRunnerSizes(JSON.parse(text)); }
      catch (error) { notice(ctx, error instanceof Error ? error.message : "Runner sizes must be valid JSON", "error"); }
    }
  } else {
    const value = await ctx.ui.input("Idle standby minutes (1-1440)", String(settings.standbyMinutes));
    if (value !== undefined) settings.standbyMinutes = Number(value);
  }
}
async function saveDraft(ctx: MenuContext, binding: RepositoryBinding, settings: RunnerSettings, original: string): Promise<boolean | undefined> {
  if (JSON.stringify(settings) === original) return false;
  if (settings.reaper && !await ctx.ui.confirm("Save local settings?", "The installed remote controller will not change. Explicitly repeat /runners reaper install on the same host and scope to apply these settings; saving does not deploy automatically.")) return undefined;
  try { await saveSettings(binding.root, settings); return true; }
  catch (error) { notice(ctx, error instanceof Error ? error.message : "Could not save runner settings", "error"); return undefined; }
}

async function configureNative(ctx: MenuContext, binding: RepositoryBinding, settings: RunnerSettings, original: string): Promise<ConfigureResult> {
  let selectedId: string | undefined;
  for (;;) {
    const action = await ctx.ui.custom!<SettingsScreenAction>(async (tui, theme, _keybindings, done) => {
      const screen = new RunnerSettingsScreen(settings, original, theme, (next) => done(next));
      if (selectedId) screen.settingsList.selectItem(selectedId);
      return {
        render: (width) => screen.render(width),
        invalidate: () => screen.invalidate(),
        handleInput: (data) => { screen.handleInput(data); tui.requestRender(); },
        handleMouse: (event) => screen.handleMouse(event),
      };
    });
    selectedId = undefined;
    if (!action || action.id === "discard") return false;
    if (action.id === "guided-setup") {
      if (JSON.stringify(settings) !== original && !await ctx.ui.confirm("Discard unsaved settings?", "Guided setup opens separately. Discard this advanced-settings draft without saving?")) continue;
      return "guided-setup";
    }
    if (action.id === "save") {
      const saved = await saveDraft(ctx, binding, settings, original);
      if (saved !== undefined) return saved;
    } else if (action.id === "automation") {
      await changeAutomation(ctx, binding, settings);
    } else if (action.id === "remote") {
      notice(ctx, settings.reaper ? "The installed controller keeps its authoritative configuration. After local changes, explicitly repeat /runners reaper install for the same host and scope; uninstall first only when switching host or scope. This does not deploy automatically." : "Use /runners reaper install to configure a remote controller.", "warning");
    } else {
      await editDraft(ctx, settings, action.id);
    }
    selectedId = action.id;
  }
}

async function configureFallback(ctx: MenuContext, binding: RepositoryBinding, settings: RunnerSettings, original: string): Promise<ConfigureResult> {
  for (;;) {
    const choice = await ctx.ui.select("GitHub runner settings", [
      "Guided setup (scope, pools, quantities, infrastructure, costs)",
      `Scope: ${settings.mode === "global" ? "global organization pool" : "local repository pool"}`,
      `Organization: ${settings.organization?.name ?? "not configured"}`,
      `Allowed repositories: ${settings.organization?.repositories.join(", ") || "not configured"}`,
      `Runner group: ${settings.organization ? `${settings.organization.runnerGroupName} (#${settings.organization.runnerGroupId})` : "not configured"}`,
      `Runner sizes: ${settings.sizes.length || (settings.policies.length ? `${settings.policies.length} legacy policies` : "none")} (structured editor)`,
      `Standby expiry: ${settings.standbyMinutes} minutes`, `Start on load: ${settings.startOnLoad ? "prewarm once" : "off"}`, `Automation: ${settings.automationEnabled ? "enabled" : "disabled"}`,
      `Remote reaper: ${settings.reaper ? `installed on ${settings.reaper.sshTarget} (repeat install on this host and scope after local changes)` : "not installed (use /runners reaper install)"}`,
      "Save and close", "Cancel",
    ]);
    if (!choice || choice === "Cancel") return false;
    if (choice.startsWith("Guided setup")) {
      if (JSON.stringify(settings) !== original && !await ctx.ui.confirm("Discard unsaved settings?", "Guided setup opens separately. Discard this advanced-settings draft without saving?")) continue;
      return "guided-setup";
    }
    if (choice.startsWith("Scope:")) { const scope = await ctx.ui.select("Runner pool scope", ["local", "global"]); if (scope === "local" || scope === "global") settings.mode = scope; }
    else if (choice.startsWith("Organization:")) await editDraft(ctx, settings, "organization");
    else if (choice.startsWith("Allowed repositories:")) await editDraft(ctx, settings, "repositories");
    else if (choice.startsWith("Runner group:")) await editDraft(ctx, settings, "runner-group");
    else if (choice.startsWith("Runner sizes:")) await editDraft(ctx, settings, "sizes");
    else if (choice.startsWith("Standby expiry:")) await editDraft(ctx, settings, "standby");
    else if (choice.startsWith("Start on load:")) { const value = await ctx.ui.select("Start on load", ["off", "prewarm once then expire normally"]); if (value) settings.startOnLoad = value !== "off"; }
    else if (choice.startsWith("Automation:")) await changeAutomation(ctx, binding, settings);
    else if (choice.startsWith("Remote reaper:")) notice(ctx, settings.reaper ? "The installed controller keeps its authoritative configuration. After local changes, explicitly repeat /runners reaper install for the same host and scope; uninstall first only when switching host or scope. This does not deploy automatically." : "Use /runners reaper install to configure a remote controller.", "warning");
    else if (choice === "Save and close") { const saved = await saveDraft(ctx, binding, settings, original); if (saved !== undefined) return saved; }
  }
}

export async function configureRunners(ctx: MenuContext, binding: RepositoryBinding, options: ConfigureRunnersOptions = {}): Promise<boolean> {
  if (!ctx.hasUI) { notice(ctx, "Runner settings require an interactive TUI", "warning"); return false; }
  let settings: RunnerSettings;
  try { settings = clone(await loadSettings(binding.root)); }
  catch (error) { notice(ctx, error instanceof Error ? error.message : "Could not load runner settings", "error"); return false; }
  const original = JSON.stringify(settings);
  const result = await (ctx.mode === "tui" && ctx.ui.custom ? configureNative(ctx, binding, settings, original) : configureFallback(ctx, binding, settings, original));
  return result === "guided-setup" ? await options.onGuidedSetup?.() ?? false : result;
}
