import { DynamicBorder, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, SettingsList, Text, truncateToWidth, type SettingItem } from "@earendil-works/pi-tui";
import type { RunnerSettings } from "./settings.js";

export type SettingsScreenAction =
  | { id: "organization" | "repositories" | "runner-group" | "sizes" | "standby" | "automation" | "remote" }
  | { id: "save" | "discard" };

type ScreenTheme = { fg(token: string, text: string): string; bold(text: string): string };

function sizesSummary(settings: RunnerSettings): string {
  if (settings.sizes.length) return `${settings.sizes.length} mapping${settings.sizes.length === 1 ? "" : "s"}`;
  if (settings.policies.length) return `${settings.policies.length} legacy polic${settings.policies.length === 1 ? "y" : "ies"}`;
  return "no mappings";
}

function organization(settings: RunnerSettings): string {
  return settings.organization?.name || "not configured";
}

function repositories(settings: RunnerSettings): string {
  return settings.organization?.repositories.join(", ") || "not configured";
}

function group(settings: RunnerSettings): string {
  return settings.organization ? `${settings.organization.runnerGroupName || "not configured"} (#${settings.organization.runnerGroupId || "?"})` : "not configured";
}

export class RunnerSettingsScreen extends Container {
  readonly settingsList: SettingsList;
  private readonly title: Text;
  private readonly settings: RunnerSettings;
  private readonly original: string;
  private readonly theme: ScreenTheme;

  constructor(settings: RunnerSettings, original: string, theme: ScreenTheme, onAction: (action: SettingsScreenAction) => void) {
    super();
    this.settings = settings;
    this.original = original;
    this.theme = theme;
    const refreshTitle = () => this.refreshTitle();
    const item = (id: SettingsScreenAction["id"], label: string, currentValue: string, description: string, values = ["open"]): SettingItem => ({ id, label, currentValue, description, values });
    const items: SettingItem[] = [
      { id: "scope", label: "Scope", currentValue: settings.mode === "global" ? "global organization pool" : "local repository pool", description: "Cycle between this repository and the configured organization pool.", values: ["local repository pool", "global organization pool"] },
      item("organization", "Organization", organization(settings), "Organization name used by the global pool."),
      item("repositories", "Allowed repositories", repositories(settings), "Comma-separated organization allowlist; required for global automation."),
      item("runner-group", "Runner group", group(settings), "GitHub runner group name and numeric ID for global automation."),
      item("sizes", "Runner sizes", sizesSummary(settings), "Edit JSON mappings. Zero-quantity mappings remain valid drafts; legacy policies are shown when no mappings exist."),
      item("standby", "Standby expiry", `${settings.standbyMinutes} minutes`, "Idle standby runners expire after this many minutes."),
      { id: "start-on-load", label: "Start on load", currentValue: settings.startOnLoad ? "prewarm once" : "off", description: "Requires automation. Prewarms once when Pi loads, then runners expire normally and may incur cloud costs.", values: ["off", "prewarm once"] },
      item("automation", "Automation", settings.automationEnabled ? "enabled" : "disabled", "Enabling validates live configuration and requires a cost and sole-writer confirmation."),
      item("remote", "Remote reaper", settings.reaper ? `installed on ${settings.reaper.sshTarget}` : "not installed", "Saving does not update the remote snapshot; its installed controller keeps its current configuration until you reinstall for this host and scope."),
      item("save", "Save changes", "save", "Persist this draft. Enabled local automation can immediately create billable capacity or reconcile; the remote snapshot is not redeployed."),
      item("discard", "Discard changes", "discard", "Discard this draft without writing settings."),
    ];
    this.title = new Text("", 0, 0);
    refreshTitle();
    this.addChild(new DynamicBorder((text: string) => theme.fg("border", text)));
    this.addChild(this.title);
    this.settingsList = new SettingsList(items, Math.min(items.length, 10), getSettingsListTheme(), (id, value) => {
      if (id === "scope") {
        settings.mode = value === "global organization pool" ? "global" : "local";
        this.settingsList.updateValue("scope", value);
        refreshTitle();
        return;
      }
      if (id === "start-on-load") {
        settings.startOnLoad = value === "prewarm once";
        this.settingsList.updateValue("start-on-load", value);
        refreshTitle();
        return;
      }
      onAction({ id: id as SettingsScreenAction["id"] });
    }, () => onAction({ id: "discard" }), { enableSearch: true });
    this.addChild(this.settingsList);
    this.addChild(new DynamicBorder((text: string) => theme.fg("border", text)));
  }

  private refreshTitle(): void {
    this.title.setText(this.theme.bold(this.theme.fg("accent", `GitHub runner settings${JSON.stringify(this.settings) === this.original ? "" : " • unsaved changes"}`)));
  }

  invalidate(): void {
    this.refreshTitle();
    super.invalidate();
  }

  render(width: number): string[] {
    this.refreshTitle();
    return super.render(Math.max(width, 12)).map((line) => truncateToWidth(line, width));
  }

  handleInput(data: string): void {
    this.settingsList.handleInput(data);
  }
}
