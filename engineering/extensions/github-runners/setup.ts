import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { materializePolicies } from "./policies.js";
import type { RepositoryBinding } from "./repository.js";
import { loadSettings, saveSettings, type RunnerSettings, type RunnerSize } from "./settings.js";
import type { SetupCatalog, SetupPolicyPreview, SetupQuote, SetupRelease, SetupServices } from "./setup-types.js";
import { loadPolicy } from "./src/config.js";
import { configHash } from "./src/identity.js";

type SetupContext = {
  hasUI?: boolean;
  mode?: string;
  ui: Pick<ExtensionUIContext, "select" | "input" | "confirm" | "notify">;
};
type Snapshot = Map<string, Buffer | undefined>;
type Discovery = { catalog?: SetupCatalog; release?: SetupRelease; credentials: boolean };
type DiscoveryResult = { kind: "next"; discovery: Discovery } | { kind: "back" } | { kind: "cancel" };
type Step = "next" | "back" | "cancel";
type Stage = "scope" | "discovery" | "runtime" | "pools" | "review";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function notify(ctx: SetupContext, message: string, type: "info" | "warning" | "error" = "info"): void {
  ctx.ui.notify?.(message, type);
}

function list(value: string): string[] {
  return [...new Set(value.split(/[\n,]/).map((item) => item.trim().toLowerCase()).filter(Boolean))].sort();
}

function validPin(size: RunnerSize): boolean {
  return /^\d+\.\d+\.\d+$/.test(size.runnerVersion) && /^[a-f0-9]{64}$/i.test(size.runnerArchiveSha256);
}

function validPositive(size: RunnerSize): boolean {
  return Number.isInteger(size.quantity)
    && size.quantity > 0
    && size.quantity <= 3
    && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(size.name)
    && size.labels.length > 0
    && size.labels.every((label) => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(label) && !["self-hosted", "linux", "x64"].includes(label))
    && /^(cx|cpx|ccx)\d+$/.test(size.serverType)
    && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(size.location)
    && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(size.image)
    && /^[1-9]\d*$/.test(size.firewallId)
    && validPin(size)
    && Number.isFinite(size.maxHourlyCostEur)
    && size.maxHourlyCostEur > 0
    && Number.isFinite(size.maxEligibilityCostEur)
    && size.maxEligibilityCostEur > 0;
}

function manualSize(): RunnerSize {
  return {
    name: "",
    labels: [],
    quantity: 0,
    serverType: "",
    location: "",
    image: "",
    firewallId: "",
    runnerVersion: "",
    runnerArchiveSha256: "",
    maxHourlyCostEur: 0,
    maxEligibilityCostEur: 0,
  };
}

function poolLabel(size: RunnerSize): string {
  return `${size.name || "unnamed"}: ${size.quantity} runner${size.quantity === 1 ? "" : "s"} · ${size.serverType || "unresolved"} · ${size.location || "no location"} · ${size.labels.join(", ") || "no custom routing labels"}`;
}

function exact(value: number): string {
  return Number.isFinite(value) ? String(value) : "unavailable";
}

function ceiling(value: number): string {
  return (Math.ceil((value + Number.EPSILON) * 10_000) / 10_000).toFixed(4);
}

function quoteText(quotes: SetupQuote[]): string {
  return quotes.length
    ? quotes.map((quote) => `Fresh quote: €${exact(quote.perRunnerHourlyEur)}/runner-hour; €${exact(quote.hourlyPoolEur)}/hour pool; €${exact(quote.maximumEligibilityEur)} maximum eligible lifetime; max lifetime ${quote.maximumLifetimeSeconds}s. VAT and variable traffic are excluded.`).join("\n")
    : "Fresh estimates are unavailable; accepted caps remain ceilings, not quotes.";
}

