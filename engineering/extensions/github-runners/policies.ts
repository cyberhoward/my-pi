import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import type { RepositoryBinding } from "./repository.js";
import type { RunnerSettings, RunnerSize } from "./settings.js";
import { loadPolicy } from "./src/config.js";
import type { RunnerManagerConfig } from "./src/types.js";
export type MaterializedPolicy = { name: string; path: string; sourcePath: string };

const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
const shaPattern = /^[a-f0-9]{64}$/i;

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function safeId(value: string): string { return `pi-${hash(value).slice(0, 20)}`; }
function validSize(size: RunnerSize): void {
  if (!idPattern.test(size.name) || !Array.isArray(size.labels) || !size.labels.length || size.labels.some((label) => !idPattern.test(label))) throw new Error("runner size has invalid name or labels");
  if (!Number.isInteger(size.quantity) || size.quantity < 0 || size.quantity > 3) throw new Error("runner quantity must be between 0 and 3");
  if (!/^(cx|cpx|ccx)[0-9]+$/.test(size.serverType)) throw new Error("server type must be an x86 CX, CPX, or CCX type");
  if (!idPattern.test(size.location) || !idPattern.test(size.image) || !/^\d+$/.test(size.firewallId)) throw new Error("runner size has invalid Hetzner fields");
  if (!idPattern.test(size.runnerVersion) || !shaPattern.test(size.runnerArchiveSha256)) throw new Error("runner size requires an x64 runner version and SHA-256");
  if (!(size.maxHourlyCostEur > 0) || !(size.maxEligibilityCostEur > 0)) throw new Error("runner size requires positive cost limits");
}
function repositories(values: string[]): string[] {
  const normalized = values.map((value) => value.toLowerCase());
  if (new Set(normalized).size !== normalized.length) throw new Error("repository allowlist must not contain duplicates");
  return normalized.sort((left, right) => left.localeCompare(right));
}

export function assertPolicyScope(binding: RepositoryBinding, settings: RunnerSettings, config: RunnerManagerConfig): void {
  const active = binding.repository.toLowerCase();
  if (settings.mode === "local") {
    if (config.organization) throw new Error("local runner settings do not allow organization policies");
    if (config.repository.toLowerCase() !== active) throw new Error("local runner policy must use the active repository");
    return;
  }
  const expected = settings.organization;
  if (!expected) throw new Error("global runner settings require an organization");
  const allowed = repositories(expected.repositories);
  if (!allowed.includes(active)) throw new Error("active repository is not in the organization allowlist");
  if (!allowed.every((repository) => repository.split("/")[0] === expected.name.toLowerCase())) throw new Error("global repositories must belong to the configured organization");
  const actual = config.organization;
  if (!actual) throw new Error("global runner settings require an organization policy");
  if (actual.name.toLowerCase() !== expected.name.toLowerCase()) throw new Error("organization policy does not match configured organization");
  if (actual.runnerGroupId !== expected.runnerGroupId || actual.runnerGroupName !== expected.runnerGroupName) throw new Error("organization policy runner group does not match settings");
  const policyAllowed = repositories(actual.repositories);
  if (policyAllowed.length !== allowed.length || policyAllowed.some((repository, index) => repository !== allowed[index])) throw new Error("organization policy repositories must exactly match the configured allowlist");
  if (!allowed.includes(config.repository.toLowerCase())) throw new Error("organization policy primary repository must be in the configured allowlist");
}

export function generatedMaximumLifetimeSeconds(standbyMinutes: number): number {
  return Math.min(86400, Math.max(900, standbyMinutes * 60 + 65));
}

function family(serverType: string): ["CX" | "CPX" | "CCX", "shared" | "dedicated", "cost-optimized" | "regular" | "general-purpose"] {
  if (serverType.startsWith("cx")) return ["CX", "shared", "cost-optimized"];
  if (serverType.startsWith("cpx")) return ["CPX", "shared", "regular"];
  return ["CCX", "dedicated", "general-purpose"];
}

