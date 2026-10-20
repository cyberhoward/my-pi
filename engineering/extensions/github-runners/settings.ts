import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export interface RunnerSize {
  name: string;
  labels: string[];
  quantity: number;
  serverType: string;
  location: string;
  image: string;
  firewallId: string;
  runnerVersion: string;
  runnerArchiveSha256: string;
  maxHourlyCostEur: number;
  maxEligibilityCostEur: number;
}

export interface OrganizationSettings {
  name: string;
  repositories: string[];
  runnerGroupId: number;
  runnerGroupName: string;
}

export interface ReaperSettings {
  sshTarget: string;
  installationId: string;
  environmentFile: string;
}

export interface RunnerSettings {
  mode: "local" | "global";
  policies: string[];
  pollIntervalSeconds: number;
  standbyMinutes: number;
  startOnLoad: boolean;
  automationEnabled: boolean;
  organization?: OrganizationSettings;
  reaper?: ReaperSettings;
  sizes: RunnerSize[];
  sourcePath: string;
}

export interface SettingsPaths { home?: string }
const defaults = ["tools/runner-manager/runner-manager.policy.yaml", "tools/runner-manager/runner-manager-large.policy.yaml"];
const names = new Set(["mode", "policies", "pollIntervalSeconds", "standbyMinutes", "startOnLoad", "automationEnabled", "organization", "reaper", "sizes"]);