function scopeSummary(settings: RunnerSettings, binding: RepositoryBinding): string {
  return settings.mode === "global"
    ? `Shared organization ${settings.organization?.name || "not configured"}; exact allowlist: ${settings.organization?.repositories.join(", ") || "none"}; runner group: ${settings.organization?.runnerGroupName || "none"} (#${settings.organization?.runnerGroupId || 0}).`
    : `Repository-only path: ${binding.repository}`;
}

async function bytes(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function snapshot(root: string, home: string): Promise<Snapshot> {
  const paths = [resolve(root, ".pi/github-runners.json"), resolve(home, ".pi/agent/github-runners.json")];
  return new Map(await Promise.all(paths.map(async (path) => [path, await bytes(path)] as const)));
}

async function unchanged(before: Snapshot): Promise<boolean> {
  for (const [path, value] of before) {
    const current = await bytes(path);
    if (current === undefined || value === undefined ? current !== value : !current.equals(value)) return false;
  }
  return true;
}

async function discover(ctx: SetupContext, settings: RunnerSettings, services: SetupServices): Promise<DiscoveryResult> {
  for (;;) {
    let credentials;
    try {
      credentials = await services.credentials(settings);
    } catch (error) {
      notify(ctx, `Credential discovery failed: ${error instanceof Error ? error.message : "unknown error"}. Tokens are never collected or saved; configuration-only save remains available.`, "warning");
      const action = await ctx.ui.select("Credentials before discovery", ["Retry after configuring credentials", "Continue configuration-only", "Back", "Cancel setup"]);
      if (action === "Retry after configuring credentials") continue;
      if (action === "Continue configuration-only") return { kind: "next", discovery: { credentials: false } };
      return action === "Back" ? { kind: "back" } : { kind: "cancel" };
    }
    if (!credentials.hcloud || !credentials.github) {
      notify(ctx, `${credentials.guidance.join("\n") || "Credentials are unavailable."}\nTokens are never collected or saved. Configuration-only save remains available.`, "warning");
      const action = await ctx.ui.select("Credentials before discovery", ["Retry after configuring credentials", "Continue configuration-only", "Back", "Cancel setup"]);
      if (action === "Retry after configuring credentials") continue;
      if (action === "Continue configuration-only") return { kind: "next", discovery: { credentials: false } };
      return action === "Back" ? { kind: "back" } : { kind: "cancel" };
    }
    try {
      await services.validateScope(settings);
    } catch (error) {
      notify(ctx, `Credential read access or scope validation failed: ${error instanceof Error ? error.message : "unknown error"}. This is not proof of write access; activation performs fresh validation. You can continue configuring.`, "warning");
    }
    let catalog: SetupCatalog | undefined;
    let release: SetupRelease | undefined;
    try {
      catalog = await services.catalog();
    } catch (error) {
      notify(ctx, `Infrastructure catalog is unavailable: ${error instanceof Error ? error.message : "unknown error"}.`, "warning");
    }
    try {
      release = await services.release();
    } catch (error) {
      notify(ctx, `Official runner release digest is unavailable: ${error instanceof Error ? error.message : "unknown error"}. Existing exact pins are retained.`, "warning");
    }
    if (catalog && catalog.serverTypes.some((type) => /^(cx|cpx|ccx)\d+$/.test(type.name) && type.locations.length) && catalog.images.length && catalog.firewalls.length) {
      return { kind: "next", discovery: { catalog, release, credentials: true } };
    }
    const action = await ctx.ui.select("Discovery needs attention", ["Retry discovery", "Continue configuration-only", "Back", "Cancel setup"]);
    if (action === "Retry discovery") continue;
    if (action === "Continue configuration-only") return { kind: "next", discovery: { release, credentials: true } };
    return action === "Back" ? { kind: "back" } : { kind: "cancel" };
  }
}

async function chooseScope(ctx: SetupContext, settings: RunnerSettings, binding: RepositoryBinding): Promise<Step> {
  const selected = await ctx.ui.select("1 of 5 — Runner scope", [`Repository pool for ${binding.repository}`, "Shared organization pool", "Cancel setup"]);
  if (!selected || selected === "Cancel setup") return "cancel";
  if (selected.startsWith("Repository")) {
    settings.mode = "local";
    settings.organization = undefined;
    return "next";
  }
  const name = await ctx.ui.input("GitHub organization name (exact owner)", settings.organization?.name ?? "");
  if (name === undefined) return "back";
  const repositories = await ctx.ui.input("Exact allowed repositories (owner/repo, comma separated; include this repository)", settings.organization?.repositories.join(", ") ?? binding.repository);
  if (repositories === undefined) return "back";
  const groupName = await ctx.ui.input("GitHub runner group name", settings.organization?.runnerGroupName ?? "");
  if (groupName === undefined) return "back";
  const groupId = await ctx.ui.input("GitHub runner group ID", String(settings.organization?.runnerGroupId ?? ""));
  if (groupId === undefined) return "back";
  const allowed = list(repositories);
  if (!name.trim() || !allowed.includes(binding.repository.toLowerCase()) || !allowed.every((repository) => repository.split("/")[0] === name.trim().toLowerCase()) || !groupName.trim() || !/^[1-9]\d*$/.test(groupId)) {
    notify(ctx, "Organization scope requires an exact allowlist containing this repository and complete runner-group details.", "error");
    return "back";
  }
  settings.mode = "global";
  settings.organization = { name: name.trim().toLowerCase(), repositories: allowed, runnerGroupName: groupName.trim(), runnerGroupId: Number(groupId) };
  return "next";
}

async function chooseStandby(ctx: SetupContext, settings: RunnerSettings, legacy: boolean): Promise<Step> {
  const suffix = legacy ? "; this does not rewrite legacy YAML timing fields" : "; idle runners expire only while an enabled controller is running";
  const value = await ctx.ui.input(`Idle expiry in minutes (1–1440${suffix})`, String(settings.standbyMinutes));
  if (value === undefined) return "back";
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 1440) {
    notify(ctx, "Idle expiry must be an integer from 1 to 1440.", "error");
    return "back";
  }
  settings.standbyMinutes = Number(value);
  return "next";
}

