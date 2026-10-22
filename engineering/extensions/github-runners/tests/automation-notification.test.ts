import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ status: undefined as ((message: string | undefined) => void) | undefined }));
vi.mock("../repository.js", async original => ({ ...await original<any>(), detectRepository: async () => ({ root: "/repo", repository: "acme/widgets" }) }));
vi.mock("../settings.js", async original => ({ ...await original<any>(), loadSettings: async () => ({ mode: "local", policies: [], sizes: [], automationEnabled: false, startOnLoad: true, pollIntervalSeconds: 60, standbyMinutes: 15, sourcePath: "test" }) }));
vi.mock("../monitor.js", async original => ({ ...await original<any>(), RunnerMonitor: class { start() {} stop() {} refreshNow() {} } }));
vi.mock("../automation.js", () => ({ RunnerAutomation: class { constructor(_binding: unknown, _settings: unknown, status: (message: string | undefined) => void) { state.status = status; } start() {} async stop() {} } }));
import extension from "../index.js";

describe("automation notifications", () => {
  it("deduplicates each policy warning until recovery", async () => {
    let start: ((event: unknown, ctx: any) => Promise<void>) | undefined;
    extension({ on: (event: string, handler: any) => { if (event === "session_start") start = handler; }, registerCommand: vi.fn() } as never);
    const ctx = { cwd: "/repo", mode: "tui", hasUI: true, ui: { setStatus: vi.fn(), notify: vi.fn(), select: vi.fn(), input: vi.fn(), confirm: vi.fn() } };
    await start!({}, ctx);
    const first = "runner automation startup is blocked: enable Automation in /runners settings";
    const second = "runner automation startup is blocked: provision a runner size";
    state.status!(first);
    state.status!(second);
    state.status!(first);
    state.status!(second);
    state.status!(undefined);
    state.status!(first);
    expect(ctx.ui.notify).toHaveBeenCalledTimes(4);
    expect(ctx.ui.notify.mock.calls).toEqual([
      [first, "warning"],
      [second, "warning"],
      ["GitHub runner automation recovered", "info"],
      [first, "warning"],
    ]);
  });
});
