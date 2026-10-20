import { writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { occupiedSlotsForPool, orderOperations, planFingerprint, runCli } from "../cli.js";
import { configHash, runnerName } from "../identity.js";
import { loadPolicyText } from "../policy-schema.js";
import { validPolicyYaml } from "./policy-fixtures.js";

const response = (body: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: status === 204 ? {} : { "content-type": "application/json" },
  });
function offlineFetch() {
  return vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url === "https://api.github.com/repos/CyberHoward/graditas")
      return response({ id: 123456, full_name: "CyberHoward/graditas" });
    if (url.includes("api.hetzner.cloud/v1/servers?"))
      return response({
        servers: [],
        meta: { pagination: { next_page: null } },
      });
    if (url.includes("/actions/runners?")) return response({ runners: [] });
    if (url.includes("/actions/runs?")) return response({ workflow_runs: [] });
    throw new Error(`unexpected URL ${url}`);
  });
}
function io() {
  return { stdout: vi.fn(), stderr: vi.fn() };
}
const testPolicyPath = join(tmpdir(), `github-runners-${process.pid}.policy.yaml`);
writeFileSync(testPolicyPath, validPolicyYaml());
const committedConfig = loadPolicyText(validPolicyYaml()).config;
const committedHash = configHash(committedConfig);
const env = {
  HCLOUD_TOKEN: "h-secret",
  RUNNER_MANAGER_GITHUB_TOKEN: "g-secret",
};
it("fingerprints the complete plan independent of operation ordering", () => {
  const first = { desiredCapacity: 1, warnings: ["warning"], operations: [{ kind: "ensure-slot", slot: 0, reason: "need" }, { kind: "begin-drain", instance: "a", destructive: true, reason: "old" }] };
  expect(planFingerprint(first)).toBe(planFingerprint({ ...first, operations: [...first.operations].reverse() }));
  expect(planFingerprint(first)).not.toBe(planFingerprint({ ...first, desiredCapacity: 2 }));
});
it("supports offline help without credentials", async () => {
  const output = io();
  expect(await runCli(["--help"], {}, output)).toBe(0);
  expect(output.stdout).toHaveBeenCalledWith(expect.stringContaining("Usage"));
});
it("refuses an apply when the confirmation fingerprint changed under the lock", async () => {
  const path = join(tmpdir(), `github-runners-binding-${process.pid}.policy.yaml`);
  writeFileSync(path, validPolicyYaml((policy) => {
    policy.spec.mutation.enabled = true;
    policy.spec.hetzner.serverType = "cx23";
    policy.spec.hetzner.location = "fsn1";
    policy.spec.hetzner.firewallId = "1";
    policy.spec.runner.version = "2.999.0";
    policy.spec.runner.archiveSha256 = "a".repeat(64);
  }));
  const output = io();
  expect(await runCli(["reconcile", "--apply", "--config", path], { ...env, RUNNER_MANAGER_ALLOW_MUTATIONS: "1" }, output, offlineFetch() as typeof fetch, { expectedPlanFingerprint: "stale" })).toBe(3);
  expect(output.stderr.mock.calls[0][0]).toContain("plan changed since confirmation");
});
it("maps usage and credential refusals", async () => {
  expect(await runCli(["wat"], {}, io())).toBe(2);
  expect(await runCli(["status", "--config", testPolicyPath], {}, io())).toBe(3);
});
it.each([
  "list",
  "status",
  "ensure",
  "reconcile",
])("executes %s as stable redacted dry-run JSON", async (command) => {
  const output = io();
  expect(
    await runCli([command, "--config", testPolicyPath], env, output, offlineFetch() as typeof fetch),
  ).toBe(0);
  const serialized = output.stdout.mock.calls[0][0];
  expect(() => JSON.parse(serialized)).not.toThrow();
  expect(serialized).not.toContain("h-secret");
  expect(serialized).not.toContain("g-secret");
});
it.each([
  "drain",
  "destroy",
])("requires immutable identity for %s", async (command) => {
  expect(
    await runCli([command, "--config", testPolicyPath], env, io(), offlineFetch() as typeof fetch),
  ).toBe(2);
});
it("requires the environment mutation gate before any apply inventory call", async () => {
  const fetcher = offlineFetch();
  expect(
    await runCli(["reconcile", "--apply", "--config", testPolicyPath], env, io(), fetcher as typeof fetch),
  ).toBe(3);
  expect(fetcher).not.toHaveBeenCalled();
});
function inventoryFetch(options: { state?: string; busy?: boolean } = {}) {
  const instance = "11111111-1111-4111-8111-111111111111";
  const expectedRunnerName = runnerName(
    "123456",
    committedConfig.pool.name,
    0,
    instance,
  );
  return vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url === "https://api.github.com/repos/CyberHoward/graditas")
      return response({ id: 123456, full_name: "CyberHoward/graditas" });
    if (url.includes("api.hetzner.cloud/v1/servers?"))
      return response({
        servers: [
          {
            id: 1,
            name: `tau-mg-123456-${committedConfig.pool.name}-0`,
            created: "2026-01-01T00:00:00Z",
            status: "running",
            protection: { delete: true, rebuild: true },
            labels: {
              "tau-managed": "my-gratitude-runner-v1",
              "tau-tier": committedConfig.tier.id,
              environment: "ci",
              workload: "github-actions",
              "data-classification": "internal",
              "tau-repo-id": "123456",
              "tau-pool": committedConfig.pool.name,
              "tau-slot": "0",
              "tau-instance": instance,
              "tau-state": options.state ?? "ready",
              ...(options.state === "draining"
                ? { "tau-drain-since": "1" }
                : {}),
              "tau-runner-name": expectedRunnerName,
              "tau-config": committedHash,
            },
          },
        ],
        meta: { pagination: { next_page: null } },
      });
    if (url.includes("/actions/runners?"))
      return response({
        runners: [
          {
            id: 2,
            name: expectedRunnerName,
            busy: options.busy ?? false,
            status: "online",
            labels: [
              { name: "self-hosted" },
              { name: "Linux" },
              { name: "X64" },
              { name: "tau-managed" },
              ...committedConfig.pool.routingLabels.map((name) => ({ name })),
              { name: `tau-instance-${instance}` },
            ],
          },
        ],
      });
    if (url.includes("/actions/runs?")) return response({ workflow_runs: [] });
    throw new Error(`unexpected URL ${url}`);
  });
}
it("ensure is create/repair-only even when reconcile wants lifecycle cleanup", async () => {
  const output = io();
  expect(
    await runCli(["ensure", "--config", testPolicyPath], env, output, inventoryFetch() as typeof fetch),
  ).toBe(0);
  const kinds = JSON.parse(output.stdout.mock.calls[0][0]).plan.operations.map(
    (operation: any) => operation.kind,
  );
  expect(kinds).not.toContain("begin-drain");
  expect(kinds).not.toContain("unregister");
  expect(kinds).not.toContain("probe-drain");
});
it("scopes explicit ensure slot occupancy to the selected pool", () => {
  const server = (pool: string, slot: string) =>
    ({ labels: { "tau-pool": pool, "tau-slot": slot } }) as never;
  expect([
    ...occupiedSlotsForPool(
      [server("linux-x64-small", "0"), server("linux-x64-large", "0")],
      "linux-x64-large",
    ),
  ]).toEqual([0]);
  expect([
    ...occupiedSlotsForPool(
      [server("linux-x64-small", "0")],
      "linux-x64-large",
    ),
  ]).toEqual([]);
});
it("destroy first tick plans drain and a later tick plans probe", async () => {
  const instance = "11111111-1111-4111-8111-111111111111";
  const first = io();
  expect(
    await runCli(
      ["destroy", "--instance", instance, "--config", testPolicyPath],
      env,
      first,
      inventoryFetch({ state: "ready" }) as typeof fetch,
    ),
  ).toBe(0);
  expect(
    JSON.parse(first.stdout.mock.calls[0][0]).plan.operations[0].kind,
  ).toBe("begin-drain");
  const later = io();
  expect(
    await runCli(
      ["destroy", "--instance", instance, "--config", testPolicyPath],
      env,
      later,
      inventoryFetch({ state: "draining" }) as typeof fetch,
    ),
  ).toBe(0);
  expect(
    JSON.parse(later.stdout.mock.calls[0][0]).plan.operations[0].kind,
  ).toBe("probe-drain");
});
it("returns usage 2 for out-of-range capacity", async () => {
  expect(
    await runCli(
      ["ensure", "--capacity", "4", "--config", testPolicyPath],
      env,
      io(),
      offlineFetch() as typeof fetch,
    ),
  ).toBe(2);
});
it("returns operator warning exit 5 for a busy over-age runner", async () => {
  expect(
    await runCli(
      ["reconcile", "--config", testPolicyPath],
      env,
      io(),
      inventoryFetch({ busy: true }) as typeof fetch,
    ),
  ).toBe(5);
});
it.each([
  ["status", "--apply"],
  ["status", "--capacity", "1"],
  ["list", "--instance", "11111111-1111-4111-8111-111111111111"],
  [
    "destroy",
    "--instance",
    "11111111-1111-4111-8111-111111111111",
    "--capacity",
    "1",
  ],
])("rejects command-inapplicable grammar: %s", async (...args) => {
  expect(await runCli([...args, "--config", testPolicyPath], env, io(), offlineFetch() as typeof fetch)).toBe(2);
});
it("refuses a nonexistent targeted drain", async () => {
  expect(
    await runCli(
      ["drain", "--instance", "11111111-1111-4111-8111-111111111111", "--config", testPolicyPath],
      env,
      io(),
      offlineFetch() as typeof fetch,
    ),
  ).toBe(3);
});
it("scrubs encoded registered credentials from operational stdout", async () => {
  const encoded = Buffer.from(env.HCLOUD_TOKEN).toString("base64");
  const fetcher = vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url === "https://api.github.com/repos/CyberHoward/graditas")
      return response({ id: 123456, full_name: "CyberHoward/graditas" });
    if (url.includes("api.hetzner.cloud/v1/servers?"))
      return response({
        servers: [
          {
            id: 1,
            name: "foreign",
            created: "2026-01-01T00:00:00Z",
            status: "running",
            protection: { delete: true, rebuild: true },
            labels: { note: encoded },
          },
        ],
        meta: { pagination: { next_page: null } },
      });
    if (url.includes("/actions/runners?")) return response({ runners: [] });
    if (url.includes("/actions/runs?")) return response({ workflow_runs: [] });
    throw new Error(url);
  });
  const output = io();
  expect(await runCli(["list", "--config", testPolicyPath], env, output, fetcher as typeof fetch)).toBe(0);
  expect(output.stdout.mock.calls[0][0]).not.toContain(encoded);
  expect(output.stdout.mock.calls[0][0]).toContain("[REDACTED]");
});
it("returns configuration exit 2 for unreadable or malformed config", async () => {
  expect(
    await runCli(
      ["status", "--config", "/definitely/missing/config.json"],
      env,
      io(),
      offlineFetch() as typeof fetch,
    ),
  ).toBe(2);
});
it("orders protection repair before ready and lifecycle mutations", () => {
  expect(
    orderOperations([
      { kind: "mark-ready", instance: "i", reason: "ready" },
      { kind: "begin-drain", instance: "i", reason: "drain" },
      { kind: "repair-protection", instance: "i", reason: "protect" },
    ]).map((operation) => operation.kind),
  ).toEqual(["repair-protection", "begin-drain", "mark-ready"]);
});