async function runtime(ctx: SetupContext, settings: RunnerSettings, legacy: boolean): Promise<Step> {
  for (;;) {
    const action = await ctx.ui.select("Runtime settings", ["Edit idle expiry", "Edit polling interval", legacy ? "Continue to review" : "Continue to pools", "Back", "Cancel setup"]);
    if (!action || action === "Cancel setup") return "cancel";
    if (action.startsWith("Continue")) return "next";
    if (action === "Back") return "back";
    if (action === "Edit idle expiry") {
      await chooseStandby(ctx, settings, legacy);
      continue;
    }
    const value = await ctx.ui.input("Polling interval in seconds (5–3600)", String(settings.pollIntervalSeconds));
    if (value === undefined) continue;
    if (!/^\d+$/.test(value) || Number(value) < 5 || Number(value) > 3600) {
      notify(ctx, "Polling interval must be an integer from 5 to 3600.", "error");
      continue;
    }
    settings.pollIntervalSeconds = Number(value);
  }
}

function poolDetails(size: RunnerSize): string {
  return `${poolLabel(size)}\nInfrastructure: ${size.serverType || "unset"}/${size.location || "unset"}/${size.image || "unset"}; firewall ${size.firewallId || "unset"}\nPin: ${size.runnerVersion || "unset"} ${size.runnerArchiveSha256 || "unset"}\nAccepted caps: €${exact(size.maxHourlyCostEur)}/hour, €${exact(size.maxEligibilityCostEur)}/eligible lifetime. These are per-pool ceilings, not an account-wide spending limit.`;
}

