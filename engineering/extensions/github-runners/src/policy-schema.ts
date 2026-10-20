import { parseDocument } from "yaml";
import { z } from "zod";
import type { LoadedPolicy, RunnerManagerConfig } from "./types.js";
import { UsageError } from "./types.js";

const MAX_POLICY_BYTES = 256 * 1024;
const legacyApiVersion = "runner-manager.graditas.app/v1alpha1";
const genericApiVersion = "runner-manager.pi.dev/v1alpha1";
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/);
const label = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/);
const envName = z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/);
const positive = z.number().finite().positive();
const nullableText = z.string().min(1).nullable();
const legacyTierKeys = ["cx-shared-x86", "cx-large-x86", "cpx-shared-x86", "cax-shared-arm64", "ccx-dedicated-x86"];
const officialSource = z.string().url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && ["hetzner.com", "www.hetzner.com", "docs.hetzner.com", "docs.hetzner.cloud"].includes(url.hostname);
}, "source must be an official Hetzner HTTPS URL");
const tierSchema = z.object({
  family: z.enum(["CX", "CPX", "CAX", "CCX"]),
  cpuClass: z.enum(["shared", "dedicated"]),
  performanceClass: z.enum(["cost-optimized", "regular", "general-purpose"]),
  architecture: z.enum(["x86", "arm64"]),
  serverTypes: z.array(z.string().regex(/^[a-z][a-z0-9]+$/)).min(1),
  githubRoutingLabels: z.array(label).min(1).max(8),
  sources: z.array(officialSource).min(1),
}).strict();
const policySchema = z.object({
  apiVersion: z.enum([legacyApiVersion, genericApiVersion]),
  kind: z.literal("RunnerInfrastructurePolicy"),
  metadata: z.object({ name: id }).strict(),
  spec: z.object({
    mutation: z.object({ enabled: z.boolean() }).strict(),
    credentials: z.object({ hcloudTokenEnv: envName, githubTokenEnv: envName }).strict(),
    coordination: z.object({ lockPath: z.string().startsWith("/").max(4096) }).strict(),
    github: z.object({
      repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
      organization: z.object({
        name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/),
        repositories: z.array(z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)).min(1).max(100),
        runnerGroupId: z.number().int().positive(),
        runnerGroupName: z.string().min(1).max(100),
      }).strict().optional(),
    }).strict(),
    pool: z.object({
      name: id,
      selectedTier: id,
      maxSize: z.number().int().min(1).max(3),
      costs: z.object({ maxKnownHourlyPoolEur: positive.max(5), maxKnownEligibilityEur: positive.max(100) }).strict(),
      timing: z.object({
        scaleUpDelaySeconds: z.number().int().min(15).max(300),
        idleGraceSeconds: z.number().int().min(60).max(86400),
        bootstrapGraceSeconds: z.number().int().min(60).max(3600),
        drainQuiescenceSeconds: z.number().int().min(65).max(3600),
        drainProbeSeconds: z.number().int().min(1).max(60),
        maximumLifetimeSeconds: z.number().int().min(900).max(86400),
      }).strict(),
    }).strict(),
    runner: z.object({ architecture: z.literal("x64"), version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/).nullable(), archiveSha256: nullableText }).strict(),
    hetzner: z.object({
      serverType: z.string().regex(/^[a-z][a-z0-9]+$/).nullable(),
      location: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/).nullable(),
      image: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/),
      firewallId: z.string().regex(/^\d+$/).nullable(),
      networkId: z.null(),
      sshKeyIds: z.array(z.string().regex(/^\d+$/)),
      publicNetwork: z.object({ ipv4: z.literal(true), ipv6: z.literal(true) }).strict(),
    }).strict(),
    inventory: z.object({ managedLabelValue: z.enum(["my-gratitude-runner-v1", "pi-github-runners-v1"]), classificationLabels: z.record(label, label) }).strict(),
    tierCatalog: z.record(id, tierSchema),
  }).strict(),
}).strict();
const truth = {
  CX: ["shared", "cost-optimized", "x86"],
  CPX: ["shared", "regular", "x86"],
  CAX: ["shared", "cost-optimized", "arm64"],
  CCX: ["dedicated", "general-purpose", "x86"],
} as const;
const reservedRouting = new Set(["self-hosted", "linux", "x64", "tau-managed", "tau-draining"]);

