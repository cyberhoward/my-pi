import { describe, expect, it } from "vitest";
import { parseConfig } from "../config.js";
import { configHash, slotName } from "../identity.js";
import { normalizeInventory } from "../inventory.js";

const config = parseConfig({
  repository: "owner/repo",
  pool: {
    name: "small",
    routingLabels: ["small"],
    maxSize: 1,
    scaleUpDelaySeconds: 45,
    idleGraceSeconds: 60,
    bootstrapGraceSeconds: 60,
    drainQuiescenceSeconds: 65,
    drainProbeSeconds: 5,
    maximumLifetimeSeconds: 3600,
    maxKnownHourlyPoolCostEur: 1,
    maxKnownEligibilityCostEur: 1,
  },
  hcloud: { publicNet: { ipv4: true, ipv6: true } },
  coordination: { lockPath: "/tmp/runner.lock" },
  runner: {},
});
const repoId = "1";
const instance = "instance";
const server = {
  id: "server",
  name: slotName(repoId, config.pool.name, 0),
  createdAt: "2026-01-01T00:00:00Z",
  status: "running",
  protected: true,
  rebuildProtected: true,
  labels: {
    "tau-managed": "my-gratitude-runner-v1",
    "tau-repo-id": repoId,
    "tau-pool": config.pool.name,
    "tau-config": configHash(config),
    "tau-slot": "0",
    "tau-instance": instance,
    "tau-runner-name": `${slotName(repoId, config.pool.name, 0)}-${instance}`,
    "tau-state": "ready",
  },
};
const runner = (labels: string[]) => ({
  id: "runner",
  name: `${server.name}-${instance}`,
  busy: false,
  status: "online",
  labels,
});
const identity = [
  "self-hosted",
  "Linux",
  "X64",
  "tau-managed",
  `tau-instance-${instance}`,
];

describe("runner routing fence", () => {
  it("marks a runner missing an approved routing label as foreign", () => {
    expect(
      normalizeInventory(
        [server],
        [runner(identity)],
        config,
        repoId,
        new Date(),
      ),
    ).toMatchObject([{ state: "foreign" }]);
  });
  it("marks a runner with an unexpected routing label as foreign", () => {
    expect(
      normalizeInventory(
        [server],
        [runner([...identity, "small", "unapproved"])],
        config,
        repoId,
        new Date(),
      ),
    ).toMatchObject([{ state: "foreign" }]);
  });
  it("allows only identity labels plus tau-draining while draining", () => {
    const draining = {
      ...server,
      labels: {
        ...server.labels,
        "tau-state": "draining",
        "tau-drain-since": "1",
      },
    };
    expect(
      normalizeInventory(
        [draining],
        [runner([...identity, "tau-draining"])],
        config,
        repoId,
        new Date(2_000),
      ),
    ).toMatchObject([{ state: "draining" }]);
  });
});

it("treats missing tier classification labels as foreign", () => {
  const classified = {
    ...config,
    tier: {
      id: "cx-shared-x86",
      family: "CX" as const,
      architecture: "x86" as const,
      serverTypes: ["cx23"],
      sources: [],
    },
    inventory: {
      managedLabelValue: "my-gratitude-runner-v1",
      classificationLabels: { environment: "ci" },
    },
  };
  expect(
    normalizeInventory(
      [server],
      [runner([...identity, "small"])],
      classified,
      repoId,
      new Date(),
    ),
  ).toMatchObject([{ state: "foreign" }]);
});
