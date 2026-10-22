import { describe, expect, it, vi } from "vitest";
import { RunnerAutomation } from "../automation.js";
import { materializePolicies } from "../policies.js";
import type { RunnerSettings } from "../settings.js";

const settings: RunnerSettings = { mode: "local", policies: [], pollIntervalSeconds: 5, standbyMinutes: 1, startOnLoad: false, automationEnabled: true, sizes: [], sourcePath: "test" };
const binding = { root: "/repo", repository: "owner/repo" };

describe("runner automation lifecycle", () => {
  it("reports disabled automation startup without materializing policies or calling core", async () => {
    const run = vi.fn(); const materialize = vi.fn(); const status = vi.fn();
    const automation = new RunnerAutomation(binding, { ...settings, automationEnabled: false, startOnLoad: true }, status, { runCli: run as never, materialize: materialize as never });
    await automation.tick();
    expect(materialize).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(expect.stringMatching(/enable.*automation/i));
    await automation.stop();
  });
  it("reports a missing mutation gate at startup without materializing policies or calling core", async () => {
    const run = vi.fn(); const materialize = vi.fn(); const status = vi.fn();
    const automation = new RunnerAutomation(binding, { ...settings, startOnLoad: true }, status, { runCli: run as never, materialize: materialize as never, env: {} });
    await automation.tick();
    expect(materialize).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(expect.stringMatching(/RUNNER_MANAGER_ALLOW_MUTATIONS=1/));
    await automation.stop();
  });
  it("does not mutate without an explicitly materialized configured pool", async () => {
    const run = vi.fn();
    const automation = new RunnerAutomation(binding, settings, () => undefined, { runCli: run as never, materialize: async () => ({ policies: [], cleanup: async () => undefined }) });
    await automation.tick();
    expect(run).not.toHaveBeenCalled();
    automation.stop();
  });
  it("does not overlap ticks and clears scheduled work on shutdown", async () => {
    vi.useFakeTimers();
    let release!: () => void; const pending = new Promise<void>((resolve) => { release = resolve; });
    const automation = new RunnerAutomation(binding, settings, () => undefined, { materialize: async () => { await pending; return { policies: [], cleanup: async () => undefined }; } });
    const first = automation.tick(); const second = automation.tick();
    release(); await Promise.all([first, second]); automation.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    vi.useRealTimers();
  });
  it("prewarms, serves active work, and expires idle capacity from the persisted activity floor", async () => {
    let now = new Date("2025-01-10T00:00:00Z");
    let state: "idle" | "active" = "idle";
    const calls: Array<{ args: string[]; expected?: string }> = [];
    const lifecycleSettings: RunnerSettings = { ...settings, startOnLoad: true, standbyMinutes: 1, sizes: [{ name: "small", labels: ["ci-small"], quantity: 1, serverType: "cpx11", location: "fsn1", image: "ubuntu-24.04", firewallId: "1", runnerVersion: "2.321.0", runnerArchiveSha256: "a".repeat(64), maxHourlyCostEur: 1, maxEligibilityCostEur: 1 }] };
    const plan = { desiredCapacity: 1, warnings: [], operations: [] };
    const run = vi.fn(async (args: string[], _env: NodeJS.ProcessEnv, io: { stdout(value: string): void }, _fetcher: unknown, options?: { expectedPlanFingerprint?: string }) => {
      calls.push({ args, expected: options?.expectedPlanFingerprint });
      io.stdout(JSON.stringify({ plan, servers: [] }));
      return 0;
    });
    const automation = new RunnerAutomation(binding, lifecycleSettings, () => undefined, { runCli: run as never, materialize: materializePolicies, env: { RUNNER_MANAGER_ALLOW_MUTATIONS: "1", HCLOUD_TOKEN: "token", RUNNER_MANAGER_GITHUB_TOKEN: "github" }, now: () => now, activity: async () => state === "active" ? { kind: "active", lastActivity: now } : { kind: "idle", lastActivity: new Date("2025-01-01T00:00:00Z") }, activityFloor: async () => new Date("2025-01-01T00:00:00Z") });
    await automation.tick();
    state = "active"; await automation.tick();
    state = "idle"; now = new Date("2025-01-10T00:02:00Z"); await automation.tick();
    const applyCalls = calls.filter((call) => call.args.includes("--apply"));
    expect(calls.map((call) => call.args[0])).toEqual(["ensure", "ensure", "ensure", "ensure", "status", "reconcile", "reconcile"]);
    expect(applyCalls).toHaveLength(3);
    expect(applyCalls.every((call) => typeof call.expected === "string" && call.expected.length > 0)).toBe(true);
    await automation.stop();
  });
  it("refuses all writes when activity is incomplete", async () => {
    const lifecycleSettings: RunnerSettings = { ...settings, sizes: [{ name: "small", labels: ["ci-small"], quantity: 1, serverType: "cpx11", location: "fsn1", image: "ubuntu-24.04", firewallId: "1", runnerVersion: "2.321.0", runnerArchiveSha256: "a".repeat(64), maxHourlyCostEur: 1, maxEligibilityCostEur: 1 }] };
    const run = vi.fn();
    const automation = new RunnerAutomation(binding, lifecycleSettings, () => undefined, { runCli: run as never, materialize: materializePolicies, env: { RUNNER_MANAGER_ALLOW_MUTATIONS: "1", HCLOUD_TOKEN: "token", RUNNER_MANAGER_GITHUB_TOKEN: "github" }, activity: async () => ({ kind: "unknown", error: "GitHub activity pagination limit reached" }) });
    await automation.tick();
    expect(run).not.toHaveBeenCalled();
    await automation.stop();
  });
  it("waits for an in-flight apply during stop and fences later mutations", async () => {
    let release!: () => void; const held = new Promise<void>((resolve) => { release = resolve; });
    let applying!: () => void; const started = new Promise<void>((resolve) => { applying = resolve; });
    const lifecycleSettings: RunnerSettings = { ...settings, sizes: [{ name: "small", labels: ["ci-small"], quantity: 1, serverType: "cpx11", location: "fsn1", image: "ubuntu-24.04", firewallId: "1", runnerVersion: "2.321.0", runnerArchiveSha256: "a".repeat(64), maxHourlyCostEur: 1, maxEligibilityCostEur: 1 }] };
    const run = vi.fn(async (args: string[], _env: NodeJS.ProcessEnv, io: { stdout(value: string): void }) => {
      io.stdout(JSON.stringify({ plan: { desiredCapacity: 1, warnings: [], operations: [] } }));
      if (args.includes("--apply")) { applying(); await held; }
      return 0;
    });
    const automation = new RunnerAutomation(binding, lifecycleSettings, () => undefined, { runCli: run as never, materialize: materializePolicies, env: { RUNNER_MANAGER_ALLOW_MUTATIONS: "1", HCLOUD_TOKEN: "token", RUNNER_MANAGER_GITHUB_TOKEN: "github" }, activity: async () => ({ kind: "active" }) });
    const tick = automation.tick(); await started;
    let stopped = false; const stopping = automation.stop().then(() => { stopped = true; });
    await Promise.resolve(); expect(stopped).toBe(false);
    release(); await Promise.all([tick, stopping]);
    expect(run.mock.calls.filter(([args]) => (args as string[]).includes("--apply"))).toHaveLength(1);
  });
  it("does not synthesize or inherit the operator mutation gate", async () => {
    const prior = process.env.RUNNER_MANAGER_ALLOW_MUTATIONS; process.env.RUNNER_MANAGER_ALLOW_MUTATIONS = "1";
    const run = vi.fn();
    const automation = new RunnerAutomation(binding, settings, () => undefined, { env: {}, runCli: run as never, materialize: async () => ({ policies: [{ name: "configured", path: "/never-read.yaml", sourcePath: "/never-read.yaml" }], cleanup: async () => undefined }) });
    await automation.tick(); expect(run).not.toHaveBeenCalled(); automation.stop();
    if (prior === undefined) delete process.env.RUNNER_MANAGER_ALLOW_MUTATIONS; else process.env.RUNNER_MANAGER_ALLOW_MUTATIONS = prior;
  });
});
