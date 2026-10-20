import { describe, expect, it } from "vitest";
import { renderCloudInit } from "../cloud-init.js";
import { assertMutationAllowed, parseConfig } from "../config.js";
import { configHash, runnerName, slotName } from "../identity.js";
import { planReconcile as reconcileProduction } from "../policy.js";
import { Redactor } from "../redaction.js";
import { type RunnerManagerConfig, Secret, type Snapshot } from "../types.js";

const config: RunnerManagerConfig = parseConfig({
  repository: "CyberHoward/graditas",
  pool: {
    name: "linux-x64",
    routingLabels: ["graditas", "hetzner"],
    maxSize: 1,
    scaleUpDelaySeconds: 45,
    idleGraceSeconds: 60,
    bootstrapGraceSeconds: 60,
    drainQuiescenceSeconds: 65,
    drainProbeSeconds: 5,
    maximumLifetimeSeconds: 3600,
    maxKnownHourlyPoolCostEur: 1,
    maxKnownEligibilityCostEur: 4,
  },
  hcloud: { publicNet: { ipv4: true, ipv6: true } },
  coordination: { lockPath: "/tmp/runner.lock" },
  runner: {},
});
function planReconcile(
  snapshot: Omit<Snapshot, "repoId"> & { repoId?: string },
  selectedConfig: RunnerManagerConfig,
  now: Date,
) {
  if (snapshot.repoId)
    return reconcileProduction(snapshot as Snapshot, selectedConfig, now);
  const repoId = "123";
  const servers = snapshot.servers.map((server, index) => {
    const instance = server.labels["tau-instance"] ?? `fixture-${index}`;
    const slot = Number(server.labels["tau-slot"] ?? index);
    const name = slotName(repoId, selectedConfig.pool.name, slot);
    return {
      ...server,
      name,
      labels: {
        "tau-managed": "my-gratitude-runner-v1",
        "tau-repo-id": repoId,
        "tau-pool": selectedConfig.pool.name,
        "tau-config": configHash(selectedConfig),
        "tau-slot": String(slot),
        "tau-instance": instance,
        "tau-runner-name": `${name}-${instance}`,
        ...server.labels,
      },
    };
  });
  const runners = snapshot.runners.map((runner, index) => {
    const instance =
      runner.labels
        .find((label) => label.startsWith("tau-instance-"))
        ?.slice(13) ?? `runner-fixture-${index}`;
    const server = servers.find(
      (candidate) => candidate.labels["tau-instance"] === instance,
    );
    const slot = Number(server?.labels["tau-slot"] ?? 0);
    return {
      ...runner,
      name: `${slotName(repoId, selectedConfig.pool.name, slot)}-${instance}`,
      labels: [
        "self-hosted",
        "Linux",
        "X64",
        "tau-managed",
        ...selectedConfig.pool.routingLabels,
        ...runner.labels,
      ],
    };
  });
  return reconcileProduction(
    { ...snapshot, repoId, servers, runners } as Snapshot,
    selectedConfig,
    now,
  );
}
describe("configuration safety", () => {
  it("requires both mutation gates", () => {
    expect(() => assertMutationAllowed({ apply: true }, {})).toThrow(
      "RUNNER_MANAGER_ALLOW_MUTATIONS=1",
    );
  });
  it("enforces the hard pool ceiling and quiescence", () => {
    expect(() =>
      parseConfig({ ...config, pool: { ...config.pool, maxSize: 4 } }),
    ).toThrow("between 1 and 3");
    expect(() =>
      parseConfig({
        ...config,
        pool: { ...config.pool, drainQuiescenceSeconds: 64 },
      }),
    ).toThrow("at least 65");
  });
});
it("redacts nested and raw/base64/base64url registered secrets", () => {
  const r = new Redactor();
  r.register("raw-value?");
  const output = r.stringify({
    authorization: "Bearer x",
    nested: {
      note: "raw-value?",
      base64: Buffer.from("raw-value?").toString("base64"),
      base64url: Buffer.from("raw-value?").toString("base64url"),
      url: "https://u:p@host/?token=x",
    },
  });
  expect(output).not.toContain("raw-value?");
  expect(output).not.toContain(Buffer.from("raw-value?").toString("base64"));
  expect(output).not.toContain(Buffer.from("raw-value?").toString("base64url"));
  expect(output).not.toContain("Bearer x");
  expect(output).not.toContain("u:p");
});
it("creates deterministic slot identities", () => {
  expect(slotName("123456", "linux-x64", 0)).toBe("tau-mg-123456-linux-x64-0");
  const name = runnerName(
    "1200794218",
    "linux-x64-small",
    0,
    "11111111-1111-4111-8111-111111111111",
  );
  expect(name.length).toBeLessThanOrEqual(63);
  expect(name).toMatch(/^tau-mg-1200794218-linux-x64-small-0-[a-f0-9]{16}$/);
});
it("renders pinned secret-minimizing cloud init", () => {
  const token = new Secret("registration-token");
  const payload = renderCloudInit({
    repository: "CyberHoward/graditas",
    runnerName: "tau-runner-0",
    customLabels: ["graditas", "hetzner"],
    registrationToken: token,
    runnerVersion: "2.999.0",
    archiveSha256: "a".repeat(64),
  });
  expect(payload.reveal().indexOf("groups:\n  - docker")).toBeLessThan(
    payload.reveal().indexOf("users:"),
  );
  expect(Buffer.byteLength(payload.reveal())).toBeLessThan(32768);
  expect(JSON.stringify(payload)).not.toContain("registration-token");
  expect(
    Buffer.from(
      payload.reveal().match(/content: (.+)/)?.[1] ?? "",
      "base64",
    ).toString(),
  ).toContain("pull_request.head.repo.full_name");
});
describe("conservative policy", () => {
  const snapshot = (
    patch: Partial<Snapshot> = {},
  ): Omit<Snapshot, "repoId"> & { repoId?: string } => ({
    servers: [],
    runners: [],
    jobs: [],
    provenanceComplete: true,
    ...patch,
  });
  it("ensures one deterministic bounded slot for queued demand", () => {
    const plan = planReconcile(
      snapshot({
        jobs: [
          {
            id: "j",
            status: "queued",
            labels: ["graditas", "hetzner"],
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
      }),
      config,
      new Date("2026-01-01T00:01:00Z"),
    );
    expect(plan.desiredCapacity).toBe(1);
    expect(plan.operations[0]).toMatchObject({ kind: "ensure-slot", slot: 0 });
  });
  it("does not count another pool's foreign server or busy runner as capacity", () => {
    const instance = "11111111-1111-4111-8111-111111111111";
    const plan = planReconcile(
      {
        repoId: "123",
        provenanceComplete: true,
        jobs: [
          {
            id: "j",
            status: "queued",
            labels: ["graditas", "hetzner"],
            createdAt: "2026-01-01T00:00:00Z",
          },
        ],
        servers: [
          {
            id: "other-server",
            name: "other-pool-server",
            createdAt: new Date().toISOString(),
            status: "running",
            protected: true,
            rebuildProtected: true,
            labels: {
              "tau-instance": instance,
              "tau-pool": "another-pool",
              "tau-slot": "0",
              "tau-state": "ready",
            },
          },
        ],
        runners: [
          {
            id: "other-runner",
            name: "other-pool-runner",
            busy: true,
            status: "online",
            labels: [`tau-instance-${instance}`],
          },
        ],
      },
      config,
      new Date("2026-01-01T00:01:00Z"),
    );
    expect(plan.desiredCapacity).toBe(1);
    expect(plan.operations).toContainEqual(
      expect.objectContaining({ kind: "ensure-slot", slot: 0 }),
    );
    expect(plan.operations).toContainEqual(
      expect.objectContaining({ kind: "report-foreign" }),
    );
  });
  it("refuses scale changes on ambiguous provenance", () => {
    expect(
      planReconcile(snapshot({ provenanceComplete: false }), config, new Date())
        .operations,
    ).toEqual([]);
  });
  it("refuses busy stale-runner cleanup", () => {
    const plan = planReconcile(
      snapshot({
        runners: [
          {
            id: "r",
            name: "r",
            busy: true,
            status: "online",
            labels: ["tau-instance-i1"],
          },
        ],
      }),
      config,
      new Date(),
    );
    expect(plan.operations).toContainEqual(
      expect.objectContaining({ kind: "refuse" }),
    );
  });
  it("requires a later 65-second drain tick", () => {
    const server = {
      id: "s",
      name: "s",
      createdAt: "2026-01-01T00:00:00Z",
      status: "running",
      protected: true,
      rebuildProtected: true,
      labels: {
        "tau-instance": "i1",
        "tau-slot": "0",
        "tau-state": "draining",
        "tau-drain-since": "100",
      },
    };
    expect(
      planReconcile(snapshot({ servers: [server] }), config, new Date(150_000))
        .operations[0]?.kind,
    ).toBe("retain-draining");
    expect(
      planReconcile(snapshot({ servers: [server] }), config, new Date(166_000))
        .operations[0]?.kind,
    ).toBe("probe-drain");
  });
});
it("keeps registration token out of persistent bootstrap files", () => {
  const token = new Secret("ephemeral-registration-token");
  const cloud = renderCloudInit({
    repository: "CyberHoward/graditas",
    runnerName: "runner-1",
    customLabels: ["safe"],
    registrationToken: token,
    runnerVersion: "2.999.0",
    archiveSha256: "a".repeat(64),
  }).reveal();
  const contents = [...cloud.matchAll(/content: (\S+)/g)].map((match) =>
    Buffer.from(match[1], "base64").toString(),
  );
  expect(
    contents.filter((body) => body.includes("ephemeral-registration-token")),
  ).toEqual(["ephemeral-registration-token"]);
  const bootstrap = contents.find(
    (body) => body.includes("bootstrap-runner") || body.includes("config.sh"),
  );
  expect(bootstrap).not.toContain("ephemeral-registration-token");
  expect(bootstrap).toContain("rm -f");
  expect(bootstrap).toContain(
    "ACTIONS_RUNNER_HOOK_JOB_STARTED=/usr/local/libexec/tau-runner-pre-job.sh",
  );
  expect(bootstrap?.indexOf("tar xzf")).toBeLessThan(
    bootstrap?.indexOf("chown -R actions:actions") ?? -1,
  );
  expect(bootstrap?.indexOf("chown -R actions:actions")).toBeLessThan(
    bootstrap?.indexOf("su actions") ?? -1,
  );
});
it("drains an idle runner at maximum lifetime despite unrelated retention", () => {
  const now = new Date("2026-01-01T02:00:00Z");
  const server = {
    id: "s",
    name: "s",
    createdAt: "2026-01-01T00:00:00Z",
    status: "running",
    protected: true,
    rebuildProtected: true,
    labels: { "tau-instance": "i1", "tau-slot": "0", "tau-state": "ready" },
  };
  const runner = {
    id: "r",
    name: "r",
    busy: false,
    status: "online",
    labels: ["tau-instance-i1"],
  };
  const plan = planReconcile(
    {
      servers: [server],
      runners: [runner],
      jobs: [
        {
          id: "other",
          status: "waiting",
          labels: ["self-hosted", "linux", "x64", "graditas", "hetzner"],
        },
      ],
      provenanceComplete: true,
    },
    config,
    now,
  );
  expect(plan.operations).toContainEqual(
    expect.objectContaining({ kind: "begin-drain", instance: "i1" }),
  );
});
it("drains an orphan immediately after bootstrap grace and reports malformed inventory", () => {
  const now = new Date("2026-01-01T00:02:00Z");
  const orphan = {
    id: "s",
    name: "s",
    createdAt: "2026-01-01T00:00:00Z",
    status: "running",
    protected: true,
    rebuildProtected: true,
    labels: {
      "tau-instance": "i1",
      "tau-slot": "0",
      "tau-state": "provisioning",
    },
  };
  const foreign = { ...orphan, id: "f", labels: { "tau-managed": "broken" } };
  const plan = planReconcile(
    {
      servers: [orphan, foreign],
      runners: [],
      jobs: [],
      provenanceComplete: true,
    },
    config,
    now,
  );
  expect(plan.operations).toContainEqual(
    expect.objectContaining({ kind: "begin-drain", instance: "i1" }),
  );
  expect(plan.operations).toContainEqual(
    expect.objectContaining({ kind: "report-foreign" }),
  );
});
it("repairs crash-window protections even when GitHub demand is ambiguous", () => {
  const server = {
    id: "s",
    name: "s",
    createdAt: "2026-01-01T00:00:00Z",
    status: "running",
    protected: false,
    rebuildProtected: false,
    labels: {
      "tau-instance": "i1",
      "tau-slot": "0",
      "tau-state": "provisioning",
    },
  };
  const plan = planReconcile(
    { servers: [server], runners: [], jobs: [], provenanceComplete: false },
    config,
    new Date(),
  );
  expect(plan.operations).toContainEqual(
    expect.objectContaining({ kind: "repair-protection", instance: "i1" }),
  );
  expect(plan.operations.some((operation) => operation.destructive)).toBe(
    false,
  );
});
it("does not create capacity for work assigned to another runner", () => {
  const plan = planReconcile(
    {
      servers: [],
      runners: [],
      jobs: [
        {
          id: "j",
          status: "in_progress",
          labels: ["self-hosted", "linux", "x64", "graditas", "hetzner"],
          createdAt: "2026-01-01T00:00:00Z",
          runnerId: "github-capacity",
        },
      ],
      provenanceComplete: true,
    },
    config,
    new Date(),
  );
  expect(plan.desiredCapacity).toBe(0);
  expect(plan.operations).not.toContainEqual(
    expect.objectContaining({ kind: "ensure-slot" }),
  );
});
it("waits for sustained unassigned demand before creating capacity", () => {
  const plan = planReconcile(
    {
      servers: [],
      runners: [],
      jobs: [
        {
          id: "j",
          status: "queued",
          labels: ["graditas", "hetzner"],
          createdAt: "2026-01-01T00:00:30Z",
        },
      ],
      provenanceComplete: true,
    },
    config,
    new Date("2026-01-01T00:01:00Z"),
  );
  expect(plan.desiredCapacity).toBe(0);
  expect(plan.operations).not.toContainEqual(
    expect.objectContaining({ kind: "ensure-slot" }),
  );
});
it("sets idle once, clears it on demand, and drains only after expiry", () => {
  const base = {
    id: "s",
    name: "s",
    createdAt: "2026-01-01T00:00:00Z",
    status: "running",
    protected: true,
    rebuildProtected: true,
    labels: { "tau-instance": "i1", "tau-slot": "0", "tau-state": "ready" },
  };
  const runner = {
    id: "r",
    name: "r",
    busy: false,
    status: "online",
    labels: ["tau-instance-i1"],
  };
  const first = planReconcile(
    { servers: [base], runners: [runner], jobs: [], provenanceComplete: true },
    config,
    new Date(10_000),
  );
  expect(
    first.operations.filter((operation) => operation.kind === "set-idle"),
  ).toHaveLength(1);
  const idled = { ...base, labels: { ...base.labels, "tau-idle-since": "10" } };
  const before = planReconcile(
    { servers: [idled], runners: [runner], jobs: [], provenanceComplete: true },
    config,
    new Date(20_000),
  );
  expect(
    before.operations.some((operation) => operation.kind === "begin-drain"),
  ).toBe(false);
  const demand = planReconcile(
    {
      servers: [idled],
      runners: [runner],
      jobs: [
        {
          id: "j",
          status: "waiting",
          labels: ["self-hosted", "linux", "x64", "graditas", "hetzner"],
        },
      ],
      provenanceComplete: true,
    },
    config,
    new Date(20_000),
  );
  expect(demand.operations).toContainEqual(
    expect.objectContaining({ kind: "clear-idle" }),
  );
  const expired = planReconcile(
    { servers: [idled], runners: [runner], jobs: [], provenanceComplete: true },
    config,
    new Date(80_000),
  );
  expect(expired.operations).toContainEqual(
    expect.objectContaining({ kind: "begin-drain" }),
  );
});
it("unregisters only a fully identified idle stale runner", () => {
  const instance = "11111111-1111-4111-8111-111111111111";
  const valid = {
    id: "r",
    name: `tau-mg-123-linux-x64-0-${instance}`,
    busy: false,
    status: "offline",
    labels: [
      "self-hosted",
      "Linux",
      "X64",
      "tau-managed",
      "graditas",
      "hetzner",
      `tau-instance-${instance}`,
    ],
  };
  const plan = planReconcile(
    {
      repoId: "123",
      servers: [],
      runners: [valid],
      jobs: [],
      provenanceComplete: true,
    },
    config,
    new Date(),
  );
  expect(plan.operations).toContainEqual(
    expect.objectContaining({ kind: "unregister", instance }),
  );
  const malformed = { ...valid, id: "bad", name: "untrusted-name" };
  const foreign = planReconcile(
    {
      repoId: "123",
      servers: [],
      runners: [malformed],
      jobs: [],
      provenanceComplete: true,
    },
    config,
    new Date(),
  );
  expect(foreign.operations).toContainEqual(
    expect.objectContaining({ kind: "report-foreign" }),
  );
  expect(
    foreign.operations.some((operation) => operation.kind === "unregister"),
  ).toBe(false);
});
it("classifies complete server ownership mismatches as report-only", () => {
  const instance = "11111111-1111-4111-8111-111111111111";
  const mismatched = {
    id: "s",
    name: "tau-mg-123-linux-x64-0",
    createdAt: "2026-01-01T00:00:00Z",
    status: "running",
    protected: true,
    rebuildProtected: true,
    labels: {
      "tau-managed": "my-gratitude-runner-v1",
      "tau-repo-id": "123",
      "tau-pool": "wrong",
      "tau-slot": "0",
      "tau-instance": instance,
      "tau-state": "ready",
      "tau-config": configHash(config),
      "tau-runner-name": `tau-mg-123-linux-x64-0-${instance}`,
    },
  };
  const plan = planReconcile(
    {
      repoId: "123",
      servers: [mismatched],
      runners: [],
      jobs: [],
      provenanceComplete: true,
    },
    config,
    new Date(),
  );
  expect(plan.operations).toContainEqual(
    expect.objectContaining({ kind: "report-foreign" }),
  );
  expect(
    plan.operations.some((operation) =>
      ["begin-drain", "set-idle", "repair-protection"].includes(operation.kind),
    ),
  ).toBe(false);
});
it("keeps an old-config server and matching runner report-only as one pair", () => {
  const instance = "11111111-1111-4111-8111-111111111111";
  const name = "tau-mg-123-linux-x64-0";
  const server = {
    id: "s",
    name,
    createdAt: "2026-01-01T00:00:00Z",
    status: "running",
    protected: true,
    rebuildProtected: true,
    labels: {
      "tau-managed": "my-gratitude-runner-v1",
      "tau-repo-id": "123",
      "tau-pool": "linux-x64",
      "tau-slot": "0",
      "tau-instance": instance,
      "tau-state": "ready",
      "tau-config": "old-config",
      "tau-runner-name": `${name}-${instance}`,
    },
  };
  const runner = {
    id: "r",
    name: `${name}-${instance}`,
    busy: false,
    status: "offline",
    labels: [
      "self-hosted",
      "Linux",
      "X64",
      "tau-managed",
      "graditas",
      "hetzner",
      `tau-instance-${instance}`,
    ],
  };
  const plan = planReconcile(
    {
      repoId: "123",
      servers: [server],
      runners: [runner],
      jobs: [],
      provenanceComplete: true,
    },
    config,
    new Date(),
  );
  expect(plan.operations).toEqual([
    expect.objectContaining({ kind: "report-foreign", instance }),
  ]);
});
it("fails closed on duplicate immutable server or runner identities", () => {
  const instance = "11111111-1111-4111-8111-111111111111";
  const name = "tau-mg-123-linux-x64-0";
  const server = {
    id: "s",
    name,
    createdAt: "2026-01-01T00:00:00Z",
    status: "running",
    protected: true,
    rebuildProtected: true,
    labels: {
      "tau-managed": "my-gratitude-runner-v1",
      "tau-repo-id": "123",
      "tau-pool": "linux-x64",
      "tau-slot": "0",
      "tau-instance": instance,
      "tau-state": "ready",
      "tau-config": configHash(config),
      "tau-runner-name": `${name}-${instance}`,
    },
  };
  const runner = {
    id: "r",
    name: `${name}-${instance}`,
    busy: false,
    status: "offline",
    labels: [
      "self-hosted",
      "Linux",
      "X64",
      "tau-managed",
      "graditas",
      "hetzner",
      `tau-instance-${instance}`,
    ],
  };
  for (const snapshot of [
    { servers: [server, { ...server, id: "s2" }], runners: [runner] },
    {
      servers: [server],
      runners: [runner, { ...runner, id: "r2", busy: true }],
    },
  ]) {
    const plan = planReconcile(
      { repoId: "123", ...snapshot, jobs: [], provenanceComplete: true },
      config,
      new Date(),
    );
    expect(plan.operations).toEqual([
      expect.objectContaining({ kind: "report-foreign" }),
    ]);
  }
});
it("recovers partial drain and online-ready persistence transitions", () => {
  const instance = "11111111-1111-4111-8111-111111111111";
  const name = "tau-mg-123-linux-x64-0";
  const server = {
    id: "s",
    name,
    createdAt: "2026-01-01T00:00:00Z",
    status: "running",
    protected: true,
    rebuildProtected: true,
    labels: {
      "tau-managed": "my-gratitude-runner-v1",
      "tau-repo-id": "123",
      "tau-pool": "linux-x64",
      "tau-slot": "0",
      "tau-instance": instance,
      "tau-state": "provisioning",
      "tau-config": configHash(config),
      "tau-runner-name": `${name}-${instance}`,
    },
  };
  const baseRunner = {
    id: "r",
    name: `${name}-${instance}`,
    busy: false,
    status: "online",
    labels: [
      "self-hosted",
      "Linux",
      "X64",
      "tau-managed",
      "graditas",
      "hetzner",
      `tau-instance-${instance}`,
    ],
  };
  const ready = planReconcile(
    {
      repoId: "123",
      servers: [server],
      runners: [baseRunner],
      jobs: [],
      provenanceComplete: true,
    },
    config,
    new Date(),
  );
  expect(ready.operations).toContainEqual(
    expect.objectContaining({ kind: "mark-ready" }),
  );
  const draining = planReconcile(
    {
      repoId: "123",
      servers: [
        { ...server, labels: { ...server.labels, "tau-state": "ready" } },
      ],
      runners: [
        {
          ...baseRunner,
          labels: [
            "self-hosted",
            "Linux",
            "X64",
            "tau-managed",
            "tau-draining",
            `tau-instance-${instance}`,
          ],
        },
      ],
      jobs: [],
      provenanceComplete: true,
    },
    config,
    new Date(),
  );
  expect(draining.operations).toContainEqual(
    expect.objectContaining({ kind: "begin-drain" }),
  );
});
it("rejects malformed configuration field types as usage errors", () => {
  expect(() =>
    parseConfig({
      ...config,
      hcloud: { ...config.hcloud, publicNet: { ipv4: "true", ipv6: true } },
    }),
  ).toThrow("must be boolean");
  expect(() =>
    parseConfig({ ...config, hcloud: { ...config.hcloud, sshKeyIds: [1] } }),
  ).toThrow("string array");
  expect(() =>
    parseConfig({
      ...config,
      pool: { ...config.pool, routingLabels: "labels" },
    }),
  ).toThrow("string array");
});
it("classifies missing, oversized, and future drain epochs report-only", () => {
  const instance = "11111111-1111-4111-8111-111111111111";
  const name = "tau-mg-123-linux-x64-0";
  const base = {
    id: "s",
    name,
    createdAt: "1970-01-01T00:00:00Z",
    status: "running",
    protected: true,
    rebuildProtected: true,
    labels: {
      "tau-managed": "my-gratitude-runner-v1",
      "tau-repo-id": "123",
      "tau-pool": "linux-x64",
      "tau-slot": "0",
      "tau-instance": instance,
      "tau-state": "draining",
      "tau-config": configHash(config),
      "tau-runner-name": `${name}-${instance}`,
    },
  };
  for (const drainSince of [undefined, "9007199254740992", "2000"]) {
    const labels = {
      ...base.labels,
      ...(drainSince === undefined ? {} : { "tau-drain-since": drainSince }),
    };
    const plan = planReconcile(
      {
        repoId: "123",
        servers: [{ ...base, labels }],
        runners: [],
        jobs: [],
        provenanceComplete: true,
      },
      config,
      new Date(1_000_000),
    );
    expect(plan.operations).toContainEqual(
      expect.objectContaining({ kind: "report-foreign" }),
    );
    expect(
      plan.operations.some((operation) => operation.kind === "retain-draining"),
    ).toBe(false);
  }
});
it("classifies missing or arbitrary tau-state report-only", () => {
  const instance = "11111111-1111-4111-8111-111111111111";
  const name = "tau-mg-123-linux-x64-0";
  const base = {
    id: "s",
    name,
    createdAt: "2026-01-01T00:00:00Z",
    status: "running",
    protected: true,
    rebuildProtected: true,
    labels: {
      "tau-managed": "my-gratitude-runner-v1",
      "tau-repo-id": "123",
      "tau-pool": "linux-x64",
      "tau-slot": "0",
      "tau-instance": instance,
      "tau-config": configHash(config),
      "tau-runner-name": `${name}-${instance}`,
    },
  };
  for (const state of [undefined, "mystery"]) {
    const labels = { ...base.labels, ...(state ? { "tau-state": state } : {}) };
    const plan = planReconcile(
      {
        repoId: "123",
        servers: [{ ...base, labels }],
        runners: [],
        jobs: [],
        provenanceComplete: true,
      },
      config,
      new Date(),
    );
    expect(plan.operations).toEqual([
      expect.objectContaining({ kind: "report-foreign" }),
    ]);
  }
});