async function editInfrastructure(ctx: SetupContext, size: RunnerSize, discovery: Discovery): Promise<void> {
  if (!discovery.catalog) {
    const fields: (keyof RunnerSize)[] = ["serverType", "location", "image", "firewallId"];
    const prompts = ["Hetzner x86 server type", "Hetzner location", "System image", "Existing restrictive firewall ID"];
    for (let index = 0; index < fields.length; index++) {
      const value = await ctx.ui.input(prompts[index], size[fields[index]] as string);
      if (value === undefined) return;
      size[fields[index]] = value.trim() as never;
    }
    return;
  }
  const types = discovery.catalog.serverTypes.filter((type) => /^(cx|cpx|ccx)\d+$/.test(type.name) && type.locations.length);
  const picked = await ctx.ui.select("Hetzner server type", types.map((type) => `${type.name} — ${type.cores} vCPU, ${type.memoryGb} GB RAM, ${type.diskGb} GB disk`));
  const type = types.find((item) => picked?.startsWith(`${item.name} —`));
  if (!type) return;
  const location = await ctx.ui.select("Hetzner location", type.locations);
  if (!location) return;
  const image = await ctx.ui.select("System image", discovery.catalog.images.map((item) => `${item.name} — ${item.description}`));
  if (!image) return;
  const firewall = await ctx.ui.select("Existing restrictive firewall (outbound only; no inbound access needed)", discovery.catalog.firewalls.map((item) => `${item.id} — ${item.name}`));
  if (!firewall) return;
  size.serverType = type.name;
  size.location = location;
  size.image = image.split(" — ")[0];
  size.firewallId = firewall.split(" — ")[0];
}

async function editPool(ctx: SetupContext, size: RunnerSize, discovery: Discovery, services: SetupServices, standby: number): Promise<"remove" | Step> {
  for (;;) {
    const action = await ctx.ui.select(`Pool editor\n${poolDetails(size)}`, ["Edit name", "Edit routing labels", "Edit quantity", "Edit infrastructure", "Update or edit runner pin", "Quote and set cost caps", "Done", "Remove pool", "Back", "Cancel setup"]);
    if (!action || action === "Cancel setup") return "cancel";
    if (action === "Done") return "next";
    if (action === "Remove pool") return "remove";
    if (action === "Back") return "back";
    if (action === "Edit name") {
      const value = await ctx.ui.input("Pool name (unique; generated policy identifier)", size.name);
      if (value !== undefined) size.name = value.trim();
      continue;
    }
    if (action === "Edit routing labels") {
      const value = await ctx.ui.input("Custom workflow routing labels (comma separated; all are required)", size.labels.join(", "));
      if (value !== undefined) size.labels = list(value);
      continue;
    }
    if (action === "Edit quantity") {
      const value = await ctx.ui.select("Maximum simultaneous runner capacity (0–3; not always-on capacity)", ["0", "1", "2", "3"]);
      if (value !== undefined) {
        size.quantity = Number(value);
        if (!size.quantity) {
          size.maxHourlyCostEur = 0;
          size.maxEligibilityCostEur = 0;
        }
      }
      continue;
    }
    if (action === "Edit infrastructure") {
      await editInfrastructure(ctx, size, discovery);
      continue;
    }
    if (action === "Update or edit runner pin") {
      const choices = [validPin(size) ? `Keep existing verified pin ${size.runnerVersion}` : "Enter manually verified version and SHA-256", ...(discovery.release ? [`Update to verified stable Linux x64 ${discovery.release.version}`] : [])];
      const picked = await ctx.ui.select("Runner archive pin", choices);
      if (picked?.startsWith("Update") && discovery.release) {
        size.runnerVersion = discovery.release.version;
        size.runnerArchiveSha256 = discovery.release.sha256;
      } else if (picked?.startsWith("Enter")) {
        const version = await ctx.ui.input("Runner version (digits.digits.digits)", size.runnerVersion);
        if (version === undefined) continue;
        const sha = await ctx.ui.input("Runner archive SHA-256", size.runnerArchiveSha256);
        if (sha !== undefined) {
          size.runnerVersion = version.trim();
          size.runnerArchiveSha256 = sha.trim();
        }
      }
      continue;
    }
    if (size.quantity === 0) {
      notify(ctx, "Quantity zero is a disabled draft and requires no infrastructure, pin, or cost caps.");
      continue;
    }
    if (!discovery.catalog || !validPositive({ ...size, maxHourlyCostEur: 1, maxEligibilityCostEur: 1 })) {
      notify(ctx, "Complete valid name, custom labels, type, location, image, firewall, and exact runner pin before requesting a live quote.", "warning");
      continue;
    }
    try {
      const quote = await services.quote(size, standby);
      notify(ctx, quoteText([quote]));
      const hourly = await ctx.ui.input("Accepted hourly pool cap in EUR", ceiling(quote.hourlyPoolEur));
      if (hourly === undefined) continue;
      const lifetime = await ctx.ui.input("Accepted eligible-lifetime cap in EUR", ceiling(quote.maximumEligibilityEur));
      if (lifetime === undefined) continue;
      const hourlyCap = Number(hourly);
      const lifetimeCap = Number(lifetime);
      if (Number.isFinite(hourlyCap) && hourlyCap > 0 && hourlyCap >= quote.hourlyPoolEur && Number.isFinite(lifetimeCap) && lifetimeCap > 0 && lifetimeCap >= quote.maximumEligibilityEur) {
        size.maxHourlyCostEur = hourlyCap;
        size.maxEligibilityCostEur = lifetimeCap;
      } else {
        notify(ctx, "Accepted caps must be finite positive values no lower than the fresh live quote.", "error");
      }
    } catch (error) {
      notify(ctx, `Quote failed: ${error instanceof Error ? error.message : "unknown error"}. Caps remain ceilings; estimate unavailable.`, "warning");
    }
  }
}

