import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { scopeFingerprint } from "../bulk.js";
import { validPolicyYaml } from "../src/test/policy-fixtures.js";

const state = vi.hoisted(() => ({ root: "", policies: [] as any[], settings: {} as any, core: vi.fn(), remote: vi.fn() }));
vi.mock("../repository.js", async original => ({ ...await original<any>(), detectRepository: async () => ({ root: state.root, repository: "CyberHoward/graditas" }) }));
vi.mock("../settings.js", async original => ({ ...await original<any>(), loadSettings: async () => state.settings }));
vi.mock("../policies.js", async original => ({ ...await original<any>(), materializePolicies: async () => ({ policies: state.policies, cleanup: async () => undefined }) }));
vi.mock("../src/cli.js", async original => ({ ...await original<any>(), runCli: (...args: any[]) => state.core(...args) }));
vi.mock("../remote-reaper.js", async original => ({ ...await original<any>(), requestReaper: (...args: any[]) => state.remote(...args) }));
vi.mock("../monitor.js", async original => ({ ...await original<any>(), RunnerMonitor: class { start() {} stop() {} refreshNow() {} } }));
vi.mock("../automation.js", () => ({ RunnerAutomation: class { start() {} async stop() {} } }));
import extension from "../index.js";

const preview = (name: string) => JSON.stringify({ plan: { desiredCapacity: 0, warnings: [], operations: [{ kind: "begin-drain", instance: name === "small" ? "11111111-1111-4111-8111-111111111111" : "22222222-2222-4222-8222-222222222222", reason: "destroy" }] }, targets: [{ server: `runner-${name}` }] });
function command(confirm = true) {
  let handler: any;
  extension({ on: vi.fn(), registerCommand: (_name: string, registration: any) => { handler = registration.handler; } } as never);
  const ctx = { cwd: state.root, mode: "tui", hasUI: true, ui: { setStatus: vi.fn(), notify: vi.fn(), confirm: vi.fn(async () => confirm) } };
  return { ctx, run: (input: string) => handler(input, ctx) };
}
beforeEach(async () => {
  vi.stubEnv("RUNNER_MANAGER_GITHUB_TOKEN", "test-token");
  state.core.mockReset(); state.remote.mockReset();
  state.root = await mkdtemp(join(tmpdir(), "bulk-command-")); state.policies = [];
  state.settings = { mode: "local", policies: [], sizes: [], automationEnabled: false, startOnLoad: false, pollIntervalSeconds: 60 };
  for (const name of ["small", "large"]) {
    const path = join(state.root, `${name}.yaml`);
    await writeFile(path, validPolicyYaml(policy => { policy.spec.pool.name = `linux-${name}`; }));
    state.policies.push({ name, path, sourcePath: path });
  }
  state.core.mockImplementation(async (args: string[], _env: unknown, io: { stdout(value: string): void }) => {
    const policy = parse(await readFile(args[args.indexOf("--config") + 1], "utf8"));
    io.stdout(preview(policy.spec.pool.name.endsWith("small") ? "small" : "large")); return 0;
  });
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(state.root, { recursive: true, force: true }); });

describe("/runners destroy --all", () => {
  it("previews all configured pools and binds each apply after complete confirmation", async () => {
    const { ctx, run } = command(); await run("destroy --all --apply");
    expect(state.core).toHaveBeenCalledTimes(4);
    expect(state.core.mock.calls.every(([args]) => args.includes("--all"))).toBe(true);
    const applies = state.core.mock.calls.filter(([args]) => args.includes("--apply"));
    expect(applies).toHaveLength(2);
    expect(applies[0][4].expectedPlanFingerprint).not.toBe(applies[1][4].expectedPlanFingerprint);
    expect(ctx.ui.confirm.mock.calls[0][1]).toContain("runner-small");
    expect(ctx.ui.confirm.mock.calls[0][1]).toContain("runner-large");
    expect(ctx.ui.confirm).toHaveBeenCalledTimes(2);
  });
  it("never applies on cancellation and honors --policy narrowing", async () => {
    const { run } = command(false); await run("destroy --all --policy small --apply");
    expect(state.core).toHaveBeenCalledOnce();
    expect(state.core.mock.calls[0][0]).not.toContain("--apply");
  });
  it("routes every remote pool with its own fingerprint and never falls back locally", async () => {
    state.settings.reaper = { sshTarget: "controller", installationId: "a".repeat(16), environmentFile: "/private.env" };
    const scope = "SHARED ORGANIZATION POOL: installed-org; group: original (#7); affects repositories: installed-org/actual";
    state.remote.mockImplementation(async (_installation, request) => request.apply ? { code: 0, text: preview(request.policy) } : { code: 0, text: JSON.stringify(["small", "large"].map(policy => ({ policy, code: 0, output: preview(policy), scope, scopeFingerprint: scopeFingerprint(scope) }))) });
    const { ctx, run } = command(); await run("destroy --all --apply");
    expect(ctx.ui.confirm.mock.calls[0][1]).toContain(scope);
    expect(ctx.ui.confirm.mock.calls[0][1]).not.toContain("Repository: CyberHoward/graditas");
    expect(state.core).not.toHaveBeenCalled(); expect(state.remote).toHaveBeenCalledTimes(3);
    const requests = state.remote.mock.calls.slice(1).map(([, request]) => request);
    expect(requests.map(request => request.policy)).toEqual(["small", "large"]);
    expect(requests.every(request => request.all === true && request.apply === true && request.expectedScopeFingerprint === scopeFingerprint(scope))).toBe(true);
    expect(requests[0].expectedPlanFingerprint).not.toBe(requests[1].expectedPlanFingerprint);
    state.remote.mockRejectedValue(new Error("offline")); await run("destroy --all --apply");
    expect(state.core).not.toHaveBeenCalled();
  });
});
