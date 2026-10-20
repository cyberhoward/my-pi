import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { footerText, readMonitorState, RunnerMonitor, type MonitorState } from "./monitor.js";
import { detectRepository, nodeCommandRunner, sameRepository } from "./repository.js";
import { loadSettings, saveSettings, type RunnerSettings } from "./settings.js";
import { configureRunners } from "./settings-menu.js";
import { materializePolicies } from "./policies.js";
import { RunnerAutomation } from "./automation.js";
import { loadPolicy } from "./src/config.js";
import { planFingerprint, runCli } from "./src/cli.js";
import { installReaper, reaperInstallationId, reaperStatus, requestReaper, uninstallReaper, type ReaperRequest } from "./remote-reaper.js";

const usage = "Usage: /runners [status|refresh|ensure|reconcile|drain|destroy|reaper install|reaper status|reaper uninstall] [--policy <path-or-selected-policy>] [--capacity N] [--instance UUID] [--apply]";
const operations = new Set(["status", "refresh", "ensure", "reconcile", "drain", "destroy"]);
type Parsed = { operation: string; policy?: string; capacity?: string; instance?: string; apply: boolean };
type CorePlan = { warnings?: string[]; operations?: unknown[] };
type CoreOutput = { plan?: CorePlan };

export function parseRunnerCommand(input: string): Parsed {
  const argv = input.trim().split(/\s+/).filter(Boolean);
  const operation = argv.shift() ?? "";
  if (!operations.has(operation)) throw new Error(usage);
  const parsed: Parsed = { operation, apply: false };
  while (argv.length) {
    const flag = argv.shift();
    if (flag === "--apply") { if (parsed.apply) throw new Error(usage); parsed.apply = true; continue; }
    if (flag === "--policy" || flag === "--capacity" || flag === "--instance") {
      const value = argv.shift(); if (!value) throw new Error(usage);
      if (flag === "--policy") parsed.policy = value;
      if (flag === "--capacity") parsed.capacity = value;
      if (flag === "--instance") parsed.instance = value;
      continue;
    }
    throw new Error(usage);
  }
  if (parsed.operation === "refresh" && (parsed.apply || parsed.policy || parsed.capacity || parsed.instance)) throw new Error(usage);
  if (parsed.operation !== "ensure" && parsed.capacity) throw new Error(usage);
  if (!["drain", "destroy"].includes(parsed.operation) && parsed.instance) throw new Error(usage);
  if (["drain", "destroy"].includes(parsed.operation) && !parsed.instance) throw new Error("--instance is required\n" + usage);
  if (["status", "refresh"].includes(parsed.operation) && parsed.apply) throw new Error("--apply is only valid for management operations");
  return parsed;
}
function output(ctx: ExtensionCommandContext, text: string, type: "info" | "warning" | "error" = "info"): void { if (ctx.hasUI) ctx.ui.notify(text, type); else console.log(text); }
function parseOutput(text: string): CoreOutput | undefined { for (const line of text.split(/\r?\n/)) { try { return JSON.parse(line) as CoreOutput; } catch {} } return undefined; }
function planFingerprintFrom(text: string): string | undefined { const plan = parseOutput(text)?.plan; return plan && !plan.warnings?.length && Array.isArray(plan.operations) ? planFingerprint(plan as Parameters<typeof planFingerprint>[0]) : undefined; }
async function choose(ctx: ExtensionCommandContext): Promise<string | undefined> { return ctx.hasUI ? ctx.ui.select("GitHub runners", ["status", "refresh", "ensure", "reconcile", "drain", "destroy", "settings", "reaper install", "reaper status", "reaper uninstall"]) : undefined; }
async function ghToken(cwd: string): Promise<string | undefined> { try { return (await nodeCommandRunner("gh", ["auth", "token", "--hostname", "github.com"], { cwd, timeoutMs: 5_000, maxBuffer: 16 * 1024 })).stdout.trim() || undefined; } catch { return undefined; } }
export async function snapshotPolicy(path: string): Promise<{ path: string; cleanup: () => Promise<void> }> { const bytes = await readFile(path); if (bytes.byteLength > 256 * 1024) throw new Error("policy exceeds 256 KiB limit"); const directory = await mkdtemp(join(tmpdir(), "pi-runner-policy-")); const snapshot = join(directory, "policy.yaml"); await writeFile(snapshot, bytes, { mode: 0o600 }); return { path: snapshot, cleanup: () => rm(directory, { recursive: true, force: true }) }; }
export function assertPolicyRepository(repository: string, policyRepository: string): void { if (!sameRepository(policyRepository, repository)) throw new Error("policy repository does not match the active GitHub origin"); }
function assertBindingAllowed(binding: { repository: string }, settings: RunnerSettings, policyRepository: string): void {
  if (settings.mode !== "global") return assertPolicyRepository(binding.repository, policyRepository);
  const allowed = settings.organization?.repositories ?? [];
  if (!allowed.some((value) => sameRepository(value, binding.repository))) throw new Error("active repository is not in the organization allowlist");
  if (!allowed.some((value) => sameRepository(value, policyRepository))) throw new Error("policy repository is not in the organization allowlist");
}
async function selectPolicy(ctx: ExtensionCommandContext, binding: Awaited<ReturnType<typeof detectRepository>>, requested: string | undefined): Promise<{ path: string; cleanup: () => Promise<void> }> {
  if (!binding) throw new Error("active directory must have one exact github.com origin");
  const settings = await loadSettings(binding.root); const materialized = await materializePolicies(binding, settings); const paths = materialized.policies;
  const selected = requested ? paths.find((item) => item.name === requested || item.path === requested || item.sourcePath.endsWith("/" + requested)) : paths.length === 1 ? paths[0] : undefined;
  let policy = selected;
  if (!policy && paths.length > 1 && ctx.hasUI) { const name = await ctx.ui.select("Select runner policy", paths.map((item) => item.name)); policy = paths.find((item) => item.name === name); }
  if (!policy) { await materialized.cleanup(); throw new Error(paths.length ? "select a policy with --policy" : "no runner policies are configured; monitoring remains available"); }
  const loaded = await loadPolicy(policy.path); assertBindingAllowed(binding, settings, loaded.config.repository);
  return { path: policy.path, cleanup: materialized.cleanup };
}
async function confirmApply(ctx: ExtensionCommandContext, binding: { repository: string }, operation: string, target: string, detail: string): Promise<boolean> {
  if (!ctx.hasUI || ctx.mode !== "tui") throw new Error("--apply requires an interactive TUI session");
  if (!await ctx.ui.confirm("Apply runner plan?", `Repository: ${binding.repository}\nOperation: ${operation}\nTarget: ${target}\n\n${detail}`)) return false;
  return ctx.ui.confirm("Single controller assurance", "Stop any other runner controller now. Confirm that you are the sole writer for this repository and pool.");
}
async function invokeRemote(ctx: ExtensionCommandContext, binding: NonNullable<Awaited<ReturnType<typeof detectRepository>>>, parsed: Parsed, settings: RunnerSettings): Promise<void> {
  const installation = settings.reaper!;
  if (parsed.operation === "refresh") throw new Error("refresh is local read monitoring; use status for the installed reaper");
  const request: ReaperRequest = { operation: parsed.operation as ReaperRequest["operation"], policy: parsed.policy, capacity: parsed.capacity === undefined ? undefined : Number(parsed.capacity), instance: parsed.instance, apply: false };
  const dry = await requestReaper(installation, request);
  if (!parsed.apply) { output(ctx, dry.text || `remote reaper exited ${dry.code}`, dry.code ? "warning" : "info"); return; }
  const expectedPlanFingerprint = planFingerprintFrom(dry.text);
  if (dry.code || !expectedPlanFingerprint) throw new Error(dry.text || "remote reaper did not return a complete warning-free plan");
  if (!await confirmApply(ctx, binding, parsed.operation, parsed.instance ?? parsed.capacity ?? "policy plan", dry.text)) return;
  const applied = await requestReaper(installation, { ...request, apply: true, expectedPlanFingerprint });
  output(ctx, applied.text || `remote reaper exited ${applied.code}`, applied.code ? "warning" : "info");
}
async function invokeCore(ctx: ExtensionCommandContext, parsed: Parsed, monitor: RunnerMonitor | undefined): Promise<void> {
  const binding = await detectRepository(ctx.cwd); if (!binding) throw new Error("active directory must have one exact github.com origin");
  const settings = await loadSettings(binding.root);
  if (parsed.operation === "refresh") { const state = await readMonitorState(binding.repository, undefined, undefined, settings.mode === "global" ? settings.organization?.name : undefined); output(ctx, state.kind === "ok" ? `${footerText(state)}; ${state.total - state.online} offline` : "GitHub runner status is unavailable", state.kind === "ok" ? "info" : "warning"); monitor?.refreshNow(); return; }
  if (settings.reaper) { await invokeRemote(ctx, binding, parsed, settings); return; }
  if (parsed.operation === "status" && !parsed.policy) { const state = await readMonitorState(binding.repository, undefined, undefined, settings.mode === "global" ? settings.organization?.name : undefined); output(ctx, state.kind === "ok" ? `${footerText(state)}; ${state.total - state.online} offline` : "GitHub runner status is unavailable", state.kind === "ok" ? "info" : "warning"); monitor?.refreshNow(); return; }
  const selected = await selectPolicy(ctx, binding, parsed.policy); const snapshot = await snapshotPolicy(selected.path);
  try {
    const policy = await loadPolicy(snapshot.path); assertBindingAllowed(binding, settings, policy.config.repository); const env: NodeJS.ProcessEnv = { ...process.env };
    if (!env[policy.credentials.githubTokenEnv]) { const token = await ghToken(binding.root); if (!token) throw new Error("GitHub credentials are unavailable; authenticate with gh or supply the policy token environment variable"); env[policy.credentials.githubTokenEnv] = token; }
    const run = async (apply: boolean, expectedPlanFingerprint?: string) => { const stdout: string[] = []; const stderr: string[] = []; const args = [parsed.operation, "--config", snapshot.path]; if (parsed.capacity) args.push("--capacity", parsed.capacity); if (parsed.instance) args.push("--instance", parsed.instance); if (apply) args.push("--apply"); const code = await runCli(args, env, { stdout: (value) => stdout.push(value), stderr: (value) => stderr.push(value) }, undefined, expectedPlanFingerprint ? { expectedPlanFingerprint } : undefined); return { code, text: [...stdout, ...stderr].join("\n") }; };
    if (!parsed.apply) { const result = await run(false); output(ctx, result.text || `runner-manager exited ${result.code}`, result.code ? "warning" : "info"); return; }
    const dry = await run(false); const expectedPlanFingerprint = planFingerprintFrom(dry.text);
    if (dry.code || !expectedPlanFingerprint) throw new Error(dry.text || "unable to prepare a complete warning-free mutation plan");
    if (!await confirmApply(ctx, binding, parsed.operation, parsed.instance ?? parsed.capacity ?? "policy plan", dry.text)) return;
    const result = await run(true, expectedPlanFingerprint); output(ctx, result.text || `runner-manager exited ${result.code}`, result.code ? "warning" : "info");
  } finally { await snapshot.cleanup(); await selected.cleanup(); }
}
async function manageReaper(ctx: ExtensionCommandContext, action: "install" | "status" | "uninstall", stopAutomation: () => Promise<void>): Promise<void> {
  const binding = await detectRepository(ctx.cwd); if (!binding) throw new Error("active directory must have one exact github.com origin");
  const settings = await loadSettings(binding.root);
  if (action === "status") { if (!settings.reaper) throw new Error("no reaper is installed for these settings"); output(ctx, await reaperStatus(settings.reaper)); return; }
  if (action === "install") {
    if (!ctx.hasUI || ctx.mode !== "tui") throw new Error("reaper installation requires an interactive TUI session");
    const sshTarget = await ctx.ui.input("SSH target (existing authenticated alias or user@host)"); if (!sshTarget) return;
    const environmentFile = await ctx.ui.input("Private remote EnvironmentFile absolute path (already provisioned; no token will be copied)"); if (!environmentFile) return;
    if (settings.reaper && (settings.reaper.sshTarget !== sshTarget || settings.reaper.installationId !== reaperInstallationId(binding, settings))) throw new Error("a different remote reaper is installed; uninstall it explicitly before changing its SSH host or installation scope");
    if (!await ctx.ui.confirm("Install remote reaper?", `This installs a systemd user service on ${sshTarget}. Stop the old controller first: it must be the sole writer. No token will be copied; ${environmentFile} must already exist remotely.`)) return;
    await stopAutomation();
    const installation = await installReaper(binding, settings, { sshTarget, environmentFile });
    await saveSettings(binding.root, { ...settings, reaper: installation });
    output(ctx, `Remote reaper installed on ${installation.sshTarget}`);
    return;
  }
  if (!settings.reaper) throw new Error("no reaper is installed for these settings");
  if (!ctx.hasUI || ctx.mode !== "tui") throw new Error("reaper uninstall requires an interactive TUI session");
  if (!await ctx.ui.confirm("Uninstall remote reaper?", `This stops and removes the owned service on ${settings.reaper.sshTarget}. Runner VMs remain billable and the remote credential file remains.`)) return;
  await stopAutomation();
  await uninstallReaper(settings.reaper);
  const { reaper: _removed, ...withoutReaper } = settings;
  await saveSettings(binding.root, withoutReaper);
  output(ctx, "Remote reaper uninstalled; runner VMs were not changed.");
}
export default function (pi: ExtensionAPI): void {
  let monitor: RunnerMonitor | undefined; let automation: RunnerAutomation | undefined; let activeKey: string | undefined; let status: MonitorState = { kind: "unknown", error: "not refreshed" }; let startupSent = false;
  const show = (ctx: { ui: { setStatus(key: string, text: string | undefined): void } }) => ctx.ui.setStatus("github-runners", footerText(status));
  const stop = async (): Promise<void> => {
    const previousMonitor = monitor; const previousAutomation = automation;
    monitor = undefined; automation = undefined; activeKey = undefined;
    previousMonitor?.stop();
    await previousAutomation?.stop();
  };
  const bindNow = async (ctx: ExtensionContext): Promise<void> => {
    if (ctx.mode !== "tui") return; const binding = await detectRepository(ctx.cwd); const key = binding && `${binding.root}:${binding.repository}`;
    if (!binding) { await stop(); status = { kind: "unknown", error: "no GitHub repository" }; show(ctx); return; }
    if (key === activeKey) return;
    await stop();
    try {
      const settings = await loadSettings(binding.root); activeKey = key;
      monitor = new RunnerMonitor(binding.repository, settings.pollIntervalSeconds * 1000, (next) => { status = next; show(ctx); }, settings.mode === "global" ? settings.organization?.name : undefined);
      if (settings.reaper) { if (settings.startOnLoad && !startupSent) { startupSent = true; void requestReaper(settings.reaper, { operation: "startup" }).catch((error) => { status = { kind: "unknown", error: error instanceof Error ? error.message : "remote reaper startup failed" }; show(ctx); }); } }
      else automation = new RunnerAutomation(binding, settings, (message) => { if (message) { status = { kind: "unknown", error: message }; show(ctx); } });
      show(ctx); monitor.start(); automation?.start();
    } catch (error) { status = { kind: "unknown", error: error instanceof Error ? error.message : "settings failed" }; show(ctx); }
  };
  let bindQueue: Promise<void> = Promise.resolve();
  const bind = (ctx: ExtensionContext): Promise<void> => {
    const next = bindQueue.then(() => bindNow(ctx));
    bindQueue = next.catch(() => undefined);
    return next;
  };
  pi.on("session_start", async (_event, ctx) => { await bind(ctx); });
  pi.on("session_shutdown", async () => { await bindQueue; await stop(); });
  pi.registerCommand("runners", { description: "Show or safely manage GitHub Actions runners for the active repository", handler: async (input, ctx) => {
    try {
      await bind(ctx); const value = input.trim() ? input.trim() : await choose(ctx); if (!value) { output(ctx, usage); return; }
      if (value === "settings") { const binding = await detectRepository(ctx.cwd); if (!binding) throw new Error("active directory must have one exact github.com origin"); if (await configureRunners(ctx, binding)) { await stop(); await bind(ctx); } return; }
      const reaper = /^reaper\s+(install|status|uninstall)$/.exec(value); if (reaper) { await manageReaper(ctx, reaper[1] as "install" | "status" | "uninstall", stop); return; }
      await invokeCore(ctx, parseRunnerCommand(value), monitor);
    } catch (error) { output(ctx, error instanceof Error ? error.message : "runner command failed", "error"); }
  } });
}