function duplicatePoolNames(sizes: RunnerSize[]): boolean {
  const names = sizes.map((size) => size.name.trim().toLowerCase()).filter(Boolean);
  return new Set(names).size !== names.length;
}

async function pools(ctx: SetupContext, settings: RunnerSettings, discovery: Discovery, services: SetupServices): Promise<Step> {
  const draft = clone(settings.sizes);
  for (;;) {
    const action = await ctx.ui.select("4 of 5 — Named runner pools", [...draft.map((size, index) => `Edit ${index + 1}: ${poolLabel(size)}`), "Add named pool", "Continue to review", "Back", "Cancel setup"]);
    if (!action || action === "Cancel setup") return "cancel";
    if (action === "Back") {
      settings.sizes = draft;
      return "back";
    }
    if (action === "Continue to review") {
      if (duplicatePoolNames(draft)) {
        notify(ctx, "Every named pool, including disabled drafts, must have a unique name (case-insensitive).", "error");
        continue;
      }
      settings.sizes = draft;
      return "next";
    }
    const index = action === "Add named pool" ? draft.length : Number(/^Edit (\d+):/.exec(action)?.[1]) - 1;
    if (index < 0 || index > draft.length) continue;
    if (index === draft.length) draft.push(manualSize());
    const result = await editPool(ctx, draft[index], discovery, services, settings.standbyMinutes);
    if (result === "cancel") return "cancel";
    if (result === "remove") draft.splice(index, 1);
  }
}

async function makeDrafts(ctx: SetupContext, settings: RunnerSettings): Promise<Step> {
  const unresolved = settings.sizes.filter((size) => size.quantity > 0 && !validPositive(size));
  if (!unresolved.length) return "next";
  if (!await ctx.ui.confirm("Unresolved requested capacity", `${unresolved.map(poolLabel).join("\n")}\n\nConvert these incomplete pools to explicit quantity-zero disabled drafts?`)) return "back";
  for (const size of unresolved) {
    size.quantity = 0;
    size.maxHourlyCostEur = 0;
    size.maxEligibilityCostEur = 0;
  }
  return "next";
}

