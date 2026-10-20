import type { RepositoryBinding } from "./repository.js";
import { automationErrors, loadSettings, saveSettings, type RunnerSettings } from "./settings.js";

type MenuContext = {
  hasUI?: boolean;
  ui: {
    select(title: string, options: string[]): Promise<string | undefined>;
    input(title: string, initial?: string): Promise<string | undefined>;
    editor?(title: string, initial: string): Promise<string | undefined>;
    confirm(title: string, detail?: string): Promise<boolean>;
    notify?(message: string, type?: "info" | "warning" | "error"): void;
  };
};

const sizeTemplate = [{
  name: "small-linux", labels: ["pi-runner-small"], quantity: 0,
  serverType: "cpx21", location: "fsn1", image: "ubuntu-24.04", firewallId: "",
  runnerVersion: "2.x", runnerArchiveSha256: "REPLACE_WITH_PINNED_SHA256",
  maxHourlyCostEur: 0, maxEligibilityCostEur: 0,
}];

function notice(ctx: MenuContext, message: string, type: "info" | "warning" | "error" = "info"): void { ctx.ui.notify?.(message, type); }
function clone(settings: RunnerSettings): RunnerSettings { return JSON.parse(JSON.stringify(settings)) as RunnerSettings; }
function parseList(value: string): string[] { return [...new Set(value.split(/[,\n]/).map((item) => item.trim().toLowerCase()).filter(Boolean))].sort((left, right) => left.localeCompare(right)); }

export async function configureRunners(ctx: MenuContext, binding: RepositoryBinding): Promise<boolean> {
  if (!ctx.hasUI) { notice(ctx, "Runner settings require an interactive TUI", "warning"); return false; }
  let settings: RunnerSettings;
  try { settings = clone(await loadSettings(binding.root)); }
  catch (error) {
    notice(ctx, error instanceof Error ? error.message : "Could not load runner settings", "error");
    return false;
  }
  const original = JSON.stringify(settings);
  for (;;) {
    const choice = await ctx.ui.select("GitHub runner settings", [
      `Scope: ${settings.mode === "global" ? "global organization pool" : "local repository pool"}`,
      `Organization: ${settings.organization?.name ?? "not configured"}`,
      `Allowed repositories: ${settings.organization?.repositories.join(", ") || "not configured"}`,
      `Runner group: ${settings.organization ? `${settings.organization.runnerGroupName} (#${settings.organization.runnerGroupId})` : "not configured"}`,
      `Runner sizes: ${settings.sizes.length || "none"} (structured editor)`,
      `Standby expiry: ${settings.standbyMinutes} minutes`,
      `Start on load: ${settings.startOnLoad ? "prewarm once" : "off"}`,
      `Automation: ${settings.automationEnabled ? "enabled" : "disabled"}`,
      `Remote reaper: ${settings.reaper ? `installed on ${settings.reaper.sshTarget} (repeat install on this host and scope after local changes)` : "not installed (use /runners reaper install)"}`,
      "Save and close",
      "Cancel",
    ]);
    if (!choice || choice === "Cancel") return false;
    if (choice.startsWith("Scope:")) {
      const scope = await ctx.ui.select("Runner pool scope", ["local", "global"]);
      if (scope === "local" || scope === "global") settings.mode = scope;
    } else if (choice.startsWith("Organization:")) {
      const value = await ctx.ui.input("GitHub organization name", settings.organization?.name ?? "");
      if (value !== undefined) settings.organization = { name: value.trim().toLowerCase(), repositories: settings.organization?.repositories ?? [], runnerGroupId: settings.organization?.runnerGroupId ?? 0, runnerGroupName: settings.organization?.runnerGroupName ?? "" };
    } else if (choice.startsWith("Allowed repositories:")) {
      const value = await ctx.ui.input("Allowed organization repositories (comma separated owner/repo)", settings.organization?.repositories.join(", ") ?? "");
      if (value !== undefined) settings.organization = { name: settings.organization?.name ?? "", repositories: parseList(value), runnerGroupId: settings.organization?.runnerGroupId ?? 0, runnerGroupName: settings.organization?.runnerGroupName ?? "" };
    } else if (choice.startsWith("Runner group:")) {
      const name = await ctx.ui.input("GitHub runner group name", settings.organization?.runnerGroupName ?? "");
      if (name !== undefined) {
        const id = await ctx.ui.input("GitHub runner group ID", String(settings.organization?.runnerGroupId ?? ""));
        if (id !== undefined) settings.organization = { name: settings.organization?.name ?? "", repositories: settings.organization?.repositories ?? [], runnerGroupName: name.trim(), runnerGroupId: Number(id) };
      }
    } else if (choice.startsWith("Runner sizes:")) {
      if (!ctx.ui.editor) { notice(ctx, "This Pi version does not provide the structured editor", "error"); continue; }
      const text = await ctx.ui.editor("Runner size mappings (JSON; custom routing labels required)", JSON.stringify(settings.sizes.length ? settings.sizes : sizeTemplate, null, 2));
      if (text !== undefined) {
        try { settings.sizes = JSON.parse(text); } catch { notice(ctx, "Runner sizes must be valid JSON", "error"); }
      }
    } else if (choice.startsWith("Standby expiry:")) {
      const value = await ctx.ui.input("Idle standby minutes (1-1440)", String(settings.standbyMinutes));
      if (value !== undefined) settings.standbyMinutes = Number(value);
    } else if (choice.startsWith("Start on load:")) {
      const value = await ctx.ui.select("Start on load", ["off", "prewarm once then expire normally"]);
      if (value) settings.startOnLoad = value !== "off";
    } else if (choice.startsWith("Automation:")) {
      if (settings.automationEnabled) settings.automationEnabled = false;
      else {
        const errors = automationErrors(settings);
        if (errors.length) { notice(ctx, `Cannot enable automation:\n${errors.join("\n")}`, "error"); continue; }
        const confirmed = await ctx.ui.confirm("Enable runner automation?", "This can incur cloud costs. Confirm workflow routing uses each size's custom labels, this session is the single writer, and any remote controller has been stopped. RUNNER_MANAGER_ALLOW_MUTATIONS is never created for you.");
        if (confirmed) settings.automationEnabled = true;
      }
    } else if (choice.startsWith("Remote reaper:")) {
      notice(ctx, settings.reaper ? "The installed controller keeps its authoritative configuration. After local changes, explicitly repeat /runners reaper install for the same host and scope; uninstall first only when switching host or scope. This does not deploy automatically." : "Use /runners reaper install to configure a remote controller.", "warning");
    } else if (choice === "Save and close") {
      if (settings.reaper && JSON.stringify(settings) !== original && !await ctx.ui.confirm("Save local settings?", "The installed remote controller will not change. Explicitly repeat /runners reaper install on the same host and scope to apply these settings; saving does not deploy automatically.")) continue;
      try { await saveSettings(binding.root, settings); }
      catch (error) { notice(ctx, error instanceof Error ? error.message : "Could not save runner settings", "error"); continue; }
      return JSON.stringify(settings) !== original;
    }
  }
}