it("reports verified provisioning preflight for a dry-run capacity plan without mutation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "runner-policy-"));
  const path = join(dir, "policy.yaml");
  await writeFile(
    path,
    validPolicyYaml((p) => {
      p.spec.hetzner.serverType = "cx23";
      p.spec.hetzner.location = "fsn1";
      p.spec.hetzner.firewallId = "1";
      p.spec.runner.version = "2.999.0";
      p.spec.runner.archiveSha256 = "a".repeat(64);
      p.spec.pool.costs.maxKnownHourlyPoolEur = 1;
      p.spec.pool.costs.maxKnownEligibilityEur = 10;
    }),
  );
  const approved = [
    ["udp", "53"],
    ["tcp", "53"],
    ["udp", "123"],
    ["tcp", "80"],
    ["tcp", "443"],
  ].map(([protocol, port]) => ({
    direction: "out",
    protocol,
    port,
    destination_ips: ["0.0.0.0/0", "::/0"],
  }));
  const fetcher = vi.fn(async (input: string | URL, init?: RequestInit) => {
    expect(init?.method ?? "GET").toBe("GET");
    const url = String(input);
    if (url === "https://api.github.com/repos/CyberHoward/graditas")
      return response({ id: 123456, full_name: "CyberHoward/graditas" });
    if (url.includes("api.hetzner.cloud/v1/servers?"))
      return response({
        servers: [],
        meta: { pagination: { next_page: null } },
      });
    if (url.includes("/actions/runners?")) return response({ runners: [] });
    if (url.includes("/actions/runs?")) return response({ workflow_runs: [] });
    if (url.includes("/firewalls/"))
      return response({ firewall: { id: 1, rules: approved } });
    if (url.includes("/server_types?"))
      return response({
        server_types: [
          {
            name: "cx23",
            architecture: "x86",
            deprecated: false,
            prices: [{ location: "fsn1", price_hourly: { net: "0.01" } }],
          },
        ],
      });
    if (url.includes("/images?"))
      return response({
        images: [
          {
            name: "ubuntu-24.04",
            status: "available",
            architecture: "x86",
            deprecated: null,
          },
        ],
      });
    if (url.includes("/locations?"))
      return response({
        locations: [{ name: "fsn1", disabled: false, deprecated: false }],
      });
    if (url.endsWith("/pricing"))
      return response({
        pricing: {
          primary_ips: [
            {
              type: "ipv4",
              prices: [{ location: "fsn1", price_hourly: { net: "0.001" } }],
            },
            {
              type: "ipv6",
              prices: [{ location: "fsn1", price_hourly: { net: "0" } }],
            },
          ],
        },
      });
    throw new Error(`unexpected URL ${url}`);
  });
  const output = io();
  expect(
    await runCli(
      ["ensure", "--capacity", "1", "--config", path],
      env,
      output,
      fetcher as typeof fetch,
    ),
  ).toBe(0);
  expect(JSON.parse(output.stdout.mock.calls[0][0]).preflight).toMatchObject({
    tierId: "cx-shared-x86",
    family: "CX",
    observedArchitecture: "x86",
    serverType: "cx23",
  });
  await rm(dir, { recursive: true, force: true });
});
it("rejects an unsupported-architecture policy before provider access", async () => {
  const dir = await mkdtemp(join(tmpdir(), "runner-policy-arm-"));
  const path = join(dir, "policy.yaml");
  await writeFile(
    path,
    validPolicyYaml((p) => {
      p.spec.pool.selectedTier = "cax-shared-arm64";
    }),
  );
  const fetcher = vi.fn();
  expect(
    await runCli(
      ["status", "--config", path],
      env,
      io(),
      fetcher as typeof fetch,
    ),
  ).toBe(2);
  expect(fetcher).not.toHaveBeenCalled();
  await rm(dir, { recursive: true, force: true });
});
