import { normalizeInventory } from "./inventory.js";
import { type PlanOperation, type ReconcilePlan, type RunnerManagerConfig, type Snapshot, SafeRefusal } from "./types.js";

export function planDestroyAll(snapshot: Snapshot, config: RunnerManagerConfig, now: Date): ReconcilePlan {
  if (!snapshot.provenanceComplete) throw new SafeRefusal("active demand provenance is incomplete");
  const operations: PlanOperation[] = [];
  for (const item of normalizeInventory(snapshot.servers, snapshot.runners, config, snapshot.repoId, now)) {
    const claimsPool = item.server?.labels["tau-repo-id"] === snapshot.repoId && item.server.labels["tau-pool"] === config.pool.name;
    const claimsName = item.runner?.name.startsWith(`${config.identity.slotPrefix}-${snapshot.repoId}-${config.pool.name}-`) === true;
    if (item.state === "foreign") {
      if (claimsPool || claimsName) throw new SafeRefusal("bulk destroy ownership is ambiguous or mismatched");
      continue;
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item.instance)) throw new SafeRefusal("bulk destroy ownership lacks an exact UUID");
    if (item.server) {
      const draining = item.server.labels["tau-state"] === "draining";
      operations.push({ kind: draining ? "probe-drain" : "begin-drain", instance: item.instance, reason: draining ? "operator requested bulk safe destroy after drain" : "operator requested bulk first safe destroy drain tick", destructive: draining });
    } else if (item.runner) {
      if (item.runner.busy || item.runner.status !== "offline") throw new SafeRefusal("unbacked runner is online or busy; refusing bulk teardown");
      operations.push({ kind: "unregister", instance: item.instance, reason: "operator requested bulk stale offline registration cleanup", destructive: true });
    }
  }
  return { desiredCapacity: 0, warnings: [], operations };
}
