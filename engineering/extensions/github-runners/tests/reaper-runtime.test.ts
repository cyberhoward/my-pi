import { chmod, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RunnerAutomation } from "../automation.js";
import { executeReaper, parsePrivateEnvironment, parseReaperConfig, parseReaperRequest, serveReaper } from "../reaper-runtime.js";
import { validPolicyYaml } from "../src/test/policy-fixtures.js";

const settings = { mode: "local", policies: [], pollIntervalSeconds: 5, standbyMinutes: 1, startOnLoad: false, automationEnabled: false, sizes: [] };
const config = { version: 1, binding: { root: ".", repository: "owner/repo" }, settings };

async function configFile(value: unknown): Promise<{ directory: string; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), "reaper-runtime-"));
  const path = join(directory, "config.json");
  await writeFile(path, JSON.stringify(value));
  return { directory, path };
}

describe("reaper runtime", () => {
  it("rejects injected config and request fields", () => {
    expect(() => parseReaperConfig({ ...config, command: "rm" }, "/installed/config.json")).toThrow("unknown");
    expect(() => parseReaperRequest({ operation: "status", config: "/tmp/x" })).toThrow("unknown");
    expect(() => parseReaperRequest({ operation: "ensure", apply: true })).toThrow("expectedPlanFingerprint");
    expect(() => parseReaperRequest({ operation: "destroy", instance: "00000000-0000-4000-8000-000000000000", apply: true, expectedPlanFingerprint: "0".repeat(64), policy: "x", command: "whoami" })).toThrow("unknown");
  });
  it("only passes stored policy paths and binds fingerprints", async () => {
    const { path } = await configFile(config);
    const runCli = vi.fn(async (argv: string[], _env: NodeJS.ProcessEnv, io: { stdout(value: string): void }, _fetch: typeof fetch, options: { expectedPlanFingerprint?: string }) => { io.stdout(JSON.stringify({ argv })); expect(options.expectedPlanFingerprint).toBe("a".repeat(64)); return 0; });
    const result = await executeReaper(path, parseReaperRequest({ operation: "ensure", policy: "stored", capacity: 1, apply: true, expectedPlanFingerprint: "a".repeat(64) }), {}, { runCli: runCli as never, materialize: async () => ({ policies: [{ name: "stored", path: "/trusted/policy.yaml", sourcePath: "/trusted/policy.yaml" }], cleanup: async () => undefined }) });
    expect(result.code).toBe(0);
    expect(runCli.mock.calls[0][0]).toEqual(["ensure", "--config", "/trusted/policy.yaml", "--json", "--capacity", "1", "--apply"]);
  });
  it("reads only private literal environment files without leaking values", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reaper-env-"));
    const file = join(directory, "env");
    await writeFile(file, "TOKEN=$literal\nEMPTY=\n# ignored\n", { mode: 0o600 });
    await expect(parsePrivateEnvironment(file)).resolves.toEqual({ TOKEN: "$literal", EMPTY: "" });
    await chmod(file, 0o644);
    await expect(parsePrivateEnvironment(file)).rejects.toThrow("private regular");
    await chmod(file, 0o640);
    await expect(parsePrivateEnvironment(file)).rejects.toThrow("private regular");
    await chmod(file, 0o600);
    const linked = join(directory, "linked"); await symlink(file, linked);
    await expect(parsePrivateEnvironment(linked)).rejects.toThrow("cannot be read safely");
  });
  it("rejects embedded policies outside the configured scope before automation", async () => {
    const { path } = await configFile({ ...config, policies: [{ name: "badscope", yaml: validPolicyYaml((policy) => { policy.spec.github.repository = "other/repo"; }) }] });
    const automation = vi.fn();
    await expect(serveReaper(path, { automation: automation as never }, { on: () => undefined, off: () => undefined, setInterval: (() => 1) as never, clearInterval: () => undefined })).rejects.toThrow("active repository");
    expect(automation).not.toHaveBeenCalled();
  });
  it("prewarms once without scheduling and persists only successful prewarms", async () => {
    const { directory, path } = await configFile({ ...config, settings: { ...settings, startOnLoad: true } });
    const tick = vi.fn(async () => undefined); const stop = vi.fn();
    await executeReaper(path, parseReaperRequest({ operation: "startup" }), {}, { automation: () => ({ tick, stop }) });
    expect(tick).toHaveBeenCalledWith(true); expect(stop).toHaveBeenCalledOnce();
    let floor: (() => Promise<Date | undefined>) | undefined; const daemonStop = vi.fn(); const start = vi.fn();
    const shutdown = await serveReaper(path, { automation: (_binding, _settings, _status, hooks) => { floor = hooks.activityFloor; return { start, tick: async () => undefined, stop: daemonStop }; } }, { on: () => undefined, off: () => undefined, setInterval: (() => 1) as never, clearInterval: () => undefined });
    expect(await floor!()).toBeUndefined(); expect(start).toHaveBeenCalledOnce(); await shutdown(); expect(daemonStop).toHaveBeenCalledOnce();
    await writeFile(join(directory, ".prewarm.json"), JSON.stringify({ at: Date.now() }));
    const second = await serveReaper(path, { automation: (_binding, _settings, _status, hooks) => { floor = hooks.activityFloor; return { tick: async () => undefined, stop: async () => undefined }; } }, { on: () => undefined, off: () => undefined, setInterval: (() => 1) as never, clearInterval: () => undefined });
    expect(await floor!()).toBeInstanceOf(Date); await second();
  });
  it("serves embedded policies through RunnerAutomation with supplied credentials", async () => {
    const { path } = await configFile({
      ...config,
      settings: { ...settings, automationEnabled: true },
      policies: [{ name: "embedded", yaml: validPolicyYaml((policy) => {
        policy.spec.github.repository = "owner/repo";
        policy.spec.mutation.enabled = true;
        policy.spec.runner.version = "2.321.0";
        policy.spec.runner.archiveSha256 = "a".repeat(64);
        policy.spec.hetzner.serverType = "cx23";
        policy.spec.hetzner.location = "fsn1";
        policy.spec.hetzner.firewallId = "1";
      }) }],
    });
    const runCli = vi.fn(async (_args: string[], env: NodeJS.ProcessEnv, io: { stdout(value: string): void }) => {
      expect(env.HCLOUD_TOKEN).toBe("hcloud-from-file");
      expect(env.RUNNER_MANAGER_GITHUB_TOKEN).toBe("github-from-file");
      io.stdout(JSON.stringify({ plan: { desiredCapacity: 1, operations: [], warnings: [] } }));
      return 0;
    });
    const materialize = vi.fn();
    const activity = vi.fn(async () => ({ kind: "active" as const, lastActivity: new Date() }));
    const shutdown = await serveReaper(path, {
      env: { RUNNER_MANAGER_ALLOW_MUTATIONS: "1", HCLOUD_TOKEN: "hcloud-from-file", RUNNER_MANAGER_GITHUB_TOKEN: "github-from-file" },
      automation: (binding, servedSettings, status, hooks) => new RunnerAutomation(binding, servedSettings, status as (message: string | undefined) => void, { ...hooks, runCli: runCli as never, materialize: async () => { materialize(); return { policies: [{ name: "embedded", path: servedSettings.policies[0], sourcePath: servedSettings.policies[0] }], cleanup: async () => undefined }; }, activity }),
    }, { on: () => undefined, off: () => undefined, setInterval: (() => 1) as never, clearInterval: () => undefined });
    await vi.waitFor(() => expect(runCli).toHaveBeenCalledTimes(2));
    expect(materialize).toHaveBeenCalledOnce();
    expect(runCli.mock.calls[0][0]).toContain("--config");
    await shutdown();
  });
});