export async function materializePolicies(binding: RepositoryBinding, rawSettings: RunnerSettings): Promise<{ policies: MaterializedPolicy[]; cleanup: () => Promise<void> }> {
  const settings = rawSettings;
  const legacy = settings.policies;
  const sizes = settings.sizes;
  if (legacy.length && sizes.length) throw new Error("configure either legacy policies or generated runner sizes, not both");
  const directory = await mkdtemp(join(tmpdir(), "pi-runner-policies-"));
  const cleanup = async () => { await rm(directory, { recursive: true, force: true }); };
  try {
    if (legacy.length) {
      const policies = await Promise.all(legacy.map(async (sourcePath, index) => {
        const bytes = await readFile(sourcePath);
        if (bytes.byteLength > 256 * 1024) throw new Error("policy exceeds 256 KiB limit");
        const path = join(directory, `${index}.yaml`);
        await writeFile(path, bytes, { mode: 0o600 });
        const loaded = await loadPolicy(path);
        assertPolicyScope(binding, settings, loaded.config);
        return { name: `legacy-${index + 1}`, path, sourcePath };
      }));
      return { policies, cleanup };
    }
    if (!sizes.length || !sizes.some((size) => size.quantity > 0)) return { policies: [], cleanup };
    const global = settings.mode === "global";
    if (global && (!settings.organization || !idPattern.test(settings.organization.name) || !Number.isInteger(settings.organization.runnerGroupId) || settings.organization.runnerGroupId < 1 || !idPattern.test(settings.organization.runnerGroupName))) throw new Error("global runner pool requires an organization and runner group");
    const allowed = global ? settings.organization!.repositories : [binding.repository];
    if (!allowed.length || allowed.some((repository) => !repoPattern.test(repository))) throw new Error("configured repositories are invalid");
    if (global && !allowed.every((repository) => repository.split("/")[0].toLowerCase() === settings.organization!.name.toLowerCase())) throw new Error("global repositories must belong to the configured organization");
    if (!global && allowed[0].toLowerCase() !== binding.repository.toLowerCase()) throw new Error("local runner pool must use the active repository");
    const normalizedAllowed = repositories(allowed);
    const repository = normalizedAllowed[0];
    const organizationName = settings.organization?.name.toLowerCase();
    const scope = global ? `org:${organizationName}:${normalizedAllowed.join(",")}:${settings.organization!.runnerGroupId}` : `repo:${binding.repository.toLowerCase()}`;
    const lockDirectory = join(homedir(), ".pi", "agent", "github-runners-locks");
    await mkdir(lockDirectory, { recursive: true, mode: 0o700 });
    const standby = settings.standbyMinutes ?? 15;
    if (!Number.isInteger(standby) || standby < 1 || standby > 1440) throw new Error("standbyMinutes must be an integer between 1 and 1440");
    const policies: MaterializedPolicy[] = [];
    for (const size of sizes) {
      if (size.quantity === 0) continue;
      validSize(size);
      const [tierFamily, cpuClass, performanceClass] = family(size.serverType);
      const pool = safeId(`${scope}:${size.name}`);
      const document = {
        apiVersion: "runner-manager.pi.dev/v1alpha1", kind: "RunnerInfrastructurePolicy", metadata: { name: pool },
        spec: {
          mutation: { enabled: settings.automationEnabled === true }, credentials: { hcloudTokenEnv: "HCLOUD_TOKEN", githubTokenEnv: "RUNNER_MANAGER_GITHUB_TOKEN" },
          coordination: { lockPath: join(lockDirectory, `${safeId(`${scope}:${size.name}`)}.lock`) },
          github: { repository, ...(global ? { organization: { name: organizationName!, repositories: normalizedAllowed, runnerGroupId: settings.organization!.runnerGroupId, runnerGroupName: settings.organization!.runnerGroupName } } : {}) },
          pool: { name: pool, selectedTier: "selected", maxSize: size.quantity, costs: { maxKnownHourlyPoolEur: size.maxHourlyCostEur, maxKnownEligibilityEur: size.maxEligibilityCostEur }, timing: { scaleUpDelaySeconds: 15, idleGraceSeconds: standby * 60, bootstrapGraceSeconds: 60, drainQuiescenceSeconds: 65, drainProbeSeconds: 5, maximumLifetimeSeconds: generatedMaximumLifetimeSeconds(standby) } },
          runner: { architecture: "x64", version: size.runnerVersion, archiveSha256: size.runnerArchiveSha256 },
          hetzner: { serverType: size.serverType, location: size.location, image: size.image, firewallId: size.firewallId, networkId: null, sshKeyIds: [], publicNetwork: { ipv4: true, ipv6: true } },
          inventory: { managedLabelValue: "pi-github-runners-v1", classificationLabels: { workload: "github-actions" } },
          tierCatalog: { selected: { family: tierFamily, cpuClass, performanceClass, architecture: "x86", serverTypes: [size.serverType], githubRoutingLabels: size.labels, sources: ["https://docs.hetzner.com/cloud/general-information/faq/"] } },
        },
      };
      const path = join(directory, `${safeId(size.name)}.yaml`);
      await writeFile(path, stringify(document), { mode: 0o600 });
      const loaded = await loadPolicy(path);
      assertPolicyScope(binding, settings, loaded.config);
      policies.push({ name: size.name, path, sourcePath: settings.sourcePath });
    }
    return { policies, cleanup };
  } catch (error) { await cleanup(); throw error; }
}
