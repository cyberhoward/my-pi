import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RepositoryBinding } from "./repository.js";
import type { RunnerSettings } from "./settings.js";
import { poolActivity, type ActivityDependencies } from "./activity.js";
import { materializePolicies, type MaterializedPolicy } from "./policies.js";
import { loadPolicy } from "./src/config.js";
import { planFingerprint, runCli } from "./src/cli.js";

const executeFile = promisify(execFile);
type Settings = RunnerSettings & { pollIntervalSeconds: number; standbyMinutes?: number; startOnLoad?: boolean; automationEnabled?: boolean; organization?: { repositories: string[] } };
type Plan = { warnings?: string[]; operations?: Array<{ kind?: string }> };
type Output = { plan?: Plan; servers?: Array<{ createdAt?: string }> };
export interface AutomationDependencies {
  runCli?: typeof runCli;
  materialize?: typeof materializePolicies;
  activity?: typeof poolActivity;
  ghToken?: (cwd: string, signal: AbortSignal) => Promise<string | undefined>;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  activityDependencies?: ActivityDependencies;
  activityFloor?: () => Promise<Date | undefined>;
  onPrewarm?: (at: Date) => Promise<void>;
}

function parse(lines: string[]): Output | undefined {
  for (const line of lines) { try { return JSON.parse(line) as Output; } catch {} }
  return undefined;
}
function fingerprint(plan: Plan): string { return planFingerprint(plan as Parameters<typeof planFingerprint>[0]); }
async function defaultGhToken(cwd: string, signal: AbortSignal): Promise<string | undefined> {
  try {
    const value = await executeFile("gh", ["auth", "token", "--hostname", "github.com"], { cwd, timeout: 5_000, maxBuffer: 16 * 1024, signal, encoding: "utf8" });
    return value.stdout.trim() || undefined;
  } catch { return undefined; }
}

