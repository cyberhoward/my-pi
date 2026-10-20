import { createHash, randomUUID } from "node:crypto";
import { SafeRefusal } from "./types.js";

const labelValue = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
export function validateIdentity(value: string, name: string): string {
  if (!labelValue.test(value))
    throw new SafeRefusal(`${name} has unsafe characters`);
  return value;
}
export function slotName(
  repoId: string,
  pool: string,
  slot: number,
  slotPrefix = "tau-mg",
): string {
  const name =
    `${validateIdentity(slotPrefix, "slotPrefix")}-${validateIdentity(repoId, "repoId")}-${validateIdentity(pool, "pool")}-${slot}`.toLowerCase();
  if (name.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name))
    throw new SafeRefusal("invalid RFC-1123 slot name");
  return name;
}
export function runnerName(
  repoId: string,
  pool: string,
  slot: number,
  instance: string,
  slotPrefix = "tau-mg",
): string {
  validateIdentity(instance, "instance");
  const base = slotName(repoId, pool, slot, slotPrefix);
  const full = `${base}-${instance}`;
  if (full.length <= 63) return full;
  const suffix = createHash("sha256").update(full).digest("hex").slice(0, 16);
  const shortenedBase = base
    .slice(0, 63 - suffix.length - 1)
    .replace(/-+$/, "");
  return validateIdentity(`${shortenedBase}-${suffix}`, "runnerName");
}
export function newInstanceId(): string {
  return randomUUID();
}
function effectiveConfig(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const config = value as Record<string, unknown>;
  if (!("repository" in config && "pool" in config && "hcloud" in config))
    return value;
  const tier = config.tier as Record<string, unknown> | undefined;
  return {
    repository: config.repository,
    ...(config.identity && (config.identity as { apiVersion?: string }).apiVersion === "runner-manager.pi.dev/v1alpha1" && "organization" in config
      ? { organization: config.organization }
      : {}),
    pool: config.pool,
    hcloud: config.hcloud,
    runner: config.runner,
    inventory: config.inventory,
    tier: tier
      ? { id: tier.id, family: tier.family, architecture: tier.architecture }
      : undefined,
  };
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value))
    return value
      .map(canonical)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "sources")
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
export function configHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(effectiveConfig(value))))
    .digest("hex")
    .slice(0, 12);
}
export function parseLifecycleEpoch(
  value: string | undefined,
  now: Date,
  name: string,
): number {
  if (value === undefined || !/^\d+$/.test(value))
    throw new SafeRefusal(`${name} must be a digits-only epoch`);
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 0 ||
    parsed > Math.floor(now.getTime() / 1000) + 300
  )
    throw new SafeRefusal(`${name} is outside the safe epoch range`);
  return parsed;
}
export const ownershipSelector = (
  repoId: string,
  managedLabelValue = "my-gratitude-runner-v1",
) =>
  `tau-managed=${validateIdentity(managedLabelValue, "managedLabelValue")},tau-repo-id=${validateIdentity(repoId, "repoId")}`;
