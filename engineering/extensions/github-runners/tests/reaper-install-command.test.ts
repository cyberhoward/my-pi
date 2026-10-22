import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  detectRepository: vi.fn(),
  loadSettings: vi.fn(),
  saveSettings: vi.fn(),
  selectSshTarget: vi.fn(),
  installReaper: vi.fn(),
  reaperInstallationId: vi.fn(() => "0123456789abcdef"),
}));

vi.mock("../repository.js", () => ({ detectRepository: mocks.detectRepository, nodeCommandRunner: vi.fn(), sameRepository: vi.fn() }));
vi.mock("../settings.js", () => ({ loadSettings: mocks.loadSettings, saveSettings: mocks.saveSettings }));
vi.mock("../ssh-hosts.js", () => ({ selectSshTarget: mocks.selectSshTarget }));
vi.mock("../remote-reaper.js", () => ({ installReaper: mocks.installReaper, reaperInstallationId: mocks.reaperInstallationId, reaperStatus: vi.fn(), requestReaper: vi.fn(), uninstallReaper: vi.fn() }));
vi.mock("../monitor.js", () => ({ footerText: vi.fn(() => "status"), readMonitorState: vi.fn(), RunnerMonitor: class { start() {} stop() {} } }));
vi.mock("../automation.js", () => ({ RunnerAutomation: class { stop = async () => {}; start() {} } }));

import extension from "../index.js";

const binding = { root: "/workspace/repo", repository: "owner/repo" };
const settings = { reaper: undefined };
const registered: { handler?: (input: string, context: any) => Promise<void> } = {};
const ui = { input: vi.fn(), confirm: vi.fn(), notify: vi.fn(), setStatus: vi.fn(), select: vi.fn() };
const context = { cwd: binding.root, mode: "tui", hasUI: true, ui };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.detectRepository.mockResolvedValue(binding);
  mocks.loadSettings.mockResolvedValue(settings);
  mocks.reaperInstallationId.mockReturnValue("0123456789abcdef");
  mocks.installReaper.mockResolvedValue({ sshTarget: "Alias_One", environmentFile: "/private.env", installationId: "0123456789abcdef" });
  extension({ on: vi.fn(), registerCommand: (_name: string, command: { handler: (input: string, context: any) => Promise<void> }) => { registered.handler = command.handler; } } as any);
});

describe("reaper install SSH selection", () => {
  it("passes the exact selected alias to the installer", async () => {
    mocks.selectSshTarget.mockResolvedValue("Alias_One");
    ui.input.mockResolvedValue("/private.env");
    ui.confirm.mockResolvedValue(true);

    await registered.handler!("reaper install", context);

    expect(mocks.installReaper).toHaveBeenCalledWith(binding, settings, { sshTarget: "Alias_One", environmentFile: "/private.env" });
  });

  it("does not install or prompt for an environment file when selection is cancelled", async () => {
    mocks.selectSshTarget.mockResolvedValue(undefined);

    await registered.handler!("reaper install", context);

    expect(ui.input).not.toHaveBeenCalled();
    expect(mocks.installReaper).not.toHaveBeenCalled();
  });
});
