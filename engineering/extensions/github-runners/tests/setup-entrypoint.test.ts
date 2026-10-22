import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ detected: 0, monitors: 0, setupSaved: false, choices: [] as string[] }));

vi.mock("../repository.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../repository.js")>(),
  detectRepository: async () => { state.detected++; return { root: "/repo", repository: "acme/widgets" }; },
}));
vi.mock("../setup.js", () => ({ setupRunners: vi.fn(async () => state.setupSaved) }));
vi.mock("../setup-services.js", () => ({ createSetupServices: vi.fn(() => ({})) }));
vi.mock("../settings.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../settings.js")>(),
  loadSettings: async () => ({ mode: "local", policies: [], pollIntervalSeconds: 60, standbyMinutes: 15, startOnLoad: false, automationEnabled: false, sizes: [], sourcePath: "/repo/.pi/github-runners.json" }),
}));
vi.mock("../monitor.js", () => ({
  footerText: () => "?/? runners",
  readMonitorState: async () => ({ kind: "unknown", error: "not refreshed" }),
  RunnerMonitor: class { constructor() { state.monitors++; } start() {} stop() {} refreshNow() {} },
}));
vi.mock("../automation.js", () => ({ RunnerAutomation: class { start() {} async stop() {} } }));

import register from "../index.js";

type Handler = (input: string, ctx: any) => Promise<void>;

function command(): Handler {
  let handler: Handler | undefined;
  register({
    on: () => undefined,
    registerCommand: (_name: string, command: { handler: Handler }) => { handler = command.handler; },
  } as never);
  return handler!;
}

function context() {
  return {
    cwd: "/repo", mode: "tui", hasUI: true,
    ui: {
      select: async (_title: string, choices: string[]) => { state.choices = choices; return undefined; },
      notify: () => undefined,
      setStatus: () => undefined,
    },
  };
}

beforeEach(() => {
  state.detected = 0;
  state.monitors = 0;
  state.setupSaved = false;
  state.choices = [];
});

describe("guided setup command entrypoint", () => {
  it("puts setup first in the no-argument menu without binding", async () => {
    await command()("", context());
    expect(state.choices[0]).toBe("setup");
    expect(state.detected).toBe(0);
    expect(state.monitors).toBe(0);
  });

  it("opens setup before binding and leaves cancellation without a rebind", async () => {
    await command()("setup", context());
    expect(state.detected).toBe(1);
    expect(state.monitors).toBe(0);
  });

  it("rebinds only after guided setup saves", async () => {
    state.setupSaved = true;
    await command()("setup", context());
    expect(state.detected).toBe(2);
    expect(state.monitors).toBe(1);
  });
});
