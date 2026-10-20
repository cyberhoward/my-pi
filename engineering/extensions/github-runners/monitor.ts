import { nodeCommandRunner, type CommandRunner } from "./repository.js";

export interface GitHubRunner { busy: boolean; status: string }
export interface RunnerInventory { runners: GitHubRunner[]; total: number }
export type MonitorState = { kind: "ok"; busy: number; online: number; total: number } | { kind: "unknown"; error: string };

export async function listGitHubRunners(repository: string, run: CommandRunner = nodeCommandRunner, signal?: AbortSignal, organization?: string): Promise<RunnerInventory> {
  const runners: GitHubRunner[] = [];
  let total: number | undefined;
  for (let page = 1; page <= 20; page++) {
    const result = await run("gh", ["api", "--hostname", "github.com", (organization ? "orgs/" + organization + "/actions/runners" : "repos/" + repository + "/actions/runners") + "?per_page=100&page=" + page], {
      cwd: process.cwd(), timeoutMs: 10_000, maxBuffer: 1024 * 1024, signal,
    });
    if (Buffer.byteLength(result.stdout) > 1024 * 1024) throw new Error("GitHub response exceeds page limit");
    const value: unknown = JSON.parse(result.stdout);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid GitHub runner response");
    const body = value as { total_count?: unknown; runners?: unknown };
    if (!Number.isInteger(body.total_count) || (body.total_count as number) < 0 || !Array.isArray(body.runners)) throw new Error("invalid GitHub runner response");
    total ??= body.total_count as number;
    if (total !== body.total_count) throw new Error("inconsistent GitHub runner pagination");
    for (const item of body.runners) {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("invalid GitHub runner record");
      const runner = item as { busy?: unknown; status?: unknown };
      if (typeof runner.busy !== "boolean" || typeof runner.status !== "string") throw new Error("invalid GitHub runner record");
      runners.push({ busy: runner.busy, status: runner.status });
    }
    if (runners.length >= total || body.runners.length === 0) return { runners: runners.slice(0, total), total };
  }
  throw new Error("GitHub runner pagination limit reached");
}

export async function readMonitorState(repository: string, run: CommandRunner = nodeCommandRunner, signal?: AbortSignal, organization?: string): Promise<MonitorState> {
  try {
    const inventory = await listGitHubRunners(repository, run, signal, organization);
    const online = inventory.runners.filter((runner) => runner.status.toLowerCase() === "online");
    return { kind: "ok", busy: online.filter((runner) => runner.busy).length, online: online.length, total: inventory.total };
  } catch (error) {
    return { kind: "unknown", error: error instanceof Error ? error.message : "GitHub monitoring failed" };
  }
}

export function footerText(state: MonitorState): string {
  return state.kind === "ok" ? `${state.busy}/${state.online} runners` : "?/? runners";
}

export class RunnerMonitor {
  #timer: ReturnType<typeof setTimeout> | undefined;
  #controller: AbortController | undefined;
  #generation = 0;
  #running = false;
  #refreshRequested = false;
  readonly #organization?: string;
  readonly #read: typeof readMonitorState;
  constructor(private readonly repository: string, private readonly intervalMs: number, private readonly update: (state: MonitorState) => void, organizationOrRead?: string | typeof readMonitorState, read = readMonitorState) {
    this.#organization = typeof organizationOrRead === "string" ? organizationOrRead : undefined;
    this.#read = typeof organizationOrRead === "function" ? organizationOrRead : read;
  }
  start(): void { this.stop(); this.#generation++; void this.refresh(this.#generation); }
  stop(): void { this.#generation++; this.#refreshRequested = false; this.#controller?.abort(); this.#controller = undefined; if (this.#timer) clearTimeout(this.#timer); this.#timer = undefined; }
  refreshNow(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#running) { this.#refreshRequested = true; return; }
    void this.refresh(this.#generation);
  }
  async refresh(generation: number): Promise<void> {
    if (this.#running || generation !== this.#generation) return;
    this.#running = true;
    const controller = new AbortController();
    this.#controller = controller;
    try { const state = await this.#read(this.repository, nodeCommandRunner, controller.signal, this.#organization); if (generation === this.#generation && !controller.signal.aborted) this.update(state); }
    finally {
      this.#running = false;
      if (this.#controller === controller) this.#controller = undefined;
      if (generation === this.#generation) {
        const delay = this.#refreshRequested ? 0 : this.intervalMs;
        this.#refreshRequested = false;
        this.#timer = setTimeout(() => { this.#timer = undefined; void this.refresh(generation); }, delay);
        this.#timer.unref?.();
      }
    }
  }
}