function yamlObject(text: string): unknown {
  if (Buffer.byteLength(text, "utf8") > MAX_POLICY_BYTES) throw new UsageError("policy exceeds 256 KiB limit");
  const document = parseDocument(text, { schema: "core", strict: true, uniqueKeys: true });
  if (document.errors.length || document.warnings.length) throw new UsageError(`policy YAML is invalid: ${[...document.errors, ...document.warnings].map((issue) => issue.message).join("; ")}`);
  let value: unknown;
  try { value = document.toJS({ maxAliasCount: 0 }); } catch (error) { throw new UsageError(`policy YAML is invalid: ${error instanceof Error ? error.message : "unknown error"}`); }
  const rejectMerge = (item: unknown): void => {
    if (!item || typeof item !== "object") return;
    if (Array.isArray(item)) { item.forEach(rejectMerge); return; }
    if (Object.hasOwn(item, "<<")) throw new UsageError("policy YAML merge keys are not allowed");
    Object.values(item).forEach(rejectMerge);
  };
  rejectMerge(value);
  return value;
}
const unique = (values: string[], name: string): string[] => {
  const normalized = values.map((value) => value.toLowerCase()).sort();
  if (new Set(normalized).size !== normalized.length) throw new UsageError(`${name} must be unique`);
  return normalized;
};