async function verifyMaterialization(binding: RepositoryBinding, settings: RunnerSettings): Promise<void> {
  const result = await materializePolicies(binding, settings);
  await result.cleanup();
}

async function identityChanged(binding: RepositoryBinding, original: RunnerSettings, settings: RunnerSettings): Promise<boolean> {
  if (original.policies.length || !original.sizes.some((size) => size.quantity > 0)) return false;
  const hashes = async (value: RunnerSettings) => {
    const result = await materializePolicies(binding, value);
    try {
      return (await Promise.all(result.policies.map(async (policy) => configHash((await loadPolicy(policy.path)).config)))).sort();
    } finally {
      await result.cleanup();
    }
  };
  const [before, after] = await Promise.all([hashes(original), hashes(settings)]);
  return JSON.stringify(before) !== JSON.stringify(after);
}

function generatedReview(settings: RunnerSettings): string {
  if (!settings.sizes.length) return "Generated pools: none.";
  return settings.sizes.map((size) => `Generated pool ${size.name || "unnamed"}\nmaximum simultaneous capacity ${size.quantity} (not always-on); type/location/image/firewall ${size.serverType || "unset"}/${size.location || "unset"}/${size.image || "unset"}/${size.firewallId || "unset"}\nversion ${size.runnerVersion || "unset"}; SHA-256 ${size.runnerArchiveSha256 || "unset"}\nworkflow runs-on: ${JSON.stringify(["self-hosted", "linux", "x64", ...size.labels])}\naccepted caps: €${exact(size.maxHourlyCostEur)}/hour, €${exact(size.maxEligibilityCostEur)}/eligible lifetime`).join("\n");
}

function previewDetails(preview: SetupPolicyPreview[]): string {
  if (!preview.length) return "No authoritative policy preview was returned.";
  const totalHourly = preview.reduce((sum, item) => sum + item.cost.hourlyPoolEur, 0);
  const totalEligibility = preview.reduce((sum, item) => sum + item.cost.maximumEligibilityEur, 0);
  return `${preview.map((item) => {
    const pool = item.config.pool;
    return `${item.name}: policy labels ${JSON.stringify(pool.routingLabels)}; max ${pool.maxSize}; actual idle ${pool.idleGraceSeconds}s, max lifetime ${pool.maximumLifetimeSeconds}s; policy caps €${exact(pool.maxKnownHourlyPoolCostEur)}/hour and €${exact(pool.maxKnownEligibilityCostEur)}/eligible lifetime; compute + IP estimate €${exact(item.cost.hourlyPoolEur)}/hour and €${exact(item.cost.maximumEligibilityEur)}/eligible lifetime`;
  }).join("\n")}\nAggregate estimate: €${exact(totalHourly)}/hour; €${exact(totalEligibility)} eligible lifetime. VAT and variable traffic are excluded.`;
}

async function reviewText(ctx: SetupContext, settings: RunnerSettings, binding: RepositoryBinding, legacy: boolean, home: string, services: SetupServices): Promise<string> {
  const local = resolve(binding.root, ".pi/github-runners.json");
  const global = resolve(home, ".pi/agent/github-runners.json");
  let authoritative = "Fresh policy estimates unavailable; accepted caps are ceilings, not quotes.";
  try {
    authoritative = previewDetails(await services.preview(settings));
  } catch (error) {
    notify(ctx, `Fresh policy preview is unavailable: ${error instanceof Error ? error.message : "unknown error"}. Configuration-only save remains available.`, "warning");
  }
  const configuration = legacy
    ? `Legacy policy paths retained unchanged:\n${settings.policies.join("\n") || "none"}\nActual timing and cost fields from the fresh policy preview:\n${authoritative}`
    : `${generatedReview(settings)}\nFresh policy details:\n${authoritative}`;
  return `5 of 5 — Review runner setup\n${scopeSummary(settings, binding)}\nGlobal target: ${global}\nLocal selector: ${local}\nActive save target: ${settings.mode === "global" ? global : local}\n${configuration}\nRuntime: polling every ${settings.pollIntervalSeconds}s; idle expiry ${settings.standbyMinutes}m. Closing Pi or saving disabled stops reconciliation, not VMs; existing local/remote VMs are not deleted and can remain billable. Idle expiry requires a running enabled controller.`;
}

