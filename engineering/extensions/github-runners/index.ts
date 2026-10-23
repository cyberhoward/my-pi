import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { footerText, readMonitorState, RunnerMonitor, type MonitorState } from "./monitor.js";
import { detectRepository, nodeCommandRunner, sameRepository } from "./repository.js";
import { loadSettings, saveSettings, type RunnerSettings } from "./settings.js";
import { configureRunners } from "./settings-menu.js";
import { setupRunners } from "./setup.js";
import { createSetupServices } from "./setup-services.js";
import { materializePolicies } from "./policies.js";
import { RunnerAutomation } from "./automation.js";
import { loadPolicy } from "./src/config.js";
import { planFingerprint, runCli } from "./src/cli.js";
import { applyBulkPlans, bulkPreviewText, bulkScope, decodeRemoteBulk, prepareBulkPlans, type BulkResult } from "./bulk.js";
import { installReaper, reaperInstallationId, reaperStatus, requestReaper, uninstallReaper, type ReaperRequest } from "./remote-reaper.js";
import { selectSshTarget } from "./ssh-hosts.js";

const usage = "Usage: /runners [setup|reset|settings|status|refresh|ensure|reconcile|drain|destroy|reaper install|reaper status|reaper uninstall] [--policy <path-or-selected-policy>] [--capacity N] [--instance UUID|--all] [--apply]";
const completions = [
  { value: "setup", label: "setup", description: "Guided configuration setup" },
  { value: "reset", label: "reset", description: "Fresh guided setup; saves only after review" },
  { value: "settings", label: "settings", description: "Edit runner settings" },
  { value: "status", label: "status", description: "Show runner status" },
  { value: "refresh", label: "refresh", description: "Refresh runner status" },
  { value: "ensure", label: "ensure", description: "Plan or apply runner capacity" },
  { value: "reconcile", label: "reconcile", description: "Plan or apply reconciliation" },
  { value: "drain", label: "drain", description: "Plan or apply runner drain" },
  { value: "destroy", label: "destroy", description: "Plan or apply runner destruction" },
  { value: "destroy --all", label: "destroy --all", description: "Plan or apply destruction of all managed runners" },
  { value: "reaper install", label: "reaper install", description: "Install remote controller" },
  { value: "reaper status", label: "reaper status", description: "Show remote controller status" },
  { value: "reaper uninstall", label: "reaper uninstall", description: "Uninstall remote controller" },
];
const operations = new Set(["status", "refresh", "ensure", "reconcile", "drain", "destroy"]);
type Parsed = { operation: string; policy?: string; capacity?: string; instance?: string; all: boolean; apply: boolean };
type CorePlan = { warnings?: string[]; operations?: unknown[] };
type CoreOutput = { plan?: CorePlan };
type PolicySnapshot = { name: string; path: string; cleanup: () => Promise<void>; env: NodeJS.ProcessEnv };

