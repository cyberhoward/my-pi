#!/usr/bin/env node
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { parseArgs } from "./args.js";
import {
  assertLiveConfig,
  assertMutationAllowed,
  loadPolicy,
} from "./config.js";
import { Executor } from "./executor.js";
import { GitHubClient } from "./github.js";
import { HCloudClient } from "./hcloud.js";
import { configHash, slotName } from "./identity.js";
import { validServerIdentity } from "./inventory.js";
import { FilesystemMutationLock } from "./lock.js";
import { observe } from "./manager.js";
import { planReconcile } from "./policy.js";
import type { KnownCost } from "./ports.js";
import { Redactor } from "./redaction.js";
import {
  type CloudServer,
  type PlanOperation,
  type ReconcilePlan,
  ProviderFailure,
  SafeRefusal,
  Secret,
  UsageError,
} from "./types.js";

const usage =
  "Usage: runner-manager <list|status|ensure|reconcile|drain|destroy> [--apply] [--json] [--capacity N] [--instance UUID]";
export function orderOperations(operations: PlanOperation[]): PlanOperation[] {
  const rank = (operation: PlanOperation) =>
    operation.kind === "repair-protection"
      ? 0
      : operation.kind === "begin-drain"
        ? 1
        : operation.kind === "probe-drain" || operation.kind === "unregister"
          ? 2
          : operation.kind === "ensure-slot"
            ? 4
            : 3;
  return [...operations].sort((a, b) => rank(a) - rank(b));
}
export function occupiedSlotsForPool(
  servers: CloudServer[],
  poolName: string,
): Set<number> {
  return new Set(
    servers
      .filter((server) => server.labels["tau-pool"] === poolName)
      .map((server) => Number(server.labels["tau-slot"]))
      .filter((slot) => Number.isInteger(slot) && slot >= 0),
  );
}
export interface CliIo {
  stdout(value: string): void;
  stderr(value: string): void;
}
export function planFingerprint(plan: ReconcilePlan): string {
  const operations = [...plan.operations].map((operation) => ({
    kind: operation.kind, instance: operation.instance, slot: operation.slot,
    destructive: operation.destructive === true, reason: operation.reason,
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const canonical = { desiredCapacity: plan.desiredCapacity, operations, warnings: [...plan.warnings].sort() };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
export async function runCli(
  input: string[],
  env: NodeJS.ProcessEnv,
  io: CliIo,
  fetcher: typeof fetch = fetch,
  options: { expectedPlanFingerprint?: string } = {},
): Promise<number> {
  const redactor = new Redactor();
  try {
    const argv = [...input];
    if (argv[0] === "--") argv.shift();
    if (["--help", "-h"].includes(argv[0] ?? "")) {
      io.stdout(usage);
      return 0;
    }
    const args = parseArgs(argv);
    const policy = await loadPolicy(args.configPath);
    const config = policy.config;
    const mutating = ["ensure", "reconcile", "drain", "destroy"].includes(
      args.command,
    );
    if (mutating && args.apply) {
      if (!policy.mutationEnabled)
        throw new SafeRefusal(
          "policy mutation.enabled must be true for --apply",
        );
      assertMutationAllowed(args, env);
    }
    const hcloudRaw = env[policy.credentials.hcloudTokenEnv];
    const githubRaw = env[policy.credentials.githubTokenEnv];
    if (!hcloudRaw || !githubRaw)
      throw new SafeRefusal(
        "provider credentials must be injected for inventory operations",
      );
    const hcloudToken = new Secret(hcloudRaw);
    const githubToken = new Secret(githubRaw);
    redactor.register(hcloudToken);
    redactor.register(githubToken);
    const hcloud = new HCloudClient(fetcher, hcloudToken);
    const github = new GitHubClient(
      fetcher,
      config.repository,
      githubToken,
      redactor,
      config.organization,
    );
    const lock = new FilesystemMutationLock();
    const run = async (applied: boolean) => {
      const state = await observe(hcloud, github, config);
      if (args.command === "list")
        return { command: "list", applied: false, ...state.snapshot };
      let plan = planReconcile(state.snapshot, config, new Date());
      if (args.command === "status")
        return { command: "status", applied: false, plan, ...state.snapshot };
      if (args.command === "ensure" && args.capacity !== undefined) {
        if (
          !Number.isInteger(args.capacity) ||
          args.capacity < 0 ||
          args.capacity > config.pool.maxSize
        )
          throw new UsageError("capacity exceeds configured maximum");
        const occupied = occupiedSlotsForPool(
          state.snapshot.servers,
          config.pool.name,
        );
        const operations: PlanOperation[] = [];
        for (let slot = 0; slot < args.capacity; slot++)
          if (!occupied.has(slot))
            operations.push({
              kind: "ensure-slot",
              slot,
              reason: "explicit bounded capacity",
            });
        plan = {
          ...plan,
          desiredCapacity: args.capacity,
          operations: [
            ...plan.operations.filter(
              (operation) => operation.kind === "repair-protection",
            ),
            ...operations,
          ],
        };
      }
      if (args.command === "ensure")
        plan = {
          ...plan,
          warnings: [],
          operations: plan.operations.filter((operation) =>
            ["ensure-slot", "repair-protection"].includes(operation.kind),
          ),
        };
      if (args.command === "drain") {
        const target = state.snapshot.servers.find(
          (server) => server.labels["tau-instance"] === args.instance,
        );
        const slot = Number(target?.labels["tau-slot"]);
        if (
          !target ||
          target.labels["tau-repo-id"] !== state.repoId ||
          target.labels["tau-pool"] !== config.pool.name ||
          target.labels["tau-config"] !== configHash(config) ||
          !validServerIdentity(
            target,
            args.instance!,
            state.repoId,
            config,
            new Date(),
          ) ||
          !Number.isInteger(slot) ||
          target.name !== slotName(state.repoId, config.pool.name, slot, config.identity.slotPrefix)
        )
          throw new SafeRefusal("owned target instance was not found");
        plan = {
          desiredCapacity: plan.desiredCapacity,
          warnings: [],
          operations: [
            {
              kind: "begin-drain",
              instance: args.instance,
              reason: "operator requested drain",
            },
          ],
        };
      }
      if (args.command === "destroy") {
        const target = state.snapshot.servers.find(
          (server) => server.labels["tau-instance"] === args.instance,
        );
        const slot = Number(target?.labels["tau-slot"]);
        if (
          !target ||
          target.labels["tau-repo-id"] !== state.repoId ||
          target.labels["tau-pool"] !== config.pool.name ||
          target.labels["tau-config"] !== configHash(config) ||
          !validServerIdentity(
            target,
            args.instance!,
            state.repoId,
            config,
            new Date(),
          ) ||
          !Number.isInteger(slot) ||
          target.name !== slotName(state.repoId, config.pool.name, slot, config.identity.slotPrefix)
        )
          throw new SafeRefusal("owned target instance was not found");
        const draining = target.labels["tau-state"] === "draining";
        plan = {
          desiredCapacity: plan.desiredCapacity,
          warnings: [],
          operations: [
            {
              kind: draining ? "probe-drain" : "begin-drain",
              instance: args.instance,
              reason: draining
                ? "operator requested safe destroy after drain"
                : "operator requested first safe destroy drain tick",
              destructive: draining,
            },
          ],
        };
      }
      const createsCapacity = plan.operations.some(
        (operation) => operation.kind === "ensure-slot",
      );
      let preflight: KnownCost | undefined;
      if (createsCapacity) {
        assertLiveConfig(config);
        preflight = await hcloud.preflight(config);
      }
      if (applied) {
        if (options.expectedPlanFingerprint && options.expectedPlanFingerprint !== planFingerprint(plan))
          throw new SafeRefusal("reconciliation plan changed since confirmation; re-confirm the current plan");
        const executor = new Executor(hcloud, github, config, state.repoId);
        const ordered = orderOperations(plan.operations);
        for (const operation of ordered) await executor.execute(operation);
      }
      return {
        command: args.command,
        applied,
        plan,
        ...(preflight ? { preflight } : {}),
      };
    };
    let result: unknown;
    if (mutating && args.apply) {
      result = await lock.withLock(config.coordination.lockPath, () =>
        run(true),
      );
    } else result = await run(false);
    io.stdout(redactor.stringify(result));
    const warnings =
      result && typeof result === "object" && "plan" in result
        ? (result as { plan?: { warnings?: string[] } }).plan?.warnings
        : undefined;
    return warnings?.length ? 5 : 0;
  } catch (error) {
    const exitCode =
      error instanceof UsageError
        ? 2
        : error instanceof SafeRefusal
          ? 3
          : error instanceof ProviderFailure
            ? 4
            : 4;
    io.stderr(
      redactor.stringify({
        error: error instanceof Error ? error.message : "unknown failure",
        exitCode,
      }),
    );
    return exitCode;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const code = await runCli(process.argv.slice(2), process.env, {
    stdout: (value) => console.log(value),
    stderr: (value) => console.error(value),
  });
  process.exitCode = code;
}
