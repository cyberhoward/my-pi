import { describe, expect, it, vi } from "vitest";
import { parseConfig } from "../config.js";
import { Executor } from "../executor.js";
import { configHash } from "../identity.js";

const cfg = parseConfig({
  repository: "r/o",
  pool: {
    name: "p",
    routingLabels: ["a"],
    maxSize: 1,
    scaleUpDelaySeconds: 45,
    idleGraceSeconds: 1,
    bootstrapGraceSeconds: 1,
    drainQuiescenceSeconds: 65,
    drainProbeSeconds: 1,
    maximumLifetimeSeconds: 1,
    maxKnownHourlyPoolCostEur: 1,
    maxKnownEligibilityCostEur: 1,
  },
  hcloud: { publicNet: { ipv4: true, ipv6: true } },
  coordination: { lockPath: "/tmp/x" },
  runner: {},
});
it("refuses destroy when a fresh runner read is busy", async () => {
  const server = {
    id: "s",
    name: "tau-mg-1-p-0",
    createdAt: "",
    status: "running",
    protected: true,
    rebuildProtected: true,
    labels: {
      "tau-managed": "my-gratitude-runner-v1",
      "tau-repo-id": "1",
      "tau-pool": "p",
      "tau-slot": "0",
      "tau-config": configHash(cfg),
      "tau-instance": "i",
      "tau-runner-name": "tau-mg-1-p-0-i",
      "tau-state": "draining",
      "tau-drain-since": "1",
    },
  };
  const h: any = {
    listOwned: vi.fn().mockResolvedValue([server]),
    getServer: vi.fn(),
    setProtections: vi.fn(),
    deleteServer: vi.fn(),
  };
  const g: any = {
    listManagedRunners: vi.fn().mockResolvedValue([
      {
        id: "r",
        name: "tau-mg-1-p-0-i",
        busy: true,
        status: "online",
        labels: [
          "self-hosted",
          "Linux",
          "X64",
          "tau-managed",
          "tau-draining",
          "tau-instance-i",
        ],
      },
    ]),
  };
  await expect(
    new Executor(h, g, cfg, "1").destroyAfterQuiescence("i"),
  ).rejects.toThrow("busy");
  expect(h.setProtections).not.toHaveBeenCalled();
  expect(h.deleteServer).not.toHaveBeenCalled();
});
it("adopts a deterministic duplicate slot and repairs protections without creating", async () => {
  const server = {
    id: "s",
    name: "tau-mg-1-p-0",
    createdAt: "2026-01-01T00:00:00Z",
    status: "running",
    protected: false,
    rebuildProtected: false,
    labels: {
      "tau-managed": "my-gratitude-runner-v1",
      "tau-repo-id": "1",
      "tau-pool": "p",
      "tau-config": configHash(cfg),
      "tau-slot": "0",
      "tau-instance": "i",
      "tau-runner-name": "tau-mg-1-p-0-i",
      "tau-state": "provisioning",
    },
  };
  const verified = { ...server, protected: true, rebuildProtected: true };
  const h: any = {
    listOwned: vi.fn().mockResolvedValue([server]),
    setProtections: vi.fn(),
    getServer: vi.fn().mockResolvedValue(verified),
    createServer: vi.fn(),
    preflight: vi.fn(),
    updateLabels: vi.fn(),
  };
  const g: any = {
    listManagedRunners: vi.fn().mockResolvedValue([
      {
        id: "r",
        name: "tau-mg-1-p-0-i",
        busy: false,
        status: "online",
        labels: [
          "self-hosted",
          "Linux",
          "X64",
          "tau-managed",
          "a",
          "tau-instance-i",
        ],
      },
    ]),
  };
  await new Executor(h, g, cfg, "1").ensureSlot(0);
  expect(h.createServer).not.toHaveBeenCalled();
  expect(h.setProtections).toHaveBeenCalledWith("s", {
    delete: true,
    rebuild: true,
  });
});
it("removes routing labels before persisting the first drain tick", async () => {
  const calls: string[] = [];
  const server = {
    id: "s",
    name: "tau-mg-1-p-0",
    createdAt: "2026-01-01T00:00:00Z",
    status: "running",
    protected: true,
    rebuildProtected: true,
    labels: {
      "tau-managed": "my-gratitude-runner-v1",
      "tau-repo-id": "1",
      "tau-pool": "p",
      "tau-slot": "0",
      "tau-config": configHash(cfg),
      "tau-instance": "i",
      "tau-runner-name": "tau-mg-1-p-0-i",
      "tau-state": "ready",
    },
  };
  const h: any = {
    listOwned: vi.fn().mockResolvedValue([server]),
    updateLabels: vi.fn(async () => {
      calls.push("server-draining");
    }),
  };
  const g: any = {
    listManagedRunners: vi.fn().mockResolvedValue([
      {
        id: "r",
        name: "tau-mg-1-p-0-i",
        busy: true,
        status: "online",
        labels: [
          "self-hosted",
          "Linux",
          "X64",
          "tau-managed",
          "a",
          "tau-instance-i",
        ],
      },
    ]),
    setRunnerLabels: vi.fn(async () => {
      calls.push("routing-removed");
    }),
  };
  await new Executor(h, g, cfg, "1").beginDrain("i");
  expect(calls).toEqual(["routing-removed", "server-draining"]);
});
it("deletes a quiescent drained orphan while replacement demand is active", async () => {
  const server = {
    id: "s",
    name: "tau-mg-1-p-0",
    createdAt: "1970-01-01T00:00:00Z",
    status: "running",
    protected: true,
    rebuildProtected: true,
    labels: {
      "tau-managed": "my-gratitude-runner-v1",
      "tau-repo-id": "1",
      "tau-pool": "p",
      "tau-slot": "0",
      "tau-config": configHash(cfg),
      "tau-instance": "i",
      "tau-runner-name": "tau-mg-1-p-0-i",
      "tau-state": "draining",
      "tau-drain-since": "1",
    },
  };
  const unprotected = {
    ...server,
    protected: false,
    rebuildProtected: false,
  };
  const h: any = {
    listOwned: vi.fn().mockResolvedValue([server]),
    getServer: vi
      .fn()
      .mockResolvedValueOnce(server)
      .mockResolvedValueOnce(unprotected),
    setProtections: vi.fn(),
    deleteServer: vi.fn(),
  };
  const g: any = {
    listManagedRunners: vi.fn().mockResolvedValue([]),
    listActiveMatchingJobs: vi.fn().mockResolvedValue({
      jobs: [
        {
          id: "j",
          status: "queued",
          labels: ["a"],
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
      provenanceComplete: true,
    }),
  };
  await expect(
    new Executor(h, g, cfg, "1", {
      now: () => new Date(200_000),
      sleep: vi.fn(),
    }).destroyAfterQuiescence("i"),
  ).resolves.toBeUndefined();
  expect(g.listActiveMatchingJobs).toHaveBeenCalledTimes(2);
  expect(h.setProtections).toHaveBeenCalledWith("s", {
    delete: false,
    rebuild: false,
  });
  expect(h.deleteServer).toHaveBeenCalledWith("s");
});
it("refuses when a runner disappears between teardown probes", async () => {
  const server = {
    id: "s",
    name: "tau-mg-1-p-0",
    createdAt: "2026-01-01T00:00:00Z",
    status: "running",
    protected: true,
    rebuildProtected: true,
    labels: {
      "tau-managed": "my-gratitude-runner-v1",
      "tau-repo-id": "1",
      "tau-pool": "p",
      "tau-slot": "0",
      "tau-config": configHash(cfg),
      "tau-instance": "i",
      "tau-runner-name": "tau-mg-1-p-0-i",
      "tau-state": "draining",
      "tau-drain-since": "1",
    },
  };
  const h: any = {
    listOwned: vi.fn().mockResolvedValue([server]),
    setProtections: vi.fn(),
    deleteServer: vi.fn(),
  };
  const g: any = {
    listManagedRunners: vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: "r",
          name: "tau-mg-1-p-0-i",
          busy: false,
          status: "online",
          labels: [
            "self-hosted",
            "Linux",
            "X64",
            "tau-managed",
            "tau-draining",
            "tau-instance-i",
          ],
        },
      ])
      .mockResolvedValueOnce([]),
    listActiveMatchingJobs: vi
      .fn()
      .mockResolvedValue({ jobs: [], provenanceComplete: true }),
  };
  const clock: any = { now: () => new Date(200_000), sleep: vi.fn() };
  await expect(
    new Executor(h, g, cfg, "1", clock).destroyAfterQuiescence("i"),
  ).rejects.toThrow("disappeared");
  expect(h.deleteServer).not.toHaveBeenCalled();
});
it("marks a newly provisioned server ready only after its exact runner is online", async () => {
  const liveCfg = parseConfig({
    ...cfg,
    hcloud: {
      serverType: "cpx",
      location: "fsn",
      image: "ubuntu-24.04",
      firewallId: "fw",
      sshKeyIds: [],
      publicNet: { ipv4: true, ipv6: true },
    },
    runner: { version: "2.999.0", archiveSha256: "a".repeat(64) },
  });
  liveCfg.tier = {
    id: "cx-shared-x86",
    family: "CX",
    architecture: "x86",
    serverTypes: ["cpx"],
    sources: [],
  };
  liveCfg.inventory = {
    managedLabelValue: "my-gratitude-runner-v1",
    classificationLabels: { environment: "ci" },
  };
  let created: any;
  const h: any = {
    listOwned: vi.fn().mockResolvedValue([]),
    preflight: vi.fn().mockResolvedValue({}),
    createServer: vi.fn(async (input) => {
      created = input;
      return { id: "s" };
    }),
    getServer: vi.fn(async () => ({
      id: "s",
      name: created.name,
      createdAt: "2026-07-28T16:00:00Z",
      status: "running",
      protected: true,
      rebuildProtected: true,
      labels: created.labels,
    })),
    setProtections: vi.fn(),
    updateLabels: vi.fn(),
  };
  const g: any = {
    createRegistrationToken: vi
      .fn()
      .mockResolvedValue({ reveal: () => "token", toJSON: () => "[REDACTED]" }),
    listManagedRunners: vi.fn(async () => [
      {
        id: "r",
        name: created.labels["tau-runner-name"],
        busy: false,
        status: "online",
        labels: [
          "self-hosted",
          "Linux",
          "X64",
          "tau-managed",
          "a",
          `tau-instance-${created.labels["tau-instance"]}`,
        ],
      },
    ]),
  };
  await new Executor(h, g, liveCfg, "1", {
    now: () => new Date("2026-07-28T16:00:01Z"),
    sleep: vi.fn(),
  }).ensureSlot(0);
  expect(created.labels).toMatchObject({
    "tau-tier": "cx-shared-x86",
    environment: "ci",
  });
  expect(h.updateLabels).toHaveBeenCalledWith(
    "s",
    expect.objectContaining({ "tau-state": "ready" }),
  );
});
it("polls transient offline registration until online and fails only at deadline", async () => {
  const server: any = {
    id: "s",
    name: "tau-mg-1-p-0",
    createdAt: "1970-01-01T00:00:00Z",
    status: "running",
    protected: true,
    rebuildProtected: true,
    labels: {
      "tau-managed": "my-gratitude-runner-v1",
      "tau-repo-id": "1",
      "tau-pool": "p",
      "tau-config": configHash(cfg),
      "tau-slot": "0",
      "tau-instance": "i",
      "tau-runner-name": "tau-mg-1-p-0-i",
      "tau-state": "provisioning",
    },
  };
  let now = 0;
  const clock: any = {
    now: () => new Date(now),
    sleep: vi.fn(async (ms: number) => {
      now += ms;
    }),
  };
  const h: any = {
    getServer: vi.fn().mockResolvedValue(server),
    updateLabels: vi.fn(),
  };
  const offline = {
    id: "r",
    name: "tau-mg-1-p-0-i",
    busy: false,
    status: "offline",
    labels: [
      "self-hosted",
      "Linux",
      "X64",
      "tau-managed",
      "a",
      "tau-instance-i",
    ],
  };
  const online = { ...offline, status: "online" };
  const g: any = {
    listManagedRunners: vi
      .fn()
      .mockResolvedValueOnce([offline])
      .mockResolvedValueOnce([online]),
  };
  await (new Executor(h, g, cfg, "1", clock) as any).markReadyWhenOnline(
    server,
  );
  expect(h.updateLabels).toHaveBeenCalledWith(
    "s",
    expect.objectContaining({ "tau-state": "ready" }),
  );
  now = 0;
  const alwaysOffline: any = {
    listManagedRunners: vi.fn().mockResolvedValue([offline]),
  };
  await expect(
    (
      new Executor(h, alwaysOffline, cfg, "1", clock) as any
    ).markReadyWhenOnline(server),
  ).rejects.toThrow("bootstrap grace expired");
});
describe("stale runner execution fencing", () => {
  const instance = "11111111-1111-4111-8111-111111111111";
  const valid = {
    id: "r",
    name: `tau-mg-1-p-0-${instance}`,
    busy: false,
    status: "offline",
    labels: [
      "self-hosted",
      "Linux",
      "X64",
      "tau-managed",
      "a",
      `tau-instance-${instance}`,
    ],
  };
  it("revalidates one exact idle deterministic identity before deletion", async () => {
    const g: any = {
      listManagedRunners: vi.fn().mockResolvedValue([valid]),
      getRunner: vi.fn().mockResolvedValue(valid),
      deleteRunner: vi.fn(),
    };
    await new Executor({} as any, g, cfg, "1").execute({
      kind: "unregister",
      instance,
      reason: "stale",
    });
    expect(g.deleteRunner).toHaveBeenCalledWith("r");
  });
  it.each([
    ["duplicate identity label", [valid, { ...valid, id: "r2" }]],
    ["wrong deterministic name", [{ ...valid, name: "wrong" }]],
  ])("refuses %s", async (_name, runners) => {
    const g: any = {
      listManagedRunners: vi.fn().mockResolvedValue(runners),
      getRunner: vi.fn(),
      deleteRunner: vi.fn(),
    };
    await expect(
      new Executor({} as any, g, cfg, "1").execute({
        kind: "unregister",
        instance,
        reason: "stale",
      }),
    ).rejects.toThrow();
    expect(g.deleteRunner).not.toHaveBeenCalled();
  });
  it("refuses inventory changes between list and final get", async () => {
    const g: any = {
      listManagedRunners: vi.fn().mockResolvedValue([valid]),
      getRunner: vi.fn().mockResolvedValue({ ...valid, busy: true }),
      deleteRunner: vi.fn(),
    };
    await expect(
      new Executor({} as any, g, cfg, "1").execute({
        kind: "unregister",
        instance,
        reason: "stale",
      }),
    ).rejects.toThrow("changed or is busy");
    expect(g.deleteRunner).not.toHaveBeenCalled();
  });
});
it("refuses teardown when immutable server or runner identity is duplicated", async () => {
  const instance = "11111111-1111-4111-8111-111111111111";
  const server = {
    id: "s",
    name: "tau-mg-1-p-0",
    createdAt: "2026-01-01T00:00:00Z",
    status: "running",
    protected: true,
    rebuildProtected: true,
    labels: {
      "tau-managed": "my-gratitude-runner-v1",
      "tau-repo-id": "1",
      "tau-pool": "p",
      "tau-config": configHash(cfg),
      "tau-slot": "0",
      "tau-instance": instance,
      "tau-runner-name": `tau-mg-1-p-0-${instance}`,
      "tau-state": "ready",
    },
  };
  const runner = {
    id: "r",
    name: `tau-mg-1-p-0-${instance}`,
    busy: false,
    status: "online",
    labels: [
      "self-hosted",
      "Linux",
      "X64",
      "tau-managed",
      "tau-draining",
      `tau-instance-${instance}`,
    ],
  };
  const g: any = { listManagedRunners: vi.fn().mockResolvedValue([runner]) };
  await expect(
    new Executor(
      {
        listOwned: vi.fn().mockResolvedValue([server, { ...server, id: "s2" }]),
      } as any,
      g,
      cfg,
      "1",
    ).beginDrain(instance),
  ).rejects.toThrow("server identity must be unique");
  const duplicateRunners: any = {
    listManagedRunners: vi
      .fn()
      .mockResolvedValue([runner, { ...runner, id: "r2", busy: true }]),
  };
  await expect(
    new Executor(
      { listOwned: vi.fn().mockResolvedValue([server]) } as any,
      duplicateRunners,
      cfg,
      "1",
    ).beginDrain(instance),
  ).rejects.toThrow("runner identity must be unique");
});
it("marks an exactly fenced busy online provisioning runner ready", async () => {
  const instance = "11111111-1111-4111-8111-111111111111";
  const server = {
    id: "s",
    name: "tau-mg-1-p-0",
    createdAt: "2026-01-01T00:00:00Z",
    status: "running",
    protected: true,
    rebuildProtected: true,
    labels: {
      "tau-managed": "my-gratitude-runner-v1",
      "tau-repo-id": "1",
      "tau-pool": "p",
      "tau-config": configHash(cfg),
      "tau-slot": "0",
      "tau-instance": instance,
      "tau-runner-name": `tau-mg-1-p-0-${instance}`,
      "tau-state": "provisioning",
    },
  };
  const runner = {
    id: "r",
    name: `tau-mg-1-p-0-${instance}`,
    busy: true,
    status: "online",
    labels: [
      "self-hosted",
      "Linux",
      "X64",
      "tau-managed",
      "a",
      `tau-instance-${instance}`,
    ],
  };
  const h: any = {
    listOwned: vi.fn().mockResolvedValue([server]),
    updateLabels: vi.fn(),
  };
  const g: any = { listManagedRunners: vi.fn().mockResolvedValue([runner]) };
  await new Executor(h, g, cfg, "1").execute({
    kind: "mark-ready",
    instance,
    reason: "recover",
  });
  expect(h.updateLabels).toHaveBeenCalledWith(
    "s",
    expect.objectContaining({ "tau-state": "ready" }),
  );
});
it("refuses lifecycle mutation when complete runner labels changed after planning", async () => {
  const instance = "11111111-1111-4111-8111-111111111111";
  const server = {
    id: "s",
    name: "tau-mg-1-p-0",
    createdAt: "2026-01-01T00:00:00Z",
    status: "running",
    protected: true,
    rebuildProtected: true,
    labels: {
      "tau-managed": "my-gratitude-runner-v1",
      "tau-repo-id": "1",
      "tau-pool": "p",
      "tau-config": configHash(cfg),
      "tau-slot": "0",
      "tau-instance": instance,
      "tau-runner-name": `tau-mg-1-p-0-${instance}`,
      "tau-state": "ready",
    },
  };
  const changed = {
    id: "r",
    name: `tau-mg-1-p-0-${instance}`,
    busy: false,
    status: "online",
    labels: ["self-hosted", "Linux", "X64", `tau-instance-${instance}`],
  };
  await expect(
    new Executor(
      { listOwned: vi.fn().mockResolvedValue([server]) } as any,
      { listManagedRunners: vi.fn().mockResolvedValue([changed]) } as any,
      cfg,
      "1",
    ).beginDrain(instance),
  ).rejects.toThrow("complete identity fence");
});
it.each([
  "",
  "-1",
  "9007199254740992",
  "9999999999",
])("refuses targeted teardown with invalid drain epoch %s", async (epoch) => {
  const instance = "11111111-1111-4111-8111-111111111111";
  const server = {
    id: "s",
    name: "tau-mg-1-p-0",
    createdAt: "2026-01-01T00:00:00Z",
    status: "running",
    protected: true,
    rebuildProtected: true,
    labels: {
      "tau-managed": "my-gratitude-runner-v1",
      "tau-repo-id": "1",
      "tau-pool": "p",
      "tau-config": configHash(cfg),
      "tau-slot": "0",
      "tau-instance": instance,
      "tau-runner-name": `tau-mg-1-p-0-${instance}`,
      "tau-state": "draining",
      "tau-drain-since": epoch,
    },
  };
  const h: any = {
    listOwned: vi.fn().mockResolvedValue([server]),
    deleteServer: vi.fn(),
  };
  const g: any = { listManagedRunners: vi.fn().mockResolvedValue([]) };
  await expect(
    new Executor(h, g, cfg, "1", {
      now: () => new Date(200_000),
      sleep: vi.fn(),
    }).destroyAfterQuiescence(instance),
  ).rejects.toThrow();
  expect(h.deleteServer).not.toHaveBeenCalled();
});
it("repairs mandatory server protections without any runner", async () => {
  const instance = "11111111-1111-4111-8111-111111111111";
  const server = {
    id: "s",
    name: "tau-mg-1-p-0",
    createdAt: "2026-01-01T00:00:00Z",
    status: "running",
    protected: false,
    rebuildProtected: false,
    labels: {
      "tau-managed": "my-gratitude-runner-v1",
      "tau-repo-id": "1",
      "tau-pool": "p",
      "tau-config": configHash(cfg),
      "tau-slot": "0",
      "tau-instance": instance,
      "tau-runner-name": `tau-mg-1-p-0-${instance}`,
      "tau-state": "ready",
    },
  };
  const h: any = {
    listOwned: vi.fn().mockResolvedValue([server]),
    setProtections: vi.fn(),
    getServer: vi.fn().mockResolvedValue({
      ...server,
      protected: true,
      rebuildProtected: true,
    }),
  };
  await new Executor(h, {} as any, cfg, "1").execute({
    kind: "repair-protection",
    instance,
    reason: "mandatory",
  });
  expect(h.setProtections).toHaveBeenCalled();
});
it("refuses a server identity change during protection verification", async () => {
  const instance = "11111111-1111-4111-8111-111111111111";
  const server = {
    id: "s",
    name: "tau-mg-1-p-0",
    createdAt: "2026-01-01T00:00:00Z",
    status: "running",
    protected: false,
    rebuildProtected: false,
    labels: {
      "tau-managed": "my-gratitude-runner-v1",
      "tau-repo-id": "1",
      "tau-pool": "p",
      "tau-config": configHash(cfg),
      "tau-slot": "0",
      "tau-instance": instance,
      "tau-runner-name": `tau-mg-1-p-0-${instance}`,
      "tau-state": "ready",
    },
  };
  const changed = {
    ...server,
    protected: true,
    rebuildProtected: true,
    labels: { ...server.labels, "tau-slot": "1" },
  };
  const h: any = {
    listOwned: vi.fn().mockResolvedValue([server]),
    setProtections: vi.fn(),
    getServer: vi.fn().mockResolvedValue(changed),
  };
  await expect(
    new Executor(h, {} as any, cfg, "1").execute({
      kind: "repair-protection",
      instance,
      reason: "mandatory",
    }),
  ).rejects.toThrow("complete server ownership fence");
});
it("ignores malformed initial runner registration until bootstrap expiry", async () => {
  const server: any = {
    id: "s",
    name: "tau-mg-1-p-0",
    createdAt: "1970-01-01T00:00:00Z",
    labels: {
      "tau-instance": "i",
      "tau-runner-name": "tau-mg-1-p-0-i",
      "tau-state": "provisioning",
    },
  };
  const malformed = {
    id: "r",
    name: "tau-mg-1-p-0-i",
    busy: false,
    status: "online",
    labels: ["tau-instance-i"],
  };
  await expect(
    (
      new Executor(
        { updateLabels: vi.fn() } as any,
        { listManagedRunners: vi.fn().mockResolvedValue([malformed]) } as any,
        cfg,
        "1",
        { now: () => new Date(2000), sleep: vi.fn() },
      ) as any
    ).markReadyWhenOnline(server),
  ).rejects.toThrow("bootstrap grace expired");
});
it("refuses final pre-unregister runner label changes", async () => {
  const instance = "11111111-1111-4111-8111-111111111111";
  const server = {
    id: "s",
    name: "tau-mg-1-p-0",
    createdAt: "1970-01-01T00:00:00Z",
    status: "running",
    protected: true,
    rebuildProtected: true,
    labels: {
      "tau-managed": "my-gratitude-runner-v1",
      "tau-repo-id": "1",
      "tau-pool": "p",
      "tau-config": configHash(cfg),
      "tau-slot": "0",
      "tau-instance": instance,
      "tau-runner-name": `tau-mg-1-p-0-${instance}`,
      "tau-state": "draining",
      "tau-drain-since": "100",
    },
  };
  const runner = {
    id: "r",
    name: `tau-mg-1-p-0-${instance}`,
    busy: false,
    status: "online",
    labels: [
      "self-hosted",
      "Linux",
      "X64",
      "tau-managed",
      "tau-draining",
      `tau-instance-${instance}`,
    ],
  };
  const h: any = {
    listOwned: vi.fn().mockResolvedValue([server]),
    setProtections: vi.fn(),
    deleteServer: vi.fn(),
  };
  const g: any = {
    listManagedRunners: vi.fn().mockResolvedValue([runner]),
    listActiveMatchingJobs: vi
      .fn()
      .mockResolvedValue({ jobs: [], provenanceComplete: true }),
    getRunner: vi.fn().mockResolvedValue({
      ...runner,
      labels: runner.labels.filter((label) => label !== "tau-managed"),
    }),
    deleteRunner: vi.fn(),
  };
  await expect(
    new Executor(h, g, cfg, "1", {
      now: () => new Date(200_000),
      sleep: vi.fn(),
    }).destroyAfterQuiescence(instance),
  ).rejects.toThrow("complete identity fence");
  expect(g.deleteRunner).not.toHaveBeenCalled();
  expect(h.setProtections).not.toHaveBeenCalled();
});
it("re-fetches server identity and fresh labels before ready persistence", async () => {
  const instance = "11111111-1111-4111-8111-111111111111";
  const name = "tau-mg-1-p-0";
  const original = {
    id: "s",
    name,
    createdAt: "1970-01-01T00:00:00Z",
    status: "running",
    protected: true,
    rebuildProtected: true,
    labels: {
      "tau-managed": "my-gratitude-runner-v1",
      "tau-repo-id": "1",
      "tau-pool": "p",
      "tau-config": configHash(cfg),
      "tau-slot": "0",
      "tau-instance": instance,
      "tau-runner-name": `${name}-${instance}`,
      "tau-state": "provisioning",
      unknown: "old",
    },
  };
  const runner = {
    id: "r",
    name: `${name}-${instance}`,
    busy: false,
    status: "online",
    labels: [
      "self-hosted",
      "Linux",
      "X64",
      "tau-managed",
      "a",
      `tau-instance-${instance}`,
    ],
  };
  const fresh = {
    ...original,
    labels: { ...original.labels, unknown: "fresh" },
  };
  const h: any = {
    getServer: vi.fn().mockResolvedValue(fresh),
    updateLabels: vi.fn(),
  };
  await (
    new Executor(
      h,
      { listManagedRunners: vi.fn().mockResolvedValue([runner]) } as any,
      cfg,
      "1",
      { now: () => new Date(0), sleep: vi.fn() },
    ) as any
  ).markReadyWhenOnline(original);
  expect(h.updateLabels).toHaveBeenCalledWith(
    "s",
    expect.objectContaining({ unknown: "fresh", "tau-state": "ready" }),
  );
  const changed = {
    ...fresh,
    labels: { ...fresh.labels, "tau-config": "foreign" },
  };
  const blocked: any = {
    getServer: vi.fn().mockResolvedValue(changed),
    updateLabels: vi.fn(),
  };
  await expect(
    (
      new Executor(
        blocked,
        { listManagedRunners: vi.fn().mockResolvedValue([runner]) } as any,
        cfg,
        "1",
        { now: () => new Date(0), sleep: vi.fn() },
      ) as any
    ).markReadyWhenOnline(original),
  ).rejects.toThrow("ownership fence");
  expect(blocked.updateLabels).not.toHaveBeenCalled();
});
it.each([
  "before-unprotect",
  "after-unprotect",
])("requires unchanged drain state %s", async (phase) => {
  const instance = "11111111-1111-4111-8111-111111111111";
  const name = "tau-mg-1-p-0";
  const server = {
    id: "s",
    name,
    createdAt: "1970-01-01T00:00:00Z",
    status: "running",
    protected: true,
    rebuildProtected: true,
    labels: {
      "tau-managed": "my-gratitude-runner-v1",
      "tau-repo-id": "1",
      "tau-pool": "p",
      "tau-config": configHash(cfg),
      "tau-slot": "0",
      "tau-instance": instance,
      "tau-runner-name": `${name}-${instance}`,
      "tau-state": "draining",
      "tau-drain-since": "100",
    },
  };
  const changed =
    phase === "before-unprotect"
      ? { ...server, labels: { ...server.labels, "tau-state": "ready" } }
      : {
          ...server,
          protected: false,
          rebuildProtected: false,
          labels: { ...server.labels, "tau-drain-since": "101" },
        };
  const h: any = {
    listOwned: vi.fn().mockResolvedValue([server]),
    getServer:
      phase === "before-unprotect"
        ? vi.fn().mockResolvedValue(changed)
        : vi.fn().mockResolvedValueOnce(server).mockResolvedValueOnce(changed),
    setProtections: vi.fn(),
    deleteServer: vi.fn(),
  };
  const g: any = {
    listManagedRunners: vi.fn().mockResolvedValue([]),
    listActiveMatchingJobs: vi
      .fn()
      .mockResolvedValue({ jobs: [], provenanceComplete: true }),
  };
  await expect(
    new Executor(h, g, cfg, "1", {
      now: () => new Date(200_000),
      sleep: vi.fn(),
    }).destroyAfterQuiescence(instance),
  ).rejects.toThrow("draining state changed");
  expect(h.deleteServer).not.toHaveBeenCalled();
  if (phase === "before-unprotect")
    expect(h.setProtections).not.toHaveBeenCalled();
});
it("fences ownership before calling protection mutation", async () => {
  const instance = "11111111-1111-4111-8111-111111111111";
  const foreign = {
    id: "s",
    name: "tau-mg-1-p-0",
    createdAt: "1970-01-01T00:00:00Z",
    status: "running",
    protected: false,
    rebuildProtected: false,
    labels: {
      "tau-managed": "my-gratitude-runner-v1",
      "tau-repo-id": "1",
      "tau-pool": "other",
      "tau-config": configHash(cfg),
      "tau-slot": "0",
      "tau-instance": instance,
      "tau-runner-name": `tau-mg-1-p-0-${instance}`,
      "tau-state": "ready",
    },
  };
  const h: any = {
    listOwned: vi.fn().mockResolvedValue([foreign]),
    setProtections: vi.fn(),
  };
  await expect(
    new Executor(h, {} as any, cfg, "1").execute({
      kind: "repair-protection",
      instance,
      reason: "repair",
    }),
  ).rejects.toThrow("ownership fence");
  expect(h.setProtections).not.toHaveBeenCalled();
});
it.each([
  "state",
  "epoch",
])("refuses %s changes between drain probes before unregister", async (change) => {
  const instance = "11111111-1111-4111-8111-111111111111";
  const name = "tau-mg-1-p-0";
  const server = {
    id: "s",
    name,
    createdAt: "1970-01-01T00:00:00Z",
    status: "running",
    protected: true,
    rebuildProtected: true,
    labels: {
      "tau-managed": "my-gratitude-runner-v1",
      "tau-repo-id": "1",
      "tau-pool": "p",
      "tau-config": configHash(cfg),
      "tau-slot": "0",
      "tau-instance": instance,
      "tau-runner-name": `${name}-${instance}`,
      "tau-state": "draining",
      "tau-drain-since": "100",
    },
  };
  const changed = {
    ...server,
    labels: {
      ...server.labels,
      ...(change === "state"
        ? { "tau-state": "ready" }
        : { "tau-drain-since": "101" }),
    },
  };
  const runner = {
    id: "r",
    name: `${name}-${instance}`,
    busy: false,
    status: "online",
    labels: [
      "self-hosted",
      "Linux",
      "X64",
      "tau-managed",
      "tau-draining",
      `tau-instance-${instance}`,
    ],
  };
  const h: any = {
    listOwned: vi
      .fn()
      .mockResolvedValueOnce([server])
      .mockResolvedValueOnce([changed]),
    setProtections: vi.fn(),
    deleteServer: vi.fn(),
  };
  const g: any = {
    listManagedRunners: vi.fn().mockResolvedValue([runner]),
    listActiveMatchingJobs: vi
      .fn()
      .mockResolvedValue({ jobs: [], provenanceComplete: true }),
    getRunner: vi.fn(),
    deleteRunner: vi.fn(),
  };
  await expect(
    new Executor(h, g, cfg, "1", {
      now: () => new Date(200_000),
      sleep: vi.fn(),
    }).destroyAfterQuiescence(instance),
  ).rejects.toThrow("draining state changed");
  expect(g.deleteRunner).not.toHaveBeenCalled();
  expect(h.setProtections).not.toHaveBeenCalled();
  expect(h.deleteServer).not.toHaveBeenCalled();
});
it("refuses mark-ready for a provisioning runner with drain-only labels", async () => {
  const instance = "11111111-1111-4111-8111-111111111111";
  const server = {
    id: "s",
    name: "tau-mg-1-p-0",
    createdAt: "2026-01-01T00:00:00Z",
    status: "running",
    protected: true,
    rebuildProtected: true,
    labels: {
      "tau-managed": "my-gratitude-runner-v1",
      "tau-repo-id": "1",
      "tau-pool": "p",
      "tau-config": configHash(cfg),
      "tau-slot": "0",
      "tau-instance": instance,
      "tau-runner-name": `tau-mg-1-p-0-${instance}`,
      "tau-state": "provisioning",
    },
  };
  const runner = {
    id: "r",
    name: `tau-mg-1-p-0-${instance}`,
    busy: false,
    status: "online",
    labels: [
      "self-hosted",
      "Linux",
      "X64",
      "tau-managed",
      "tau-draining",
      `tau-instance-${instance}`,
    ],
  };
  const h: any = {
    listOwned: vi.fn().mockResolvedValue([server]),
    updateLabels: vi.fn(),
  };
  const g: any = { listManagedRunners: vi.fn().mockResolvedValue([runner]) };
  await expect(
    new Executor(h, g, cfg, "1").execute({
      kind: "mark-ready",
      instance,
      reason: "recover",
    }),
  ).rejects.toThrow("runner complete identity fence failed");
  expect(h.updateLabels).not.toHaveBeenCalled();
});
it("performs provisioning preflight before registration token or create", async () => {
  const h: any = {
    listOwned: vi.fn().mockResolvedValue([]),
    preflight: vi.fn().mockRejectedValue(new Error("unsafe preflight")),
    createServer: vi.fn(),
  };
  const g: any = { createRegistrationToken: vi.fn() };
  await expect(new Executor(h, g, cfg, "1").ensureSlot(0)).rejects.toThrow(
    "unsafe preflight",
  );
  expect(g.createRegistrationToken).not.toHaveBeenCalled();
  expect(h.createServer).not.toHaveBeenCalled();
});
