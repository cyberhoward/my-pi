import { normalizeInventory } from "./inventory.js";
import type { ReconcilePlan, RunnerManagerConfig, Snapshot } from "./types.js";

const seconds = (date: string, now: Date) =>
  (now.getTime() - new Date(date).getTime()) / 1000;
const epochAge = (value: string | undefined, now: Date) =>
  value ? now.getTime() / 1000 - Number(value) : 0;
export function matchesPool(labels: string[], required: string[]): boolean {
  const set = new Set(labels.map((x) => x.toLowerCase()));
  return required.every((x) => set.has(x.toLowerCase()));
}
export function planReconcile(
  snapshot: Snapshot,
  config: RunnerManagerConfig,
  now: Date,
): ReconcilePlan {
  const instances = normalizeInventory(
    snapshot.servers,
    snapshot.runners,
    config,
    snapshot.repoId,
    now,
  );
  const operations: ReconcilePlan["operations"] = [];
  const warnings: string[] = [];
  if (!snapshot.provenanceComplete) {
    for (const item of instances) {
      if (
        item.server &&
        item.state !== "foreign" &&
        (!item.server.protected || !item.server.rebuildProtected)
      )
        operations.push({
          kind: "repair-protection",
          instance: item.instance,
          reason: "protection repair is mandatory despite ambiguous demand",
        });
      if (item.state === "foreign")
        operations.push({
          kind: "report-foreign",
          instance: item.instance,
          reason: "ambiguous demand inventory remains report-only",
        });
    }
    return {
      desiredCapacity: 0,
      operations,
      warnings: ["ambiguous demand provenance: report only"],
    };
  }
  const matching = snapshot.jobs.filter((job) =>
    matchesPool(job.labels, config.pool.routingLabels),
  );
  const owned = instances.filter((x) => x.state !== "foreign");
  const busy = owned.filter(
    (x) => x.runner?.busy && x.state !== "draining",
  ).length;
  const unassigned = matching.filter((job) => !job.runnerId);
  const queued = unassigned.filter(
    (job) =>
      ["queued", "requested", "pending"].includes(job.status) &&
      seconds(job.createdAt, now) >= config.pool.scaleUpDelaySeconds,
  ).length;
  const managedRunnerIds = new Set(
    instances.filter((item) => item.state !== "foreign" && item.runner).map((item) => item.runner!.id),
  );
  const assignedToManaged = matching.filter((job) => job.runnerId && managedRunnerIds.has(job.runnerId)).length;
  const desiredCapacity = Math.min(
    config.pool.maxSize,
    Math.max(assignedToManaged, busy + queued),
  );
  const occupied = new Set(
    instances.filter((x) => x.slot >= 0).map((x) => x.slot),
  );
  for (
    let n = owned.filter((x) => x.state !== "draining" && x.server).length;
    n < desiredCapacity;
    n++
  ) {
    const slot = Array.from({ length: config.pool.maxSize }, (_, i) => i).find(
      (i) => !occupied.has(i),
    );
    if (slot === undefined) break;
    occupied.add(slot);
    operations.push({
      kind: "ensure-slot",
      slot,
      reason: "trusted queued capacity demand",
    });
  }
  const retention = unassigned.length > 0 || assignedToManaged > 0 || busy > 0;
  for (const item of instances) {
    if (item.state === "foreign" || item.slot >= config.pool.maxSize) {
      operations.push({
        kind: "report-foreign",
        instance: item.instance,
        reason:
          "malformed, mismatched, or out-of-range inventory is report-only",
      });
      continue;
    }
    if (item.state === "stale-runner") {
      operations.push(
        item.runner?.busy || item.runner?.status !== "offline"
          ? {
              kind: "refuse",
              instance: item.instance,
              reason: "stale runner is busy or still online",
            }
          : {
              kind: "unregister",
              instance: item.instance,
              reason: "stale idle offline runner",
            },
      );
      continue;
    }
    if (!item.server) continue;
    if (
      item.state === "draining" &&
      item.server.labels["tau-state"] !== "draining"
    ) {
      operations.push({
        kind: "begin-drain",
        instance: item.instance,
        reason: "recover routing-drained partial transition",
      });
      continue;
    }
    if (
      item.server.labels["tau-state"] === "provisioning" &&
      item.runner?.status === "online"
    )
      operations.push({
        kind: "mark-ready",
        instance: item.instance,
        reason: "recover online runner ready-label transition",
      });
    if (!item.server.protected || !item.server.rebuildProtected)
      operations.push({
        kind: "repair-protection",
        instance: item.instance,
        reason: "owned server protections are incomplete",
      });
    const labels = item.server.labels;
    const lifetime = seconds(item.server.createdAt, now);
    if (
      (item.state === "provisioning" || item.state === "orphan-server") &&
      lifetime < config.pool.bootstrapGraceSeconds
    )
      continue;
    if (item.runner?.busy) {
      if (lifetime >= config.pool.maximumLifetimeSeconds) {
        operations.push({
          kind: "begin-drain",
          instance: item.instance,
          reason: "maximum lifetime reached while busy",
        });
        warnings.push(
          `runner ${item.instance} remains busy past maximum lifetime`,
        );
      }
      continue;
    }
    if (
      item.state !== "draining" &&
      (item.state === "provisioning" || item.state === "orphan-server")
    ) {
      operations.push({
        kind: "begin-drain",
        instance: item.instance,
        reason: "bootstrap grace expired without runner",
      });
      continue;
    }
    if (
      item.state !== "draining" &&
      lifetime >= config.pool.maximumLifetimeSeconds
    ) {
      operations.push({
        kind: "begin-drain",
        instance: item.instance,
        reason: "maximum eligibility lifetime reached",
      });
      continue;
    }
    if (retention && item.state !== "draining") {
      if (labels["tau-idle-since"])
        operations.push({
          kind: "clear-idle",
          instance: item.instance,
          reason: "demand returned",
        });
      continue;
    }
    if (!labels["tau-idle-since"] && item.state !== "draining") {
      operations.push({
        kind: "set-idle",
        instance: item.instance,
        reason: "no retention demand",
      });
      continue;
    }
    const idleExpired =
      epochAge(labels["tau-idle-since"], now) >= config.pool.idleGraceSeconds;
    if (item.state !== "draining" && idleExpired) {
      operations.push({
        kind: "begin-drain",
        instance: item.instance,
        reason: "idle, lifetime, or bootstrap grace expired",
      });
      continue;
    }
    if (item.state === "draining") {
      const drainAge = epochAge(labels["tau-drain-since"], now);
      operations.push(
        drainAge >= config.pool.drainQuiescenceSeconds
          ? {
              kind: "probe-drain",
              instance: item.instance,
              reason: "quiescence elapsed",
            }
          : {
              kind: "retain-draining",
              instance: item.instance,
              reason: "waiting for 65s+ multi-tick quiescence",
            },
      );
    }
  }
  return {
    desiredCapacity,
    operations: operations.sort(
      (a, b) =>
        (a.slot ?? 99) - (b.slot ?? 99) ||
        (a.instance ?? "").localeCompare(b.instance ?? ""),
    ),
    warnings,
  };
}