export class RunnerAutomation {
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running = false;
  #tickPromise: Promise<void> | undefined;
  #stopped = false;
  #generation = 0;
  #controller: AbortController | undefined;
  #prewarmed = new Set<string>();
  #prewarmAt = new Map<string, Date>();
  #reportedStatus = false;
  readonly #deps: Required<Pick<AutomationDependencies, "runCli" | "materialize" | "activity" | "ghToken" | "now" | "env">> & AutomationDependencies;
  constructor(readonly binding: RepositoryBinding, readonly settings: RunnerSettings, readonly onStatus: (message: string | undefined) => void, deps: AutomationDependencies = {}) {
    this.#deps = { runCli, materialize: materializePolicies, activity: poolActivity, ghToken: defaultGhToken, now: () => new Date(), env: process.env, ...deps };
  }
  start(): void { if (!this.#stopped) void this.tick(); }
  stop(): Promise<void> {
    this.#stopped = true;
    this.#generation++;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#controller?.abort();
    return this.#tickPromise ?? Promise.resolve();
  }
  #schedule(): void {
    if (this.#stopped || this.#timer) return;
    const seconds = (this.settings as Settings).pollIntervalSeconds;
    this.#timer = setTimeout(() => { this.#timer = undefined; void this.tick(); }, Math.max(5, seconds) * 1000);
    this.#timer.unref?.();
  }
  async tick(): Promise<void> {
    if (this.#stopped) return;
    if (this.#tickPromise) return this.#tickPromise;
    const task = this.#runTick();
    this.#tickPromise = task;
    void task.then(() => { if (this.#tickPromise === task) this.#tickPromise = undefined; }, () => { if (this.#tickPromise === task) this.#tickPromise = undefined; });
    return task;
  }
  async #runTick(): Promise<void> {
    this.#running = true;
    this.#reportedStatus = false;
    const generation = this.#generation;
    const controller = new AbortController();
    this.#controller = controller;
    try {
      const result = await this.#deps.materialize(this.binding, this.settings);
      try {
        for (const policy of result.policies) {
          if (this.#stopped || generation !== this.#generation || controller.signal.aborted) return;
          await this.#reconcile(policy, controller.signal, generation);
        }
      } finally { await result.cleanup(); }
      if (!this.#stopped && generation === this.#generation && !this.#reportedStatus) this.onStatus(undefined);
    } catch (error) {
      if (!this.#stopped && generation === this.#generation) this.onStatus(error instanceof Error ? error.message : "runner automation failed");
    } finally {
      if (this.#controller === controller) this.#controller = undefined;
      this.#running = false;
      this.#schedule();
    }
  }
  async #credentials(policy: MaterializedPolicy, signal: AbortSignal): Promise<{ env: NodeJS.ProcessEnv; githubToken: string } | undefined> {
    const loaded = await loadPolicy(policy.path);
    const env: NodeJS.ProcessEnv = { ...this.#deps.env };
    if (!env[loaded.credentials.hcloudTokenEnv]) return undefined;
    let githubToken = env[loaded.credentials.githubTokenEnv];
    if (!githubToken) {
      githubToken = await this.#deps.ghToken(this.binding.root, signal);
      if (!githubToken || signal.aborted) return undefined;
      env[loaded.credentials.githubTokenEnv] = githubToken;
    }
    return { env, githubToken };
  }
  async #call(args: string[], env: NodeJS.ProcessEnv, expectedPlanFingerprint?: string): Promise<{ code: number; result?: Output }> {
    const out: string[] = []; const err: string[] = [];
    const core = this.#deps.runCli as unknown as (input: string[], environment: NodeJS.ProcessEnv, io: { stdout(value: string): void; stderr(value: string): void }, fetcher?: typeof fetch, options?: { expectedPlanFingerprint?: string }) => Promise<number>;
    const code = await core(args, env, { stdout: (line) => out.push(line), stderr: (line) => err.push(line) }, undefined, expectedPlanFingerprint ? { expectedPlanFingerprint } : undefined);
    return { code, result: parse([...out, ...err]) };
  }
  #current(generation: number, signal: AbortSignal): boolean { return !this.#stopped && generation === this.#generation && !signal.aborted; }
  async #ensure(policy: MaterializedPolicy, env: NodeJS.ProcessEnv, capacity: number, signal: AbortSignal, generation: number): Promise<boolean> {
    const dry = await this.#call(["ensure", "--capacity", String(capacity), "--config", policy.path], env);
    if (!this.#current(generation, signal) || dry.code || !dry.result?.plan || dry.result.plan.warnings?.length) return false;
    const applied = await this.#call(["ensure", "--capacity", String(capacity), "--config", policy.path, "--apply"], env, fingerprint(dry.result.plan));
    return this.#current(generation, signal) && applied.code === 0;
  }
  async #reconcile(policy: MaterializedPolicy, signal: AbortSignal, generation: number): Promise<void> {
    const settings = this.settings as Settings;
    if (!settings.automationEnabled || this.#deps.env.RUNNER_MANAGER_ALLOW_MUTATIONS !== "1" || !this.#current(generation, signal)) return;
    const credentials = await this.#credentials(policy, signal);
    if (!credentials || !this.#current(generation, signal)) { if (this.#current(generation, signal)) { this.#reportedStatus = true; this.onStatus("runner automation is waiting for credentials"); } return; }
    const repositories = settings.mode === "global" ? settings.organization?.repositories ?? [] : [this.binding.repository];
    const activity = await this.#deps.activity(repositories, credentials.githubToken, { ...this.#deps.activityDependencies, signal });
    if (!this.#current(generation, signal)) return;
    if (activity.kind === "unknown") { this.#reportedStatus = true; this.onStatus("runner automation skipped: activity is unknown"); return; }
    const loaded = await loadPolicy(policy.path);
    const now = this.#deps.now();
    if (activity.kind === "active") {
      await this.#ensure(policy, credentials.env, loaded.config.pool.maxSize, signal, generation);
      return;
    }
    if (settings.startOnLoad && !this.#prewarmed.has(policy.name)) {
      if (await this.#ensure(policy, credentials.env, loaded.config.pool.maxSize, signal, generation)) {
        this.#prewarmed.add(policy.name);
        this.#prewarmAt.set(policy.name, now);
        await this.#deps.onPrewarm?.(now);
      }
      return;
    }
    const status = await this.#call(["status", "--config", policy.path], credentials.env);
    if (!this.#current(generation, signal) || status.code || !status.result?.plan || status.result.plan.warnings?.length) return;
    const created = (status.result.servers ?? []).map((server) => server.createdAt ? new Date(server.createdAt) : undefined).filter((value): value is Date => Boolean(value && Number.isFinite(value.getTime())));
    const floor = await this.#deps.activityFloor?.();
    if (!this.#current(generation, signal)) return;
    const last = [activity.lastActivity, floor, this.#prewarmAt.get(policy.name), ...created].filter((value): value is Date => Boolean(value)).reduce<Date | undefined>((latest, value) => !latest || value > latest ? value : latest, undefined);
    const standbyMs = (settings.standbyMinutes ?? 15) * 60_000;
    if (!last || now.getTime() - last.getTime() < standbyMs) return;
    const dry = await this.#call(["reconcile", "--config", policy.path], credentials.env);
    if (!this.#current(generation, signal) || dry.code || !dry.result?.plan || dry.result.plan.warnings?.length) return;
    await this.#call(["reconcile", "--config", policy.path, "--apply"], credentials.env, fingerprint(dry.result.plan));
  }
}
