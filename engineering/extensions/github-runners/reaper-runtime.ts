import { createHash } from "node:crypto";
import { lstat, open, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseDocument, stringify } from "yaml";
import { loadPolicyText } from "./src/policy-schema.js";
import { runCli as coreRunCli } from "./src/cli.js";
import { SafeRefusal, UsageError } from "./src/types.js";
import { assertPolicyScope, materializePolicies } from "./policies.js";
import type { RepositoryBinding } from "./repository.js";
import type { RunnerSettings } from "./settings.js";
import type { AutomationDependencies } from "./automation.js";

const MAX_CONFIG_BYTES = 512 * 1024;
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_ENV_BYTES = 64 * 1024;
const operations = new Set(["status", "ensure", "reconcile", "drain", "destroy", "startup"]);
const mutable = new Set(["ensure", "reconcile", "drain", "destroy"]);
const policyName = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
const repository = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type SerializedSettings = Omit<RunnerSettings, "sourcePath" | "policies"> & { policies?: string[] };
export type ReaperRequest = { operation: "status" | "ensure" | "reconcile" | "drain" | "destroy" | "startup"; policy?: string; capacity?: number; instance?: string; apply?: boolean; expectedPlanFingerprint?: string };
export type ReaperConfig = { version: 1; binding: { root: "."; repository: string }; settings: SerializedSettings; policies?: Array<{ name: string; yaml: string }> };
export type ReaperResult = { code: number; text: string };
type Policy = { name: string; path: string; sourcePath: string };
type Automation = { start?(): void; tick(prewarm?: boolean): Promise<void>; stop(): void | Promise<void> };
type AutomationHooks = Pick<AutomationDependencies, "activityFloor" | "onPrewarm"> & { env: NodeJS.ProcessEnv; materialize?: typeof materializePolicies };
export type ReaperDependencies = {
  runCli?: typeof coreRunCli;
  materialize?: typeof materializePolicies;
  automation?: (binding: RepositoryBinding, settings: RunnerSettings, onStatus: (value: unknown) => void, deps: AutomationHooks) => Automation | Promise<Automation>;
  now?: () => Date;
  readFile?: typeof readFile;
  env?: NodeJS.ProcessEnv;
  status?: (value: unknown) => void;
};

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UsageError(`${name} must be an object`);
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: string[], name: string): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new UsageError(`${name} has unknown properties`);
}
function integer(value: unknown, name: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new UsageError(`${name} is out of range`);
  return value as number;
}
function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new UsageError(`${name} must be a non-empty string`);
  return value;
}
function parseSettings(value: unknown, sourcePath: string): RunnerSettings {
  const raw = record(value, "settings");
  exact(raw, ["mode", "policies", "pollIntervalSeconds", "standbyMinutes", "startOnLoad", "automationEnabled", "organization", "sizes"], "settings");
  if (raw.policies !== undefined && (!Array.isArray(raw.policies) || raw.policies.some((item) => typeof item !== "string"))) throw new UsageError("settings.policies must be a string array");
  if (raw.mode !== "local" && raw.mode !== "global") throw new UsageError("settings.mode is invalid");
  if (typeof raw.startOnLoad !== "boolean" || typeof raw.automationEnabled !== "boolean") throw new UsageError("settings booleans are invalid");
  integer(raw.pollIntervalSeconds, "settings.pollIntervalSeconds", 5, 3600);
  integer(raw.standbyMinutes, "settings.standbyMinutes", 1, 1440);
  if (!Array.isArray(raw.sizes)) throw new UsageError("settings.sizes must be an array");
  const organization = raw.organization === undefined ? undefined : record(raw.organization, "settings.organization");
  if (organization) {
    exact(organization, ["name", "repositories", "runnerGroupId", "runnerGroupName"], "settings.organization");
    text(organization.name, "settings.organization.name"); text(organization.runnerGroupName, "settings.organization.runnerGroupName"); integer(organization.runnerGroupId, "settings.organization.runnerGroupId", 1, Number.MAX_SAFE_INTEGER);
    if (!Array.isArray(organization.repositories) || !organization.repositories.length || organization.repositories.some((entry) => typeof entry !== "string" || !repository.test(entry))) throw new UsageError("settings.organization.repositories is invalid");
  }
  for (const [index, entry] of raw.sizes.entries()) {
    const size = record(entry, `settings.sizes[${index}]`); exact(size, ["name", "labels", "quantity", "serverType", "location", "image", "firewallId", "runnerVersion", "runnerArchiveSha256", "maxHourlyCostEur", "maxEligibilityCostEur"], `settings.sizes[${index}]`);
    const quantity = integer(size.quantity, `settings.sizes[${index}].quantity`, 0, 3);
    if (!Array.isArray(size.labels) || size.labels.some((label) => typeof label !== "string")) throw new UsageError(`settings.sizes[${index}].labels is invalid`);
    for (const key of ["name", "serverType", "location", "image", "firewallId", "runnerVersion", "runnerArchiveSha256"]) if (typeof size[key] !== "string") throw new UsageError(`settings.sizes[${index}].${key} is invalid`);
    for (const key of ["maxHourlyCostEur", "maxEligibilityCostEur"]) if (typeof size[key] !== "number" || !Number.isFinite(size[key]) || (size[key] as number) < 0) throw new UsageError(`settings.sizes[${index}].${key} is invalid`);
    if (quantity === 0) continue;
    for (const key of ["name", "serverType", "location", "image", "firewallId", "runnerVersion", "runnerArchiveSha256"]) text(size[key], `settings.sizes[${index}].${key}`);
    if (!size.labels.length || size.labels.some((label) => !policyName.test(label) || ["self-hosted", "linux", "x64"].includes(label.toLowerCase()))) throw new UsageError(`settings.sizes[${index}].labels is invalid`);
  }
  return { ...(raw as unknown as Omit<RunnerSettings, "sourcePath" | "policies">), policies: [], sourcePath };
}
export function parseReaperConfig(value: unknown, configPath: string): Omit<ReaperConfig, "binding" | "settings"> & { settings: RunnerSettings; binding: RepositoryBinding } {
  const raw = record(value, "config");
  exact(raw, ["version", "binding", "settings", "policies"], "config");
  if (raw.version !== 1) throw new UsageError("config.version must be 1");
  const binding = record(raw.binding, "config.binding");
  exact(binding, ["root", "repository"], "config.binding");
  if (binding.root !== "." || typeof binding.repository !== "string" || !repository.test(binding.repository)) throw new UsageError("config.binding is invalid");
  const settings = parseSettings(raw.settings, configPath);
  const policies = raw.policies === undefined ? undefined : raw.policies;
  if (policies !== undefined) {
    if (!Array.isArray(policies) || policies.length > 32) throw new UsageError("config.policies is invalid");
    const names = new Set<string>();
    for (const entry of policies) {
      const item = record(entry, "config policy"); exact(item, ["name", "yaml"], "config policy");
      const name = text(item.name, "config policy name");
      const yaml = item.yaml;
      if (!policyName.test(name) || typeof yaml !== "string" || Buffer.byteLength(yaml) > 256 * 1024 || names.has(name)) throw new UsageError("config policy is invalid");
      names.add(name);
    }
  }
  if (policies?.length && settings.sizes.length) throw new UsageError("config cannot contain embedded and generated policies");
  return { version: 1, binding: { root: dirname(resolve(configPath)), repository: binding.repository as string }, settings, ...(policies ? { policies: policies as Array<{ name: string; yaml: string }> } : {}) };
}
export async function loadReaperConfig(configPath: string, deps: Pick<ReaperDependencies, "readFile"> = {}): Promise<ReturnType<typeof parseReaperConfig>> {
  const reader = deps.readFile ?? readFile;
  const body = await reader(configPath);
  if (body.byteLength > MAX_CONFIG_BYTES) throw new UsageError("config exceeds size limit");
  try { return parseReaperConfig(JSON.parse(body.toString("utf8")), configPath); } catch (error) { if (error instanceof SyntaxError) throw new UsageError("config is not valid JSON"); throw error; }
}
function lockPath(root: string, yaml: string): string {
  const loaded = loadPolicyText(yaml);
  const scope = loaded.config.organization ? `org:${loaded.config.organization.name}:${[...loaded.config.organization.repositories].sort().join(",")}:${loaded.config.organization.runnerGroupId}` : `repo:${loaded.config.repository}`;
  return join(root, "locks", `${createHash("sha256").update(`${scope}:${loaded.config.pool.name}`).digest("hex")}.lock`);
}
async function embeddedPolicies(config: ReturnType<typeof parseReaperConfig>): Promise<{ policies: Policy[]; cleanup: () => Promise<void> }> {
  const root = config.binding.root;
  const directory = join(root, "policies");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir(join(root, "locks"), { recursive: true, mode: 0o700 });
  const policies: Policy[] = [];
  for (const item of config.policies ?? []) {
    const document = parseDocument(item.yaml, { schema: "core", strict: true, uniqueKeys: true });
    if (document.errors.length || document.warnings.length) throw new UsageError("embedded policy YAML is invalid");
    const value = document.toJS({ maxAliasCount: 0 });
    const raw = record(value, "embedded policy");
    const spec = record(raw.spec, "embedded policy spec");
    spec.coordination = { lockPath: lockPath(root, item.yaml) };
    const output = stringify(raw);
    const loaded = loadPolicyText(output);
    assertPolicyScope(config.binding, config.settings, loaded.config);
    const path = join(directory, `${item.name}.yaml`);
    await writeFile(path, output, { mode: 0o600 });
    policies.push({ name: item.name, path, sourcePath: path });
  }
  return { policies, cleanup: async () => undefined };
}
export async function parsePrivateEnvironment(path: string): Promise<NodeJS.ProcessEnv> {
  const link = await lstat(path).catch(() => undefined);
  if (!link || link.isSymbolicLink()) throw new SafeRefusal("environment file cannot be read safely");
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600 || info.size > MAX_ENV_BYTES) throw new SafeRefusal("environment file must be a private regular 0600 file owned by this user");
    const source = (await handle.readFile()).toString("utf8");
    const env: NodeJS.ProcessEnv = {};
    for (const line of source.split(/\r?\n/)) {
      if (!line || /^\s*#/.test(line)) continue;
      const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
      if (!match || /[\u0000\r\n]/.test(match[2])) throw new SafeRefusal("environment file has invalid entries");
      env[match[1]] = match[2];
    }
    return env;
  } catch (error) { if (error instanceof SafeRefusal) throw error; throw new SafeRefusal("environment file cannot be read safely"); } finally { await handle.close(); }
}
export function parseReaperRequest(value: unknown): ReaperRequest {
  const raw = record(value, "request");
  exact(raw, ["operation", "policy", "capacity", "instance", "apply", "expectedPlanFingerprint"], "request");
  if (typeof raw.operation !== "string" || !operations.has(raw.operation)) throw new UsageError("request operation is invalid");
  if (raw.policy !== undefined && (typeof raw.policy !== "string" || !policyName.test(raw.policy))) throw new UsageError("request policy is invalid");
  if (raw.capacity !== undefined) integer(raw.capacity, "request capacity", 0, 3);
  if (raw.instance !== undefined && (typeof raw.instance !== "string" || !uuid.test(raw.instance))) throw new UsageError("request instance is invalid");
  if (raw.apply !== undefined && typeof raw.apply !== "boolean") throw new UsageError("request apply is invalid");
  if (raw.expectedPlanFingerprint !== undefined && (typeof raw.expectedPlanFingerprint !== "string" || !/^[a-f0-9]{64}$/i.test(raw.expectedPlanFingerprint))) throw new UsageError("request expectedPlanFingerprint is invalid");
  const operation = raw.operation as ReaperRequest["operation"];
  if ((operation === "status" || operation === "startup") && (raw.apply !== undefined || raw.capacity !== undefined || raw.instance !== undefined || raw.expectedPlanFingerprint !== undefined)) throw new UsageError("request fields are invalid for operation");
  if (operation === "ensure" && raw.instance !== undefined) throw new UsageError("request instance is invalid for ensure");
  if ((operation === "drain" || operation === "destroy") && raw.instance === undefined) throw new UsageError("request instance is required");
  if (operation !== "ensure" && raw.capacity !== undefined) throw new UsageError("request capacity is invalid for operation");
  if (raw.apply === true && !mutable.has(operation)) throw new UsageError("request apply is invalid for operation");
  if (raw.apply === true && !raw.expectedPlanFingerprint) throw new SafeRefusal("apply requires expectedPlanFingerprint");
  return { operation, ...(raw.policy ? { policy: raw.policy } : {}), ...(raw.capacity !== undefined ? { capacity: raw.capacity as number } : {}), ...(raw.instance ? { instance: raw.instance } : {}), ...(raw.apply ? { apply: true } : {}), ...(raw.expectedPlanFingerprint ? { expectedPlanFingerprint: raw.expectedPlanFingerprint } : {}) };
}
async function prewarmState(root: string, now: Date): Promise<Date | undefined> {
  try { const raw = JSON.parse(await readFile(join(root, ".prewarm.json"), "utf8")) as { at?: unknown }; const at = raw.at; if (typeof at !== "number" || !Number.isFinite(at) || at > now.getTime() + 5 * 60_000) return undefined; return new Date(at); } catch { return undefined; }
}
async function savePrewarm(root: string, at: Date): Promise<void> {
  const target = join(root, ".prewarm.json"); const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ at: at.getTime() }) + "\n", { mode: 0o600 }); await rename(temporary, target);
}
async function defaultAutomation(binding: RepositoryBinding, settings: RunnerSettings, status: (value: unknown) => void, deps: AutomationHooks): Promise<Automation> {
  const modulePath = "./automation.js";
  const loaded = await import(modulePath) as { RunnerAutomation: new (binding: RepositoryBinding, settings: RunnerSettings, status: (value: unknown) => void, deps: AutomationDependencies) => Automation };
  return new loaded.RunnerAutomation(binding, settings, status, deps);
}
function automationHooks(config: ReturnType<typeof parseReaperConfig>, env: NodeJS.ProcessEnv, deps: ReaperDependencies, materialized?: { policies: Policy[]; cleanup: () => Promise<void> }): AutomationHooks {
  const now = deps.now ?? (() => new Date());
  return {
    env,
    activityFloor: () => prewarmState(config.binding.root, now()),
    onPrewarm: (at) => savePrewarm(config.binding.root, at),
    ...(materialized ? { materialize: async () => materialized } : {}),
  };
}
export async function executeReaper(configPath: string, request: ReaperRequest, env: NodeJS.ProcessEnv = process.env, deps: ReaperDependencies = {}): Promise<ReaperResult> {
  const config = await loadReaperConfig(configPath, deps);
  if (request.operation === "startup") {
    if (!config.settings.startOnLoad) return { code: 0, text: JSON.stringify({ command: "startup", skipped: true }) };
    const embedded = config.policies?.length ? await embeddedPolicies(config) : undefined;
    const settings = { ...config.settings, startOnLoad: true, ...(embedded ? { policies: embedded.policies.map((policy) => policy.path) } : {}) };
    const hooks = automationHooks(config, env, deps, embedded);
    const automation = deps.automation ? await deps.automation(config.binding, settings, deps.status ?? (() => undefined), hooks) : await defaultAutomation(config.binding, settings, deps.status ?? (() => undefined), hooks);
    try { await automation.tick(true); } finally { await automation.stop(); }
    return { code: 0, text: JSON.stringify({ command: "startup", started: true }) };
  }
  const materialized = config.policies?.length ? await embeddedPolicies(config) : await (deps.materialize ?? materializePolicies)(config.binding, config.settings);
  try {
    const selected = request.policy ? materialized.policies.filter((item) => item.name === request.policy) : materialized.policies;
    if (!selected.length) throw new UsageError("selected policy was not found");
    const results: ReaperResult[] = [];
    for (const policy of selected) {
      const input = [request.operation, "--config", policy.path, "--json", ...(request.capacity !== undefined ? ["--capacity", String(request.capacity)] : []), ...(request.instance ? ["--instance", request.instance] : []), ...(request.apply ? ["--apply"] : [])];
      let stdout = ""; let stderr = "";
      const code = await (deps.runCli ?? coreRunCli)(input, env, { stdout: (value) => { stdout = value; }, stderr: (value) => { stderr = value; } }, fetch, { expectedPlanFingerprint: request.expectedPlanFingerprint });
      results.push({ code, text: stdout || stderr });
    }
    return results.length === 1 ? results[0] : { code: results.reduce((highest, item) => Math.max(highest, item.code), 0), text: JSON.stringify(results.map((item, index) => ({ policy: selected[index].name, code: item.code, output: item.text }))) };
  } finally { await materialized.cleanup(); }
}
export async function serveReaper(configPath: string, deps: ReaperDependencies = {}, lifecycle: { on?: (event: "SIGTERM" | "SIGINT", listener: () => void) => unknown; off?: (event: "SIGTERM" | "SIGINT", listener: () => void) => unknown; setInterval?: typeof setInterval; clearInterval?: typeof clearInterval } = process): Promise<() => Promise<void>> {
  const config = await loadReaperConfig(configPath, deps);
  const embedded = config.policies?.length ? await embeddedPolicies(config) : undefined;
  const settings = { ...config.settings, startOnLoad: false, ...(embedded ? { policies: embedded.policies.map((policy) => policy.path) } : {}) };
  const hooks = automationHooks(config, deps.env ?? process.env, deps, embedded);
  const automation = deps.automation ? await deps.automation(config.binding, settings, deps.status ?? (() => undefined), hooks) : await defaultAutomation(config.binding, settings, deps.status ?? (() => undefined), hooks);
  automation.start?.();
  const keepalive = (lifecycle.setInterval ?? setInterval)(() => undefined, 60_000);
  let stopped = false;
  const stop = async () => { if (stopped) return; stopped = true; (lifecycle.clearInterval ?? clearInterval)(keepalive); await automation.stop(); lifecycle.off?.("SIGTERM", signal); lifecycle.off?.("SIGINT", signal); };
  const signal = () => { void stop(); };
  lifecycle.on?.("SIGTERM", signal); lifecycle.on?.("SIGINT", signal);
  return stop;
}
export async function readBoundedJson(input: AsyncIterable<Uint8Array>, limit = MAX_REQUEST_BYTES): Promise<unknown> {
  const parts: Buffer[] = []; let size = 0;
  for await (const part of input) { size += part.byteLength; if (size > limit) throw new UsageError("request exceeds size limit"); parts.push(Buffer.from(part)); }
  try { return JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { throw new UsageError("request is not valid JSON"); }
}