export function parseRunnerCommand(input: string): Parsed {
  const argv = input.trim().split(/\s+/).filter(Boolean);
  const operation = argv.shift() ?? "";
  if (!operations.has(operation)) throw new Error(usage);
  const parsed: Parsed = { operation, all: false, apply: false };
  while (argv.length) {
    const flag = argv.shift();
    if (flag === "--apply") { if (parsed.apply) throw new Error(usage); parsed.apply = true; continue; }
    if (flag === "--all") { if (parsed.all) throw new Error(usage); parsed.all = true; continue; }
    if (flag === "--policy" || flag === "--capacity" || flag === "--instance") {
      const value = argv.shift(); if (!value) throw new Error(usage);
      if (flag === "--policy") parsed.policy = value;
      if (flag === "--capacity") parsed.capacity = value;
      if (flag === "--instance") parsed.instance = value;
      continue;
    }
    throw new Error(usage);
  }
  if (parsed.operation === "refresh" && (parsed.apply || parsed.policy || parsed.capacity || parsed.instance || parsed.all)) throw new Error(usage);
  if (parsed.operation !== "ensure" && parsed.capacity) throw new Error(usage);
  if (!["drain", "destroy"].includes(parsed.operation) && parsed.instance) throw new Error(usage);
  if (parsed.all && parsed.operation !== "destroy") throw new Error("--all is only valid for destroy\n" + usage);
  if (parsed.all && parsed.instance) throw new Error("--all and --instance are mutually exclusive\n" + usage);
  if (["drain", "destroy"].includes(parsed.operation) && !parsed.instance && !parsed.all) throw new Error("--instance is required\n" + usage);
  if (["status", "refresh"].includes(parsed.operation) && parsed.apply) throw new Error("--apply is only valid for management operations");
  return parsed;
}
function output(ctx: ExtensionCommandContext, text: string, type: "info" | "warning" | "error" = "info"): void { if (ctx.hasUI) ctx.ui.notify(text, type); else console.log(text); }
function parseOutput(text: string): CoreOutput | undefined { for (const line of text.split(/\r?\n/)) { try { return JSON.parse(line) as CoreOutput; } catch {} } return undefined; }
function planFingerprintFrom(text: string): string | undefined { const plan = parseOutput(text)?.plan; return plan && !plan.warnings?.length && Array.isArray(plan.operations) ? planFingerprint(plan as Parameters<typeof planFingerprint>[0]) : undefined; }
async function choose(ctx: ExtensionCommandContext): Promise<string | undefined> { return ctx.hasUI ? ctx.ui.select("GitHub runners", ["setup", "reset", "settings", "status", "refresh", "ensure", "reconcile", "drain", "destroy", "destroy --all", "reaper install", "reaper status", "reaper uninstall"]) : undefined; }
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
  if (!await ctx.ui.confirm("Apply runner plan?", `Active repository: ${binding.repository}\nOperation: ${operation}\nTarget: ${target}\n\n${detail}`)) return false;
  return ctx.ui.confirm("Single controller assurance", "Stop any other runner controller now. Confirm that you are the sole writer for this repository and pool.");
}
async function invokeRemote(ctx: ExtensionCommandContext, binding: NonNullable<Awaited<ReturnType<typeof detectRepository>>>, parsed: Parsed, settings: RunnerSettings): Promise<void> {
  const installation = settings.reaper!;
  if (parsed.operation === "refresh") throw new Error("refresh is local read monitoring; use status for the installed reaper");
  const request: ReaperRequest = { operation: parsed.operation as ReaperRequest["operation"], policy: parsed.policy, capacity: parsed.capacity === undefined ? undefined : Number(parsed.capacity), instance: parsed.instance, ...(parsed.all ? { all: true } : {}), apply: false };
  const dry = await requestReaper(installation, request);
  if (parsed.all) {
    const results = decodeRemoteBulk(dry, parsed.policy);
    const detail = `${results[0]?.scope ?? "No remote runner policies are configured."}\n\n${bulkPreviewText(results)}`;
    if (!parsed.apply) { output(ctx, detail); return; }
    const plans = prepareBulkPlans(results);
    const applied = await applyBulkPlans(plans, () => confirmApply(ctx, binding, "destroy --all", "ALL managed runners in the displayed scope", detail), async plan => {
      const result = await requestReaper(installation, { operation: "destroy", all: true, policy: plan.policy, apply: true, expectedPlanFingerprint: plan.fingerprint, expectedScopeFingerprint: plan.scopeFingerprint });
      return { policy: plan.policy, code: result.code, output: result.text };
    });
    reportBulk(ctx, applied);
    return;
  }
  if (!parsed.apply) { output(ctx, dry.text || `remote reaper exited ${dry.code}`, dry.code ? "warning" : "info"); return; }
  const expectedPlanFingerprint = planFingerprintFrom(dry.text);
  if (dry.code || !expectedPlanFingerprint) throw new Error(dry.text || "remote reaper did not return a complete warning-free plan");
  if (!await confirmApply(ctx, binding, parsed.operation, parsed.instance ?? parsed.capacity ?? "policy plan", dry.text)) return;
  const applied = await requestReaper(installation, { ...request, apply: true, expectedPlanFingerprint });
  output(ctx, applied.text || `remote reaper exited ${applied.code}`, applied.code ? "warning" : "info");
}
function reportBulk(ctx: ExtensionCommandContext, results: BulkResult[]): void {
  if (!results.length) return;
  const failed = results.some(result => result.code !== 0);
  output(ctx, `${bulkPreviewText(results)}\n\n${failed ? "Stopped on a partial failure. Re-preview before retrying; earlier successful operations were not rolled back." : "Safe destroy tick completed. Runners may now be draining; rerun after the configured quiescence period to finish deletion. Automation can recreate deleted runners."}`, failed ? "warning" : "info");
}
async function invokeBulkCore(ctx: ExtensionCommandContext, parsed: Parsed, binding: NonNullable<Awaited<ReturnType<typeof detectRepository>>>, settings: RunnerSettings): Promise<void> {
  const materialized = await materializePolicies(binding, settings);
  const snapshots: PolicySnapshot[] = [];
  try {
    const policies = parsed.policy ? materialized.policies.filter(item => item.name === parsed.policy || item.path === parsed.policy || item.sourcePath.endsWith("/" + parsed.policy)) : materialized.policies;
    if (parsed.policy && policies.length !== 1) throw new Error("select one configured policy with --policy");
    if (!policies.length) { output(ctx, "No runner policies are configured; no resources were changed."); return; }
    for (const selected of policies) {
      const snapshot = await snapshotPolicy(selected.path);
      const entry: PolicySnapshot = { name: selected.name, ...snapshot, env: { ...process.env } };
      snapshots.push(entry);
      const policy = await loadPolicy(snapshot.path);
      assertBindingAllowed(binding, settings, policy.config.repository);
      if (!entry.env[policy.credentials.githubTokenEnv]) {
        const token = await ghToken(binding.root);
        if (!token) throw new Error("GitHub credentials are unavailable for the complete bulk preview");
        entry.env[policy.credentials.githubTokenEnv] = token;
      }
    }
    const run = async (policy: PolicySnapshot, fingerprint?: string): Promise<BulkResult> => {
      const lines: string[] = [];
      const code = await runCli(["destroy", "--all", "--config", policy.path, ...(fingerprint ? ["--apply"] : [])], policy.env, { stdout: text => lines.push(text), stderr: text => lines.push(text) }, undefined, { expectedPlanFingerprint: fingerprint });
      return { policy: policy.name, code, output: lines.join("\n") };
    };
    const results: BulkResult[] = [];
    for (const snapshot of snapshots) results.push(await run(snapshot));
    const detail = `${bulkScope(binding.repository, settings)}\n\n${bulkPreviewText(results)}`;
    if (!parsed.apply) { output(ctx, detail, results.some(result => result.code !== 0) ? "warning" : "info"); return; }
    const plans = prepareBulkPlans(results);
    const applied = await applyBulkPlans(plans, () => confirmApply(ctx, binding, "destroy --all", "ALL managed runners in the displayed scope", detail), plan => run(snapshots.find(snapshot => snapshot.name === plan.policy)!, plan.fingerprint));
    reportBulk(ctx, applied);
  } finally {
    for (const snapshot of snapshots) await snapshot.cleanup();
    await materialized.cleanup();
  }
}
async function invokeCore(ctx: ExtensionCommandContext, parsed: Parsed, monitor: RunnerMonitor | undefined): Promise<void> {
  const binding = await detectRepository(ctx.cwd); if (!binding) throw new Error("active directory must have one exact github.com origin");
  const settings = await loadSettings(binding.root);
  if (parsed.operation === "refresh") { const state = await readMonitorState(binding.repository, undefined, undefined, settings.mode === "global" ? settings.organization?.name : undefined); output(ctx, state.kind === "ok" ? `${footerText(state)}; ${state.total - state.online} offline` : "GitHub runner status is unavailable", state.kind === "ok" ? "info" : "warning"); monitor?.refreshNow(); return; }
  if (settings.reaper) { await invokeRemote(ctx, binding, parsed, settings); return; }
  if (parsed.all) { await invokeBulkCore(ctx, parsed, binding, settings); return; }
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
    const sshTarget = await selectSshTarget(ctx.ui); if (!sshTarget) return;
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
  const automationNotifications = new Map<string, Set<string>>();
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
      else automation = new RunnerAutomation(binding, settings, (message) => {
        const previous = automationNotifications.get(key!);
        if (message) {
          status = { kind: "unknown", error: message }; show(ctx);
          if (!previous?.has(message)) { const messages = previous ?? new Set<string>(); messages.add(message); automationNotifications.set(key!, messages); ctx.ui.notify(message, "warning"); }
        } else if (previous?.size) {
          automationNotifications.delete(key!);
          ctx.ui.notify("GitHub runner automation recovered", "info");
        }
      });
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
  pi.registerCommand("runners", { description: "Set up, reset, or safely manage GitHub Actions runners for the active repository", getArgumentCompletions: (prefix) => {
    const matches = completions.filter((item) => item.value.startsWith(prefix));
    return matches.length ? matches : null;
  }, handler: async (input, ctx) => {
    try {
      const value = input.trim() ? input.trim() : await choose(ctx); if (!value) { output(ctx, usage); return; }
      if (value === "setup" || value === "reset" || value === "settings") {
        const binding = await detectRepository(ctx.cwd);
        if (!binding) throw new Error("active directory must have one exact github.com origin");
        const setup = (fresh = false) => setupRunners(ctx, binding, createSetupServices(binding), fresh ? { fresh: true } : undefined);
        const saved = value === "setup" ? await setup() : value === "reset" ? await setup(true) : await configureRunners(ctx, binding, { onGuidedSetup: setup });
        if (saved) { await stop(); await bind(ctx); }
        return;
      }
      await bind(ctx);
      const reaper = /^reaper\s+(install|status|uninstall)$/.exec(value); if (reaper) { await manageReaper(ctx, reaper[1] as "install" | "status" | "uninstall", stop); return; }
      await invokeCore(ctx, parseRunnerCommand(value), monitor);
    } catch (error) { output(ctx, error instanceof Error ? error.message : "runner command failed", "error"); }
  } });
}
