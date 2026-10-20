import {
  configHash,
  parseLifecycleEpoch,
  runnerName,
  slotName,
} from "./identity.js";
import type {
  CloudServer,
  GitHubRunner,
  RunnerManagerConfig,
} from "./types.js";
export interface Instance {
  instance: string;
  slot: number;
  server?: CloudServer;
  runner?: GitHubRunner;
  state:
    | "healthy"
    | "provisioning"
    | "stale-runner"
    | "orphan-server"
    | "draining"
    | "foreign";
}
const identityFromRunner = (runner: GitHubRunner): string | undefined => {
  const labels = runner.labels.filter((label) =>
    label.startsWith("tau-instance-"),
  );
  return labels.length === 1
    ? labels[0].slice("tau-instance-".length)
    : undefined;
};
export function hasExpectedRunnerLabels(
  labels: string[],
  instance: string,
  config: RunnerManagerConfig,
  draining: boolean,
): boolean {
  const actual = new Set(labels.map((label) => label.toLowerCase()));
  const expected = new Set(
    [
      "self-hosted",
      "linux",
      "x64",
      "tau-managed",
      `tau-instance-${instance}`,
      ...(draining ? ["tau-draining"] : config.pool.routingLabels),
    ].map((label) => label.toLowerCase()),
  );
  return (
    actual.size === expected.size &&
    [...expected].every((label) => actual.has(label))
  );
}
function validRunner(
  runner: GitHubRunner,
  instance: string,
  repoId: string,
  config: RunnerManagerConfig,
  draining: boolean,
): { slot: number } | undefined {
  if (!hasExpectedRunnerLabels(runner.labels, instance, config, draining))
    return undefined;
  for (let slot = 0; slot < config.pool.maxSize; slot++)
    if (runner.name === runnerName(repoId, config.pool.name, slot, instance, config.identity.slotPrefix))
      return { slot };
  return undefined;
}
function validEpoch(value: string | undefined, now: Date): boolean {
  try {
    parseLifecycleEpoch(value, now, "lifecycle timestamp");
    return true;
  } catch {
    return false;
  }
}
export function validServerIdentity(
  server: CloudServer,
  instance: string,
  repoId: string,
  config: RunnerManagerConfig,
  now: Date,
): { slot: number } | undefined {
  const slot = Number(server.labels["tau-slot"]);
  if (!Number.isInteger(slot) || slot < 0 || slot >= config.pool.maxSize)
    return undefined;
  const expected = slotName(repoId, config.pool.name, slot, config.identity.slotPrefix);
  const policyLabelsValid =
    config.tier.id === "legacy-x86" ||
    (server.labels["tau-tier"] === config.tier.id &&
      Object.entries(config.inventory.classificationLabels).every(
        ([key, value]) => server.labels[key] === value,
      ));
  if (
    !policyLabelsValid ||
    server.labels["tau-managed"] !== config.inventory.managedLabelValue ||
    server.labels["tau-repo-id"] !== repoId ||
    server.labels["tau-pool"] !== config.pool.name ||
    server.labels["tau-config"] !== configHash(config) ||
    server.labels["tau-instance"] !== instance ||
    server.name !== expected ||
    server.labels["tau-runner-name"] !==
      runnerName(repoId, config.pool.name, slot, instance, config.identity.slotPrefix) ||
    !["provisioning", "ready", "draining"].includes(
      server.labels["tau-state"] ?? "",
    ) ||
    (server.labels["tau-idle-since"] !== undefined &&
      !validEpoch(server.labels["tau-idle-since"], now)) ||
    (server.labels["tau-drain-since"] !== undefined &&
      !validEpoch(server.labels["tau-drain-since"], now)) ||
    (server.labels["tau-state"] === "draining" &&
      !validEpoch(server.labels["tau-drain-since"], now))
  )
    return undefined;
  return { slot };
}
export function normalizeInventory(
  servers: CloudServer[],
  runners: GitHubRunner[],
  config: RunnerManagerConfig,
  repoId: string,
  now: Date,
): Instance[] {
  const serverGroups = new Map<string, CloudServer[]>();
  const runnerGroups = new Map<string, GitHubRunner[]>();
  const foreign: Instance[] = [];
  for (const server of servers) {
    const identity = server.labels["tau-instance"];
    if (!identity) {
      foreign.push({
        instance: `foreign-server-${server.id}`,
        slot: -1,
        server,
        state: "foreign",
      });
      continue;
    }
    serverGroups.set(identity, [...(serverGroups.get(identity) ?? []), server]);
  }
  for (const runner of runners) {
    const identity = identityFromRunner(runner);
    if (!identity) {
      foreign.push({
        instance: `foreign-runner-${runner.id}`,
        slot: -1,
        runner,
        state: "foreign",
      });
      continue;
    }
    runnerGroups.set(identity, [...(runnerGroups.get(identity) ?? []), runner]);
  }
  const result = [...foreign];
  const identities = new Set([...serverGroups.keys(), ...runnerGroups.keys()]);
  for (const instance of identities) {
    const groupedServers = serverGroups.get(instance) ?? [];
    const groupedRunners = runnerGroups.get(instance) ?? [];
    if (groupedServers.length > 1 || groupedRunners.length > 1) {
      result.push({
        instance,
        slot: -1,
        server: groupedServers[0],
        runner: groupedRunners[0],
        state: "foreign",
      });
      continue;
    }
    const server = groupedServers[0];
    const runner = groupedRunners[0];
    const serverIdentity = server
      ? validServerIdentity(server, instance, repoId, config, now)
      : undefined;
    const serverIsDraining = server?.labels["tau-state"] === "draining";
    const runnerIsDraining =
      !!runner &&
      hasExpectedRunnerLabels(runner.labels, instance, config, true);
    const runnerIdentity = runner
      ? validRunner(
          runner,
          instance,
          repoId,
          config,
          serverIsDraining || runnerIsDraining,
        )
      : undefined;
    if (
      (server && !serverIdentity) ||
      (runner && !runnerIdentity) ||
      (serverIdentity &&
        runnerIdentity &&
        serverIdentity.slot !== runnerIdentity.slot)
    ) {
      result.push({ instance, slot: -1, server, runner, state: "foreign" });
      continue;
    }
    const slot = serverIdentity?.slot ?? runnerIdentity?.slot ?? -1;
    if (!server) result.push({ instance, slot, runner, state: "stale-runner" });
    else if (!runner)
      result.push({
        instance,
        slot,
        server,
        state:
          server.labels["tau-state"] === "provisioning"
            ? "provisioning"
            : server.labels["tau-state"] === "draining"
              ? "draining"
              : "orphan-server",
      });
    else
      result.push({
        instance,
        slot,
        server,
        runner,
        state: serverIsDraining || runnerIsDraining ? "draining" : "healthy",
      });
  }
  return result.sort(
    (a, b) => a.slot - b.slot || a.instance.localeCompare(b.instance),
  );
}