export function loadPolicyText(text: string): LoadedPolicy {
  const result = policySchema.safeParse(yamlObject(text));
  if (!result.success) throw new UsageError(`policy schema is invalid: ${result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
  const { spec, apiVersion } = result.data;
  const legacy = apiVersion === legacyApiVersion;
  if (legacy && spec.github.organization) throw new UsageError("organization scope is supported only by the generic apiVersion");
  if (spec.github.organization) {
    const organization = spec.github.organization;
    const repositories = unique(organization.repositories, "organization repositories");
    if (!repositories.every((repository) => repository.split("/")[0] === organization.name.toLowerCase())) throw new UsageError("organization repositories must belong to the configured organization");
    if (!repositories.includes(spec.github.repository.toLowerCase())) throw new UsageError("primary repository must be in organization repositories");
  }
  if (spec.inventory.managedLabelValue !== (legacy ? "my-gratitude-runner-v1" : "pi-github-runners-v1")) throw new UsageError("inventory managed label does not match identity profile");
  if (spec.credentials.hcloudTokenEnv === spec.credentials.githubTokenEnv) throw new UsageError("credential environment variable names must be distinct");
  if (legacy && Object.keys(spec.tierCatalog).sort().join(",") !== legacyTierKeys.slice().sort().join(",")) throw new UsageError(`tier catalog must define exactly: ${legacyTierKeys.join(",")}`);
  for (const [tierId, tier] of Object.entries(spec.tierCatalog)) {
    const expected = truth[tier.family];
    if (tier.cpuClass !== expected[0] || tier.performanceClass !== expected[1] || tier.architecture !== expected[2]) throw new UsageError(`${tier.family} tier does not match hard-coded truth table`);
    if (tier.serverTypes.some((type) => !type.startsWith(tier.family.toLowerCase()))) throw new UsageError(`${tierId} server type must use the ${tier.family.toLowerCase()} prefix`);
    unique(tier.serverTypes, `${tierId} serverTypes`);
    unique(tier.sources, `${tierId} sources`);
  }
  const selected = spec.tierCatalog[spec.pool.selectedTier];
  if (!selected) throw new UsageError("selected tier does not exist in tier catalog");
  if (selected.architecture !== "x86") throw new UsageError(`tier ${selected.family}/${selected.architecture} is incompatible with runner architecture x64; ARM runner support is not implemented`);
  if (spec.hetzner.serverType && !selected.serverTypes.includes(spec.hetzner.serverType)) throw new UsageError("Hetzner server type is not in the selected tier");
  const routingLabels = unique(selected.githubRoutingLabels, "routing labels");
  if (routingLabels.some((value) => reservedRouting.has(value) || value.startsWith("tau-instance-"))) throw new UsageError("routing label collides with a reserved runner label");
  const classificationEntries = Object.entries(spec.inventory.classificationLabels);
  if (classificationEntries.length < 1 || classificationEntries.length > 10 || classificationEntries.some(([key]) => key.startsWith("tau-") || /(token|secret|password|credential|authorization)/i.test(key))) throw new UsageError("classification labels must contain 1-10 non-reserved, non-secret keys");
  const t = spec.pool.timing;
  if (t.drainProbeSeconds >= t.drainQuiescenceSeconds || t.idleGraceSeconds > t.maximumLifetimeSeconds || t.bootstrapGraceSeconds > t.maximumLifetimeSeconds) throw new UsageError("policy timing limits are unsafe");
  if (spec.mutation.enabled && (!spec.hetzner.serverType || !spec.hetzner.location || !spec.hetzner.firewallId || !spec.runner.version || !spec.runner.archiveSha256)) throw new UsageError("mutation-enabled policy requires all live provisioning fields");
  if (spec.runner.archiveSha256 && !/^[a-f0-9]{64}$/i.test(spec.runner.archiveSha256)) throw new UsageError("runner archiveSha256 must be exact SHA-256");
  const selectedTier: RunnerManagerConfig["tier"] = { id: spec.pool.selectedTier, family: selected.family, architecture: selected.architecture, serverTypes: [...selected.serverTypes].sort(), sources: [...selected.sources].sort() };
  const config: RunnerManagerConfig = {
    identity: { apiVersion, slotPrefix: legacy ? "tau-mg" : "pi-ghr" },
    repository: spec.github.repository,
    organization: spec.github.organization ? {
      name: spec.github.organization.name,
      repositories: unique(spec.github.organization.repositories, "organization repositories"),
      runnerGroupId: spec.github.organization.runnerGroupId,
      runnerGroupName: spec.github.organization.runnerGroupName,
    } : undefined,
    pool: { name: spec.pool.name, routingLabels, maxSize: spec.pool.maxSize, scaleUpDelaySeconds: t.scaleUpDelaySeconds, idleGraceSeconds: t.idleGraceSeconds, bootstrapGraceSeconds: t.bootstrapGraceSeconds, drainQuiescenceSeconds: t.drainQuiescenceSeconds, drainProbeSeconds: t.drainProbeSeconds, maximumLifetimeSeconds: t.maximumLifetimeSeconds, maxKnownHourlyPoolCostEur: spec.pool.costs.maxKnownHourlyPoolEur, maxKnownEligibilityCostEur: spec.pool.costs.maxKnownEligibilityEur },
    hcloud: { serverType: spec.hetzner.serverType ?? "", location: spec.hetzner.location ?? "", image: spec.hetzner.image, firewallId: spec.hetzner.firewallId ?? "", networkId: undefined, sshKeyIds: [...spec.hetzner.sshKeyIds].sort(), publicNet: { ipv4: true, ipv6: true } },
    coordination: { lockPath: spec.coordination.lockPath },
    runner: { architecture: "x64", version: spec.runner.version ?? "", archiveSha256: spec.runner.archiveSha256 ?? "" },
    tier: selectedTier,
    inventory: { managedLabelValue: spec.inventory.managedLabelValue, classificationLabels: Object.fromEntries(classificationEntries.sort(([a], [b]) => a.localeCompare(b))) },
  };
  return { config, credentials: spec.credentials, mutationEnabled: spec.mutation.enabled, selectedTier };
}
