import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Input, Key, matchesKey, SelectList, Text, truncateToWidth, type Focusable, type SelectItem } from "@earendil-works/pi-tui";

export interface RunnerMenuOption {
  value: string;
  label: string;
  description: string;
}

export const RUNNER_MENU_OPTIONS: readonly RunnerMenuOption[] = [
  { value: "setup", label: "Set up runners", description: "Setup & settings · Guided pool setup: scope, Small/Medium/Large drafts, and safeguards" },
  { value: "reset", label: "Start fresh draft", description: "Setup & settings · Reset a disabled draft after review; does not delete existing runners" },
  { value: "settings", label: "Edit settings", description: "Setup & settings · Review pools, use guided presets, or open advanced JSON" },
  { value: "status", label: "View status", description: "Observe · Read the current GitHub runner inventory" },
  { value: "refresh", label: "Refresh status", description: "Observe · Read-only monitoring refresh" },
  { value: "ensure", label: "Plan capacity", description: "Manage safely · Plan a bounded desired capacity" },
  { value: "reconcile", label: "Plan reconcile", description: "Manage safely · Plan the configured pool policy" },
  { value: "drain", label: "Plan drain", description: "Manage safely · Plan one runner drain after entering its instance ID" },
  { value: "destroy", label: "Plan destroy", description: "Manage safely · Plan one runner deletion after entering its instance ID" },
  { value: "destroy --all", label: "Plan destroy all", description: "Manage safely · Plan every configured managed runner" },
  { value: "reaper install", label: "Install reaper", description: "Remote controller · Set up the remote controller with explicit confirmation" },
  { value: "reaper status", label: "Reaper status", description: "Remote controller · Check the installed remote controller" },
  { value: "reaper uninstall", label: "Uninstall reaper", description: "Remote controller · Remove the service; does not delete runner VMs" },
] as const;

export function runnerMenuFallbackOptions(): string[] {
  return RUNNER_MENU_OPTIONS.map(option => `${option.label} — ${option.description}`);
}

export function runnerMenuValue(selection: string | undefined): string | undefined {
  return RUNNER_MENU_OPTIONS.find(option => selection === option.value || selection === `${option.label} — ${option.description}`)?.value;
}

type ScreenTheme = { fg(token: string, text: string): string; bold(text: string): string };

export class RunnerMenuScreen extends Container implements Focusable {
  private readonly input: Input;
  private _focused = false;
  private readonly listHost = new Container();
  private list: SelectList;
  private readonly onSelect: (value: string) => void;
  private readonly onCancel: () => void;
  private readonly theme: ScreenTheme;

  constructor(onSelect: (value: string) => void, onCancel: () => void, theme: ScreenTheme) {
    super();
    this.onSelect = onSelect;
    this.onCancel = onCancel;
    this.theme = theme;
    this.input = new Input({ prompt: "Search: ", placeholder: "actions and descriptions" });
    this.list = this.createList(RUNNER_MENU_OPTIONS);
    this.addChild(new DynamicBorder(text => theme.fg("border", text)));
    this.addChild(new Text(theme.bold(theme.fg("accent", "GitHub Actions runners")), 0, 0));
    this.addChild(new Text(theme.fg("muted", "Setup & settings • Observe • Manage safely • Remote controller"), 0, 0));
    this.addChild(this.input);
    this.listHost.addChild(this.list);
    this.addChild(this.listHost);
    this.addChild(new Text(theme.fg("dim", "type to search • ↑↓ navigate • Enter choose • Esc cancel"), 0, 0));
    this.addChild(new DynamicBorder(text => theme.fg("border", text)));
  }

  private createList(options: readonly RunnerMenuOption[]): SelectList {
    const items: SelectItem[] = options.map(option => ({ value: option.value, label: option.label, description: option.description }));
    const list = new SelectList(items, Math.min(items.length, 10), {
      selectedPrefix: text => this.theme.fg("accent", text), selectedText: text => this.theme.fg("accent", text),
      description: text => this.theme.fg("muted", text), scrollInfo: text => this.theme.fg("dim", text), noMatch: text => this.theme.fg("warning", text),
    });
    list.onSelect = item => this.onSelect(item.value);
    list.onCancel = this.onCancel;
    return list;
  }

  private filter(): void {
    const query = this.input.getValue().toLowerCase();
    const options = RUNNER_MENU_OPTIONS.filter(option => `${option.label} ${option.description} ${option.value}`.toLowerCase().includes(query));
    this.listHost.removeChild(this.list);
    this.list = this.createList(options);
    this.listHost.addChild(this.list);
  }

  get focused(): boolean { return this._focused; }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  render(width: number): string[] { return super.render(Math.max(width, 12)).map(line => truncateToWidth(line, width)); }

  handleInput(data: string): void {
    if (matchesKey(data, Key.up) || matchesKey(data, Key.down) || matchesKey(data, Key.enter) || matchesKey(data, Key.escape)) {
      this.list.handleInput(data);
      return;
    }
    this.input.handleInput(data);
    this.filter();
  }
}
