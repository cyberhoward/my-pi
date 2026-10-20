export type Activity =
  | { kind: "active"; lastActivity?: Date }
  | { kind: "idle"; lastActivity?: Date }
  | { kind: "unknown"; error: string };

export interface ActivityDependencies {
  fetcher?: typeof fetch;
  now?: () => Date;
  maxPages?: number;
  signal?: AbortSignal;
}

type RunsResponse = { workflow_runs?: Array<{ status?: string; updated_at?: string }> };

const activeStatuses = new Set(["queued", "in_progress", "waiting", "pending", "requested"]);
const historyWindowMs = 36 * 24 * 60 * 60 * 1000;

function date(value: unknown): Date | undefined {
  if (typeof value !== "string") return undefined;
  const result = new Date(value);
  return Number.isFinite(result.getTime()) ? result : undefined;
}

async function runs(
  repository: string,
  status: string,
  token: string,
  deps: ActivityDependencies,
): Promise<{ complete: boolean; active: boolean; latest?: Date }> {
  const fetcher = deps.fetcher ?? fetch;
  const maxPages = deps.maxPages ?? 20;
  const query = new URLSearchParams({ status, per_page: "100" });
  if (status === "completed") query.set("created", `>=${new Date((deps.now ?? (() => new Date()))().getTime() - historyWindowMs).toISOString()}`);
  let latest: Date | undefined;
  for (let page = 1; page <= maxPages; page++) {
    query.set("page", String(page));
    const response = await fetcher(`https://api.github.com/repos/${repository}/actions/runs?${query}`, {
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" },
      signal: deps.signal,
    });
    if (!response.ok) throw new Error(`GitHub activity request failed (${response.status})`);
    const body = await response.json() as RunsResponse;
    if (!Array.isArray(body.workflow_runs)) throw new Error("GitHub activity response is incomplete");
    for (const run of body.workflow_runs) {
      if (run.status !== status) throw new Error("GitHub activity response has an unexpected status");
      const updated = date(run.updated_at);
      if (!updated) throw new Error("GitHub activity response has an invalid timestamp");
      if (!latest || updated > latest) latest = updated;
    }
    if (activeStatuses.has(status) && body.workflow_runs.length) return { complete: true, active: true, latest };
    if (body.workflow_runs.length < 100) return { complete: true, active: false, latest };
  }
  return { complete: false, active: false, latest };
}

export async function repositoryActivity(repository: string, token: string, deps: ActivityDependencies = {}): Promise<Activity> {
  try {
    const [queued, running, waiting, pending, requested, completed] = await Promise.all([
      runs(repository, "queued", token, deps),
      runs(repository, "in_progress", token, deps),
      runs(repository, "waiting", token, deps),
      runs(repository, "pending", token, deps),
      runs(repository, "requested", token, deps),
      runs(repository, "completed", token, deps),
    ]);
    const values = [queued, running, waiting, pending, requested, completed];
    if (values.some((value) => !value.complete)) return { kind: "unknown", error: "GitHub activity pagination limit reached" };
    const lastActivity = values.reduce<Date | undefined>((latest, value) => !latest || (value.latest && value.latest > latest) ? value.latest : latest, undefined);
    return values.slice(0, -1).some((value) => value.active) ? { kind: "active", lastActivity } : { kind: "idle", lastActivity };
  } catch (error) {
    return { kind: "unknown", error: error instanceof Error ? error.message : "GitHub activity is unavailable" };
  }
}

export async function poolActivity(repositories: string[], token: string, deps: ActivityDependencies = {}): Promise<Activity> {
  if (!repositories.length) return { kind: "unknown", error: "no repositories are configured" };
  const values = await Promise.all(repositories.map((repository) => repositoryActivity(repository, token, deps)));
  const unknown = values.find((value): value is Extract<Activity, { kind: "unknown" }> => value.kind === "unknown");
  if (unknown) return unknown;
  const known = values as Array<Exclude<Activity, { kind: "unknown" }>>;
  const lastActivity = known.reduce<Date | undefined>((latest, value) => !latest || (value.lastActivity && value.lastActivity > latest) ? value.lastActivity : latest, undefined);
  return known.some((value) => value.kind === "active") ? { kind: "active", lastActivity } : { kind: "idle", lastActivity };
}