async function enable(ctx: SetupContext, binding: RepositoryBinding, settings: RunnerSettings, services: SetupServices): Promise<"enabled" | "review"> {
  if (settings.reaper) {
    notify(ctx, "Remote controller restriction: local activation cannot be enabled; its snapshot remains unchanged and may be billable.", "warning");
    return "review";
  }
  try {
    await services.validate({ ...settings, automationEnabled: true });
  } catch (error) {
    notify(ctx, `Fresh validation failed; automation remains disabled: ${error instanceof Error ? error.message : "unknown error"}`, "error");
    return "review";
  }
  let preview: SetupPolicyPreview[];
  try {
    preview = await services.preview({ ...settings, automationEnabled: true });
  } catch (error) {
    notify(ctx, `Fresh policy preview failed; automation remains disabled: ${error instanceof Error ? error.message : "unknown error"}`, "error");
    return "review";
  }
  if (!preview.length) {
    notify(ctx, "Activation requires a non-empty fresh policy preview.", "error");
    return "review";
  }
  if (!await ctx.ui.confirm("Enable local automation after saving?", `${scopeSummary(settings, binding)}\n${generatedReview(settings)}\n${previewDetails(preview)}\n\nSaving and enabling immediately rebinds/reconciles automation and can create billable capacity.`)) return "review";
  if (!await ctx.ui.confirm("Single controller assurance", "Confirm this local process is the sole writer. Stop every other controller before enabling.")) return "review";
  const startup = await ctx.ui.select("Startup behavior (activation only)", ["Polling only; do not prewarm", "Prewarm selected pool quantities once, then expire normally"]);
  if (!startup) return "review";
  settings.automationEnabled = true;
  settings.startOnLoad = startup.startsWith("Prewarm");
  return "enabled";
}

