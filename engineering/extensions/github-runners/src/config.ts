import { type FileHandle, open } from "node:fs/promises";
import { extname } from "node:path";
import { loadPolicyText } from "./policy-schema.js";
import { type RunnerManagerConfig, SafeRefusal, UsageError } from "./types.js";

const record = (value: unknown, name: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new UsageError(`${name} must be an object`);
  return value as Record<string, unknown>;
};
const positive = (value: unknown, name: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    throw new UsageError(`${name} must be positive`);
  return value;
};
const text = (value: unknown, name: string, allowEmpty = false): string => {
  if (typeof value !== "string" || (!allowEmpty && !value.trim()))
    throw new UsageError(
      `${name} must be a string${allowEmpty ? "" : " and is required"}`,
    );
  return value;
};
const optionalText = (value: unknown, name: string): string | undefined =>
  value === undefined ? undefined : text(value, name);
const stringArray = (
  value: unknown,
  name: string,
  allowEmpty = true,
): string[] => {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0) ||
    value.some((item) => typeof item !== "string" || !item)
  )
    throw new UsageError(
      `${name} must be ${allowEmpty ? "a" : "a nonempty"} string array`,
    );
  return value as string[];
};
const boolean = (value: unknown, name: string): boolean => {
  if (typeof value !== "boolean")
    throw new UsageError(`${name} must be boolean`);
  return value;
};
export function parseConfig(value: unknown): RunnerManagerConfig {
  const v = record(value, "configuration");
  const p = record(v.pool, "pool");
  const h = record(v.hcloud, "hcloud");
  const c = record(v.coordination, "coordination");
  const r = record(v.runner, "runner");
  const publicNet = record(h.publicNet, "hcloud.publicNet");
  const maxSize = p.maxSize ?? 1;
  if (
    !Number.isInteger(maxSize) ||
    (maxSize as number) < 1 ||
    (maxSize as number) > 3
  )
    throw new UsageError("maxSize must be between 1 and 3");
  const quiescence = positive(
    p.drainQuiescenceSeconds,
    "drainQuiescenceSeconds",
  );
  if (quiescence < 65)
    throw new UsageError("drainQuiescenceSeconds must be at least 65");
  const repository = text(v.repository, "repository");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
    throw new UsageError("repository must be exact owner/name");
  return {
    identity: {
      apiVersion: "runner-manager.graditas.app/v1alpha1",
      slotPrefix: "tau-mg",
    },
    repository,
    pool: {
      name: text(p.name, "pool.name"),
      routingLabels: stringArray(p.routingLabels, "pool.routingLabels", false),
      maxSize: maxSize as number,
      scaleUpDelaySeconds: positive(
        p.scaleUpDelaySeconds ?? 45,
        "scaleUpDelaySeconds",
      ),
      idleGraceSeconds: positive(p.idleGraceSeconds, "idleGraceSeconds"),
      bootstrapGraceSeconds: positive(
        p.bootstrapGraceSeconds,
        "bootstrapGraceSeconds",
      ),
      drainQuiescenceSeconds: quiescence,
      drainProbeSeconds: positive(p.drainProbeSeconds, "drainProbeSeconds"),
      maximumLifetimeSeconds: positive(
        p.maximumLifetimeSeconds,
        "maximumLifetimeSeconds",
      ),
      maxKnownHourlyPoolCostEur: positive(
        p.maxKnownHourlyPoolCostEur,
        "maxKnownHourlyPoolCostEur",
      ),
      maxKnownEligibilityCostEur: positive(
        p.maxKnownEligibilityCostEur,
        "maxKnownEligibilityCostEur",
      ),
    },
    hcloud: {
      serverType: text(h.serverType ?? "", "hcloud.serverType", true),
      location: text(h.location ?? "", "hcloud.location", true),
      image: text(h.image ?? "ubuntu-24.04", "hcloud.image"),
      firewallId: text(h.firewallId ?? "", "hcloud.firewallId", true),
      networkId: optionalText(h.networkId, "hcloud.networkId"),
      sshKeyIds: stringArray(h.sshKeyIds ?? [], "hcloud.sshKeyIds"),
      publicNet: {
        ipv4: boolean(publicNet.ipv4, "hcloud.publicNet.ipv4"),
        ipv6: boolean(publicNet.ipv6, "hcloud.publicNet.ipv6"),
      },
    },
    coordination: { lockPath: text(c.lockPath, "coordination.lockPath") },
    runner: {
      architecture: "x64",
      version: text(r.version ?? "", "runner.version", true),
      archiveSha256: text(r.archiveSha256 ?? "", "runner.archiveSha256", true),
    },
    tier: {
      id: "legacy-x86",
      family: "CX",
      architecture: "x86",
      serverTypes: h.serverType
        ? [text(h.serverType, "hcloud.serverType")]
        : [],
      sources: [],
    },
    inventory: {
      managedLabelValue: "my-gratitude-runner-v1",
      classificationLabels: {},
    },
  };
}
export function assertLiveConfig(config: RunnerManagerConfig): void {
  for (const [name, value] of [
    ["serverType", config.hcloud.serverType],
    ["location", config.hcloud.location],
    ["firewallId", config.hcloud.firewallId],
    ["runner.version", config.runner.version],
    ["runner.archiveSha256", config.runner.archiveSha256],
  ])
    if (!value)
      throw new SafeRefusal(`${name} is required for live provisioning`);
  if (config.hcloud.networkId)
    throw new SafeRefusal("private network is not approved");
  if (!config.hcloud.publicNet.ipv4 || !config.hcloud.publicNet.ipv6)
    throw new SafeRefusal(
      "live provisioning requires approved dual-stack public networking",
    );
  if (!/^[a-f0-9]{64}$/i.test(config.runner.archiveSha256))
    throw new SafeRefusal("runner archiveSha256 must be exact SHA-256");
}
export async function loadPolicy(path: string) {
  if (extname(path).toLowerCase() === ".json")
    throw new UsageError(
      "JSON policies are no longer supported; use runner-manager.policy.yaml",
    );
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.alloc(256 * 1024 + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 256 * 1024)
      throw new UsageError("policy exceeds 256 KiB limit");
    return loadPolicyText(buffer.subarray(0, bytesRead).toString("utf8"));
  } catch (error) {
    if (error instanceof UsageError) throw error;
    throw new UsageError(
      `policy could not be read: ${error instanceof Error ? error.message : "unknown"}`,
    );
  } finally {
    await handle?.close();
  }
}
