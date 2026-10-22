import { parseDocument } from "yaml";
import { collectLinkPages, type FetchLike, requestJson } from "./http.js";
import { Redactor } from "./redaction.js";
import { type GitHubRunner, ProviderFailure, Secret, type WorkflowJob } from "./types.js";

export type OrganizationScope = { name: string; repositories: string[]; runnerGroupId: number; runnerGroupName: string };
const activeStatuses = ["queued", "in_progress", "requested", "waiting", "pending"];
const drainingRunnerLabels = new Set(["self-hosted", "linux", "x64", "tau-managed", "tau-draining"]);
const hostedRunnerLabel = /^(ubuntu|macos|windows)(?:[-_]\w+)?$/i;
function workflowPath(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith(".github/workflows/") || value.includes("?") || value.includes("#")) throw new ProviderFailure("malformed GitHub workflow path");
  return value;
}
function contentPath(path: string): string { return path.split("/").map(encodeURIComponent).join("/"); }
function workflowRevisionPath(value: unknown): string {
  if (typeof value !== "string") throw new ProviderFailure("workflow routing cannot be proven");
  return workflowPath(value.split("@")[0]);
}
function assertSafeRunsOn(value: unknown): void {
  const labels = typeof value === "string" ? [value] : Array.isArray(value) && value.every((label) => typeof label === "string") ? value : undefined;
  if (!labels || labels.length === 0 || labels.some((label) => /\$\{\{/.test(label))) throw new ProviderFailure("workflow routing cannot be proven");
  const normalized = labels.map((label) => label.toLowerCase());
  if (normalized.some((label) => hostedRunnerLabel.test(label))) return;
  if (normalized.every((label) => drainingRunnerLabels.has(label) || label.startsWith("tau-instance-"))) throw new ProviderFailure("workflow routing could match a draining runner");
}
function assertSafeWorkflow(document: unknown): void {
  if (!document || typeof document !== "object" || Array.isArray(document)) throw new ProviderFailure("workflow routing cannot be proven");
  const jobs = (document as Record<string, unknown>).jobs;
  if (!jobs || typeof jobs !== "object" || Array.isArray(jobs) || Object.keys(jobs).length === 0) throw new ProviderFailure("workflow routing cannot be proven");
  for (const job of Object.values(jobs as Record<string, unknown>)) {
    if (!job || typeof job !== "object" || Array.isArray(job) || !Object.hasOwn(job, "runs-on")) throw new ProviderFailure("workflow routing cannot be proven");
    assertSafeRunsOn((job as Record<string, unknown>)["runs-on"]);
  }
}
function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProviderFailure(`malformed GitHub ${name}`);
  return value as Record<string, unknown>;
}
function runner(value: unknown): GitHubRunner {
  const v = record(value, "runner");
  if ((typeof v.id !== "number" && typeof v.id !== "string") || typeof v.name !== "string" || typeof v.busy !== "boolean" || typeof v.status !== "string" || !Array.isArray(v.labels)) throw new ProviderFailure("malformed GitHub runner");
  return { id: String(v.id), name: v.name, busy: v.busy, status: v.status, labels: v.labels.map((entry) => {
    const name = record(entry, "runner label").name;
    if (typeof name !== "string") throw new ProviderFailure("malformed GitHub runner label");
    return name;
  }) };
}
export class GitHubClient {
  readonly #headers: HeadersInit;
  readonly #safeFetcher: FetchLike;
  constructor(private readonly fetcher: FetchLike, private readonly repository: string, credential: Secret<string>, private readonly redactor = new Redactor(), private readonly organization?: OrganizationScope) {
    this.#safeFetcher = async (input, init) => {
      let url: URL;
      try { url = new URL(String(input)); } catch { throw new ProviderFailure("GitHub request URL is invalid"); }
      if (url.origin !== "https://api.github.com") throw new ProviderFailure("GitHub pagination left the official API");
      return this.fetcher(input, init);
    };
    redactor.register(credential);
    this.#headers = { accept: "application/vnd.github+json", authorization: `Bearer ${credential.reveal()}`, "x-github-api-version": "2022-11-28" };
  }
  private repoUrl(repository: string, path: string): string { return `https://api.github.com/repos/${repository}${path}`; }
  private runnerUrl(path: string): string { return this.organization ? `https://api.github.com/orgs/${this.organization.name}/actions${path}` : this.repoUrl(this.repository, `/actions${path}`); }
  async getRepository(): Promise<{ id: string; fullName: string }> {
    const url = this.organization ? `https://api.github.com/orgs/${this.organization.name}` : this.repoUrl(this.repository, "");
    const { data } = await requestJson(this.#safeFetcher, url, { headers: this.#headers });
    const v = record(data, this.organization ? "organization" : "repository");
    if ((typeof v.id !== "number" && typeof v.id !== "string") || typeof (this.organization ? v.login : v.full_name) !== "string") throw new ProviderFailure("malformed GitHub repository");
    return { id: String(v.id), fullName: String(this.organization ? v.login : v.full_name) };
  }
  async listManagedRunners(): Promise<GitHubRunner[]> {
    const all = await collectLinkPages(this.#safeFetcher, this.runnerUrl("/runners?per_page=100"), (v) => (v as any).runners ?? [], { headers: this.#headers });
    return all.map(runner).filter((value) => value.labels.includes("tau-managed"));
  }
  async createRegistrationToken(): Promise<Secret<string>> {
    const { data } = await requestJson(this.#safeFetcher, this.runnerUrl("/runners/registration-token"), { method: "POST", headers: this.#headers });
    const raw = record(data, "registration token").token;
    if (typeof raw !== "string" || !raw) throw new ProviderFailure("malformed GitHub registration token");
    const token = new Secret(raw); this.redactor.register(token); return token;
  }
  async getRunner(id: string): Promise<GitHubRunner | undefined> { const { data } = await requestJson(this.#safeFetcher, this.runnerUrl(`/runners/${id}`), { headers: this.#headers }); return data ? runner(data) : undefined; }
  async setRunnerLabels(id: string, labels: string[]): Promise<void> { await requestJson(this.#safeFetcher, this.runnerUrl(`/runners/${id}/labels`), { method: "PUT", headers: { ...this.#headers, "content-type": "application/json" }, body: JSON.stringify({ labels }) }); }
  async deleteRunner(id: string): Promise<void> { await requestJson(this.#safeFetcher, this.runnerUrl(`/runners/${id}`), { method: "DELETE", headers: this.#headers }); }
  async validateOrganizationScope(): Promise<void> {
    if (!this.organization) return;
    const groupUrl = `https://api.github.com/orgs/${this.organization.name}/actions/runner-groups/${this.organization.runnerGroupId}`;
    const { data } = await requestJson(this.#safeFetcher, groupUrl, { headers: this.#headers });
    const group = record(data, "runner group");
    if (group.name !== this.organization.runnerGroupName || group.visibility !== "selected") throw new ProviderFailure("configured organization runner group is not the selected named group");
    const entries = await collectLinkPages(this.#safeFetcher, `${groupUrl}/repositories?per_page=100`, (v) => (v as any).repositories ?? [], { headers: this.#headers });
    const actual = entries.map((item) => String(record(item, "runner group repository").full_name).toLowerCase()).sort();
    const expected = [...this.organization.repositories].map((item) => item.toLowerCase()).sort();
    if (actual.length !== expected.length || actual.some((item, index) => item !== expected[index])) throw new ProviderFailure("organization runner group repository access does not exactly match policy allowlist");
  }
  private async scanRepository(repository: string, required: string[]): Promise<{ jobs: WorkflowJob[]; provenanceComplete: boolean; signature: unknown }> {
    const runs = await this.activeRuns(repository);
    let provenanceComplete = true; const jobs: WorkflowJob[] = [];
    for (const run of runs.values()) {
      const head = run.head_repository && typeof run.head_repository === "object" && !Array.isArray(run.head_repository) ? (run.head_repository as Record<string, unknown>)["full_name"] : undefined;
      if (!head) { provenanceComplete = false; continue; }
      if (String(head).toLowerCase() !== repository.toLowerCase()) continue;
      for (const job of await collectLinkPages<any>(this.#safeFetcher, this.repoUrl(repository, `/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`), (v) => (v as any).jobs ?? [], { headers: this.#headers })) {
        const labels = job.labels ?? []; const createdAt = job.created_at;
        if (typeof createdAt !== "string" || !createdAt || !Number.isFinite(new Date(createdAt).getTime())) { provenanceComplete = false; continue; }
        if (required.every((label) => labels.map((item: string) => item.toLowerCase()).includes(label.toLowerCase()))) jobs.push({ id: `${repository}:${job.id}`, status: job.status, labels, createdAt, runnerId: job.runner_id ? String(job.runner_id) : undefined });
      }
    }
    return { jobs, provenanceComplete, signature: { repository, runs: [...runs.values()].map((run) => ({ id: String(run.id), attempt: run.run_attempt, status: run.status, head: run.head_repository && typeof run.head_repository === "object" && !Array.isArray(run.head_repository) ? (run.head_repository as Record<string, unknown>)["full_name"] : undefined })).sort((a,b) => a.id.localeCompare(b.id)), jobs: [...jobs].sort((a,b) => a.id.localeCompare(b.id)) } };
  }
  private async scanActiveMatchingJobs(required: string[]) {
    const scans = await Promise.all((this.organization?.repositories ?? [this.repository]).map((repository) => this.scanRepository(repository, required)));
    return { jobs: scans.flatMap((scan) => scan.jobs), provenanceComplete: scans.every((scan) => scan.provenanceComplete), signature: JSON.stringify(scans.map((scan) => scan.signature).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))) };
  }
  async listActiveMatchingJobs(required: string[]): Promise<{ jobs: WorkflowJob[]; provenanceComplete: boolean }> { const first = await this.scanActiveMatchingJobs(required); const second = await this.scanActiveMatchingJobs(required); return { jobs: second.jobs, provenanceComplete: first.provenanceComplete && second.provenanceComplete && first.signature === second.signature }; }
  private async activeRuns(repository: string, requireComplete = false): Promise<Map<string, Record<string, unknown>>> {
    const runs = new Map<string, Record<string, unknown>>();
    for (const status of activeStatuses) {
      let totalCount: number | undefined;
      const entries = await collectLinkPages<unknown>(this.#safeFetcher, this.repoUrl(repository, `/actions/runs?status=${status}&per_page=100`), (value) => {
        const response = record(value, "workflow runs");
        const listed = response.workflow_runs;
        if (!Array.isArray(listed)) throw new ProviderFailure("malformed GitHub workflow runs");
        if (requireComplete) {
          if (!Number.isSafeInteger(response.total_count) || (totalCount !== undefined && totalCount !== response.total_count)) throw new ProviderFailure("workflow routing cannot prove active-run pagination");
          totalCount = response.total_count as number;
        }
        return listed;
      }, { headers: this.#headers });
      if (requireComplete && totalCount !== entries.length) throw new ProviderFailure("workflow routing cannot prove active-run pagination");
      for (const entry of entries) {
        const run = record(entry, "workflow run");
        const id = run.id;
        if (typeof id !== "number" && typeof id !== "string") throw new ProviderFailure("malformed GitHub workflow run");
        runs.set(String(id), run);
      }
    }
    return runs;
  }
  private async validateWorkflowContent(repository: string, path: string, ref?: string): Promise<void> {
    const suffix = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    const { data: content } = await requestJson(this.#safeFetcher, this.repoUrl(repository, `/contents/${contentPath(path)}${suffix}`), { headers: this.#headers });
    const encoded = record(content, "workflow content");
    if (encoded.encoding !== "base64" || typeof encoded.content !== "string") throw new ProviderFailure("workflow routing cannot be proven");
    const doc = parseDocument(Buffer.from(encoded.content.replace(/\s/g, ""), "base64").toString("utf8"));
    if (doc.errors.length) throw new ProviderFailure("workflow routing cannot be parsed");
    assertSafeWorkflow(doc.toJS());
  }
  async validateWorkflowRouting(_required: string[]): Promise<void> {
    for (const repository of this.organization?.repositories ?? [this.repository]) {
      const workflows = await collectLinkPages<unknown>(this.#safeFetcher, this.repoUrl(repository, "/actions/workflows?per_page=100"), (value) => {
        const listed = record(value, "workflows").workflows;
        if (!Array.isArray(listed)) throw new ProviderFailure("malformed GitHub workflows");
        return listed;
      }, { headers: this.#headers });
      for (const workflow of workflows) await this.validateWorkflowContent(repository, workflowPath(record(workflow, "workflow").path));
      const revisions = new Map<string, { path: string; sha: string }>();
      for (const run of (await this.activeRuns(repository, true)).values()) {
        const head = record(run.head_repository, "workflow run head repository")["full_name"];
        const sha = run.head_sha;
        if (typeof head !== "string" || head.toLowerCase() !== repository.toLowerCase() || typeof sha !== "string" || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(sha)) throw new ProviderFailure("workflow routing cannot be proven for active run provenance");
        const path = workflowRevisionPath(run.path);
        revisions.set(`${path}\u0000${sha}`, { path, sha });
      }
      for (const { path, sha } of revisions.values()) await this.validateWorkflowContent(repository, path, sha);
    }
  }
}