export async function setupRunners(ctx: SetupContext, binding: RepositoryBinding, services: SetupServices, options: { home?: string } = {}): Promise<boolean> {
  if (ctx.mode !== "tui" || !ctx.hasUI) {
    notify(ctx, "Runner setup requires an interactive TUI session; activation is never available non-interactively.", "warning");
    return false;
  }
  const home = options.home ?? homedir();
  const before = await snapshot(binding.root, home);
  let original: RunnerSettings;
  try {
    original = await loadSettings(binding.root, { home });
  } catch (error) {
    notify(ctx, error instanceof Error ? error.message : "Could not load runner settings", "error");
    return false;
  }
  const settings = clone(original);
  let legacy = Boolean(original.policies.length);
  if (legacy) {
    const choice = await ctx.ui.select("Existing legacy runner policies", ["Keep existing legacy policies unchanged", "Replace with generated runner pools", "Cancel setup"]);
    if (!choice || choice === "Cancel setup") return false;
    if (choice.startsWith("Replace")) {
      if (!await ctx.ui.confirm("Replace legacy policies?", "Generated pools will not adopt or clean up existing VMs. Keep the original configuration or restore it to manage old VMs; no automatic cleanup occurs and existing VMs can remain billable.")) return false;
      settings.policies = [];
      legacy = false;
    }
  }
  settings.automationEnabled = false;
  settings.startOnLoad = false;
  notify(ctx, "Guided setup saves disabled configuration by default; enabling local automation is a separate paid action. Discovery never creates cloud resources, changes workflow files, installs SSH services, or modifies a remote controller. Existing automation and remote snapshots keep running while setup is open. Routing labels are AND requirements.");
  let stage: Stage = legacy ? "runtime" : settings.reaper ? "discovery" : "scope";
  let discovery: Discovery = { credentials: false };
  for (;;) {
    if (stage === "scope") {
      const result = await chooseScope(ctx, settings, binding);
      if (result === "cancel") return false;
      if (result === "back") continue;
      settings.sourcePath = settings.mode === "global" ? resolve(home, ".pi/agent/github-runners.json") : resolve(binding.root, ".pi/github-runners.json");
      stage = "discovery";
      continue;
    }
    if (stage === "discovery") {
      const result = await discover(ctx, settings, services);
      if (result.kind === "cancel") return false;
      if (result.kind === "back") {
        stage = settings.reaper ? "runtime" : "scope";
        continue;
      }
      discovery = result.discovery;
      stage = "runtime";
      continue;
    }
    if (stage === "runtime") {
      const result = await runtime(ctx, settings, legacy);
      if (result === "cancel") return false;
      if (result === "back") {
        if (legacy) continue;
        stage = settings.reaper ? "discovery" : "scope";
        continue;
      }
      stage = legacy ? "review" : "pools";
      continue;
    }
    if (stage === "pools") {
      const result = await pools(ctx, settings, discovery, services);
      if (result === "cancel") return false;
      if (result === "back") {
        stage = "runtime";
        continue;
      }
      if (await makeDrafts(ctx, settings) === "back") continue;
      stage = "review";
      continue;
    }
    notify(ctx, await reviewText(ctx, settings, binding, legacy, home, services));
    const actions = ["Save disabled configuration", ...(!settings.reaper ? ["Save and enable local automation"] : []), ...(legacy ? ["Back to runtime settings"] : ["Back to runtime settings", "Back to pools"]), "Cancel without saving"];
    const action = await ctx.ui.select("5 of 5 — Review runner setup", actions);
    if (!action || action === "Cancel without saving") return false;
    if (action === "Back to runtime settings") {
      stage = "runtime";
      continue;
    }
    if (action === "Back to pools") {
      stage = "pools";
      continue;
    }
    if (action === "Save and enable local automation" && await enable(ctx, binding, settings, services) !== "enabled") continue;
    if (action === "Save disabled configuration") {
      settings.automationEnabled = false;
      settings.startOnLoad = false;
    }
    try {
      await verifyMaterialization(binding, settings);
    } catch (error) {
      notify(ctx, `Configuration was not saved: ${error instanceof Error ? error.message : "generated policies are invalid"}`, "error");
      continue;
    }
    if (await identityChanged(binding, original, settings) && !await ctx.ui.confirm("Generated pool identity changed", "An existing generated active pool identity changed or was removed. The new configuration will not adopt or clean up old VMs. Keep the original configuration or restore it to manage old VMs; no automatic cleanup occurs and existing VMs can remain billable. Continue?")) continue;
    if (settings.mode === "global" && before.get(resolve(home, ".pi/agent/github-runners.json")) !== undefined && !await ctx.ui.confirm("Overwrite existing global runner configuration?", `This saves to ${resolve(home, ".pi/agent/github-runners.json")} and updates local selector ${resolve(binding.root, ".pi/github-runners.json")}. Continue?`)) continue;
    if (!await unchanged(before)) {
      notify(ctx, "Runner settings changed while setup was open; nothing was saved.", "error");
      return false;
    }
    try {
      await saveSettings(binding.root, settings, { home });
    } catch (error) {
      notify(ctx, error instanceof Error ? error.message : "Could not save runner settings", "error");
      return false;
    }
    notify(ctx, settings.automationEnabled ? "Runner configuration saved and local automation enabled; reconciliation can create billable capacity." : "Runner configuration saved disabled: reconciliation and prewarming are cleared, not VMs. Existing local or remote VMs/controllers are not deleted and can remain billable.");
    return true;
  }
}