function inside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path !== "" && !path.startsWith("..") && !isAbsolute(path);
}
export function resolvePolicyPath(root: string, value: string): string {
  if (!value || isAbsolute(value)) throw new Error("policy paths must be relative to the git root");
  const path = resolve(root, value);
  if (!inside(root, path)) throw new Error("policy paths must remain inside the git root");
  return path;
}
function object(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}
function string(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value;
}
function boundedInteger(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`${field} must be an integer between ${min} and ${max}`);
  return value as number;
}
function positiveNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${field} must be a non-negative finite number`);
  return value;
}
function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) throw new Error(`${field} must be an array of non-empty strings`);
  return [...new Set(value)];
}
function parseSize(value: unknown, index: number): RunnerSize {
  const record = object(value, `sizes[${index}] must be an object`);
  const required = ["name", "labels", "quantity", "serverType", "location", "image", "firewallId", "runnerVersion", "runnerArchiveSha256", "maxHourlyCostEur", "maxEligibilityCostEur"];
  if (Object.keys(record).some((key) => !required.includes(key)) || required.some((key) => !(key in record))) throw new Error(`sizes[${index}] must contain the complete runner size mapping`);
  const quantity = boundedInteger(record.quantity, `sizes[${index}].quantity`, 0, 3);
  if (!Array.isArray(record.labels) || record.labels.some((label) => typeof label !== "string")) throw new Error(`sizes[${index}].labels must be an array of strings`);
  const labels = [...new Set(record.labels)];
  const draftString = (field: string): string => {
    const value = record[field];
    if (typeof value !== "string") throw new Error(`sizes[${index}].${field} must be a string`);
    return value;
  };
  const size = {
    name: draftString("name"), labels, quantity,
    serverType: draftString("serverType"), location: draftString("location"), image: draftString("image"), firewallId: draftString("firewallId"),
    runnerVersion: draftString("runnerVersion"), runnerArchiveSha256: draftString("runnerArchiveSha256"),
    maxHourlyCostEur: positiveNumber(record.maxHourlyCostEur, `sizes[${index}].maxHourlyCostEur`), maxEligibilityCostEur: positiveNumber(record.maxEligibilityCostEur, `sizes[${index}].maxEligibilityCostEur`),
  };
  if (quantity === 0) return size;
  if (!size.name || !size.labels.length || size.labels.some((label) => !label || ["self-hosted", "linux", "x64"].includes(label.toLowerCase()))) throw new Error(`sizes[${index}].labels must contain custom routing labels, not default runner labels`);
  if (!size.serverType || !size.location || !size.image || !size.firewallId || !size.runnerVersion || !size.runnerArchiveSha256) throw new Error(`sizes[${index}] must contain a complete active runner size mapping`);
  return size;
}
function parseOrganization(value: unknown): OrganizationSettings {
  const record = object(value, "organization must be an object");
  const fields = ["name", "repositories", "runnerGroupId", "runnerGroupName"];
  if (Object.keys(record).some((key) => !fields.includes(key))) throw new Error("organization has unknown properties");
  const name = record.name === undefined ? "" : typeof record.name === "string" ? record.name.trim().toLowerCase() : (() => { throw new Error("organization.name must be a string"); })();
  const repositories = record.repositories === undefined ? [] : strings(record.repositories, "organization.repositories").map((repository) => repository.toLowerCase()).sort((left, right) => left.localeCompare(right));
  if (new Set(repositories).size !== repositories.length) throw new Error("organization.repositories must not contain duplicates");
  const runnerGroupName = record.runnerGroupName === undefined ? "" : typeof record.runnerGroupName === "string" ? record.runnerGroupName.trim() : (() => { throw new Error("organization.runnerGroupName must be a string"); })();
  const runnerGroupId = record.runnerGroupId === undefined ? 0 : boundedInteger(record.runnerGroupId, "organization.runnerGroupId", 0, Number.MAX_SAFE_INTEGER);
  return { name, repositories, runnerGroupId, runnerGroupName };
}
function parseReaper(value: unknown): ReaperSettings {
  const record = object(value, "reaper must be an object");
  if (Object.keys(record).some((key) => !["sshTarget", "installationId", "environmentFile"].includes(key))) throw new Error("reaper has unknown properties");
  const sshTarget = string(record.sshTarget, "reaper.sshTarget");
  const installationId = string(record.installationId, "reaper.installationId");
  const environmentFile = string(record.environmentFile, "reaper.environmentFile");
  if (!/^(?:[A-Za-z0-9_.-]+@)?[A-Za-z0-9][A-Za-z0-9.-]*$/.test(sshTarget)) throw new Error("reaper.sshTarget must be a safe SSH alias or user@host");
  if (!/^[a-f0-9]{16}$/.test(installationId)) throw new Error("reaper.installationId must be a 16-character lowercase hash");
  if (!isAbsolute(environmentFile) || /[\u0000-\u001f\u007f]/.test(environmentFile) || environmentFile.split("/").includes("..")) throw new Error("reaper.environmentFile must be an absolute safe path");
  return { sshTarget, installationId, environmentFile };
}
export function reaperInstallationId(binding: { repository: string }, settings: Pick<RunnerSettings, "mode" | "organization">): string {
  const scope = settings.mode === "global" ? `org:${settings.organization?.name.toLowerCase() ?? ""}:${[...(settings.organization?.repositories ?? [])].map((value) => value.toLowerCase()).sort().join(",")}` : `repo:${binding.repository.toLowerCase()}`;
  return createHash("sha256").update(scope).digest("hex").slice(0, 16);
}
function parseSettings(value: unknown, root: string, sourcePath: string): RunnerSettings {
  const record = object(value, `${sourcePath} must be an object`);
  if (Object.keys(record).some((key) => !names.has(key))) throw new Error(`${sourcePath} has unknown properties`);
  const mode = record.mode === undefined ? "local" : record.mode;
  if (mode !== "local" && mode !== "global") throw new Error("mode must be local or global");
  if (record.policies !== undefined && !Array.isArray(record.policies)) throw new Error("policies must be a string array");
  const policies = record.policies === undefined ? [] : strings(record.policies, "policies").map((item) => resolvePolicyPath(root, item));
  const pollIntervalSeconds = record.pollIntervalSeconds === undefined ? 60 : boundedInteger(record.pollIntervalSeconds, "pollIntervalSeconds", 5, 3600);
  const standbyMinutes = record.standbyMinutes === undefined ? 15 : boundedInteger(record.standbyMinutes, "standbyMinutes", 1, 24 * 60);
  if (record.startOnLoad !== undefined && typeof record.startOnLoad !== "boolean") throw new Error("startOnLoad must be boolean");
  if (record.automationEnabled !== undefined && typeof record.automationEnabled !== "boolean") throw new Error("automationEnabled must be boolean");
  if (record.sizes !== undefined && !Array.isArray(record.sizes)) throw new Error("sizes must be an array");
  return { mode, policies, pollIntervalSeconds, standbyMinutes, startOnLoad: record.startOnLoad ?? false, automationEnabled: record.automationEnabled ?? false, organization: record.organization === undefined ? undefined : parseOrganization(record.organization), reaper: record.reaper === undefined ? undefined : parseReaper(record.reaper), sizes: (record.sizes ?? []).map(parseSize), sourcePath };
}
async function exists(path: string): Promise<boolean> { try { await access(path, constants.R_OK); return true; } catch { return false; } }
async function read(path: string, root: string): Promise<RunnerSettings> {
  const text = await readFile(path, "utf8");
  if (Buffer.byteLength(text) > 64 * 1024) throw new Error(`${path} exceeds 64 KiB`);
  try { return parseSettings(JSON.parse(text), root, path); } catch (error) { if (error instanceof SyntaxError) throw new Error(`${path} is not valid JSON`); throw error; }
}
export async function loadSettings(root: string, paths: SettingsPaths = {}): Promise<RunnerSettings> {
  const local = resolve(root, ".pi/github-runners.json");
  if (await exists(local)) {
    const selected = await read(local, root);
    if (selected.mode === "global") {
      const global = resolve(paths.home ?? homedir(), ".pi/agent/github-runners.json");
      if (!(await exists(global))) throw new Error(`global runner settings not found: ${global}`);
      const settings = await read(global, root);
      return { ...settings, mode: "global", sourcePath: global };
    }
    return selected;
  }
  const policies: string[] = [];
  for (const candidate of defaults) { const path = resolvePolicyPath(root, candidate); if (await exists(path)) policies.push(path); }
  return { mode: "local", policies, pollIntervalSeconds: 60, standbyMinutes: 15, startOnLoad: false, automationEnabled: false, sizes: [], sourcePath: local };
}
function serializable(root: string, settings: RunnerSettings): Record<string, unknown> {
  const { sourcePath: _sourcePath, policies, ...value } = settings;
  return { ...value, policies: policies.map((policy) => relative(root, resolvePolicyPath(root, relative(root, resolve(root, policy)))) ) };
}
export async function saveSettings(root: string, settings: RunnerSettings, paths: SettingsPaths = {}): Promise<void> {
  const local = resolve(root, ".pi/github-runners.json");
  const target = settings.mode === "global" ? resolve(paths.home ?? homedir(), ".pi/agent/github-runners.json") : local;
  let value = serializable(root, settings);
  value = serializable(root, parseSettings(value, root, target));
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(temporary, target);
  if (settings.mode === "global") {
    await mkdir(dirname(local), { recursive: true, mode: 0o700 });
    await writeFile(local, JSON.stringify({ mode: "global" }, null, 2) + "\n", { mode: 0o600 });
  }
}
export function automationErrors(settings: RunnerSettings): string[] {
  const errors: string[] = [];
  const active = settings.sizes.filter((size) => size.quantity > 0);
  if (!active.length) errors.push("at least one runner size with quantity above zero is required");
  for (const size of active) {
    if (!size.name || !size.labels.length || size.labels.some((label) => !label.trim())) errors.push(`${size.name || "runner size"} requires custom routing labels`);
    if (!/^(cx|cpx|ccx)[0-9]+$/.test(size.serverType) || !size.location || !size.image || !/^[1-9]\d*$/.test(size.firewallId)) errors.push(`${size.name || "runner size"} requires a complete Hetzner server, location, image, and firewall mapping`);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(size.runnerVersion) || !/^[a-f0-9]{64}$/i.test(size.runnerArchiveSha256)) errors.push(`${size.name || "runner size"} requires a pinned runner version and SHA-256`);
    if (!(size.maxHourlyCostEur > 0) || !(size.maxEligibilityCostEur > 0)) errors.push(`${size.name || "runner size"} requires positive cost limits`);
  }
  if (settings.mode === "global" && (!settings.organization || !settings.organization.name || !settings.organization.repositories.length || !settings.organization.runnerGroupId || !settings.organization.runnerGroupName)) errors.push("global automation requires organization name, repository allowlist, and runner group");
  return errors;
}
