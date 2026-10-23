import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ detected: 0, monitors: 0, setupSaved: false, choices: [] as string[], setupOptions: [] as Array<{ fresh?: boolean } | undefined> }));

vi.mock("../repository.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../repository.js")>(),
  detectRepository: async () => { state.detected++; return { root: "/repo", repository: "acme/widgets" }; },
}));
vi.mock("../setup.js", () => ({ setupRunners: vi.fn(async (_ctx, _binding, _services, options) => { state.setupOptions.push(options); return state.setupSaved; }) }));
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

import register, { parseRunnerCommand } from "../index.js";

type Handler = (input: string, ctx: any) => Promise<void>;

function registered(): { handler: Handler; getArgumentCompletions: (prefix: string) => Array<{ value: string; label: string; description?: string }> | null } {
  let command: { handler: Handler; getArgumentCompletions: (prefix: string) => Array<{ value: string; label: string; description?: string }> | null } | undefined;
  register({
    on: () => undefined,
    registerCommand: (_name: string, next) => { command = next as typeof command; },
  } as never);
  return command!;
}

function command(): Handler { return registered().handler; }

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
  state.setupOptions = [];
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
    expect(state.setupOptions).toEqual([undefined]);
  });

  it("puts reset beside setup, passes fresh only to reset, and rebinds only after reset saves", async () => {
    await command()("", context());
    expect(state.choices.slice(0, 2)).toEqual(["setup", "reset"]);
    await command()("reset", context());
    expect(state.detected).toBe(1);
    expect(state.monitors).toBe(0);
    expect(state.setupOptions).toEqual([{ fresh: true }]);
    state.setupSaved = true;
    await command()("reset", context());
    expect(state.detected).toBe(3);
    expect(state.monitors).toBe(1);
  });

  it("advertises every routable command and no unsupported core literal", () => {
    const completions = registered().getArgumentCompletions;
    const expected = [
      { value: "setup", label: "setup", description: "Guided configuration setup" },
      { value: "reset", label: "reset", description: "Fresh guided setup; saves only after review" },
      { value: "settings", label: "settings", description: "Edit runner settings" },
      { value: "status", label: "status", description: "Show runner status" },
      { value: "refresh", label: "refresh", description: "Refresh runner status" },
      { value: "ensure", label: "ensure", description: "Plan or apply runner capacity" },
      { value: "reconcile", label: "reconcile", description: "Plan or apply reconciliation" },
      { value: "drain", label: "drain", description: "Plan or apply runner drain" },
      { value: "destroy", label: "destroy", description: "Plan or apply runner destruction" },
      { value: "destroy --all", label: "destroy --all", description: "Plan or apply destruction of all managed runners" },
      { value: "reaper install", label: "reaper install", description: "Install remote controller" },
      { value: "reaper status", label: "reaper status", description: "Show remote controller status" },
      { value: "reaper uninstall", label: "reaper uninstall", description: "Uninstall remote controller" },
    ];
    expect(completions("")).toEqual(expected);
    expect(completions("core")).toBeNull();
    expect(completions("res")).toEqual([expected[1]]);
    expect(completions("reaper sta")).toEqual([expected[11]]);
    for (const value of ["status", "refresh", "ensure", "reconcile", "drain --instance runner", "destroy --instance runner", "destroy --all"]) {
      expect(parseRunnerCommand(value).operation).toBe(value.split(" ")[0]);
    }
    expect(expected.filter(({ value }) => value.startsWith("reaper ")).map(({ value }) => value)).toEqual(["reaper install", "reaper status", "reaper uninstall"]);
    expect(completions("missing")).toBeNull();
  });

  it("rebinds only after guided setup saves", async () => {
    state.setupSaved = true;
    await command()("setup", context());
    expect(state.detected).toBe(2);
    expect(state.monitors).toBe(1);
  });
});
