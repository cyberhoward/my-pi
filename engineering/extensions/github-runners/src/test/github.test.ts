import { expect, it, vi } from "vitest";
import { GitHubClient } from "../github.js";
import { Redactor } from "../redaction.js";
import { Secret } from "../types.js";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
const required = ["small"];
const encodedWorkflow = (runsOn: unknown) => ({ encoding: "base64", content: Buffer.from(`jobs:\n  test:\n    runs-on: ${JSON.stringify(runsOn)}\n    steps: []\n`).toString("base64") });
const routingClient = (defaultRunsOn: unknown, active?: { sha: string; runsOn: unknown; status?: string }) => new GitHubClient(
  vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url.endsWith("/actions/workflows?per_page=100")) return json({ workflows: [{ id: 1, path: ".github/workflows/test.yml" }] });
    if (url.includes("/actions/runs?")) return json({ total_count: url.includes(`status=${active?.status ?? "queued"}`) && active ? 1 : 0, workflow_runs: url.includes(`status=${active?.status ?? "queued"}`) && active ? [{ id: 1, head_repository: { full_name: "acme/repo" }, head_sha: active.sha, path: ".github/workflows/test.yml@refs/heads/feature" }] : [] });
    if (url.includes("/contents/.github/workflows/test.yml?ref=")) return json(encodedWorkflow(active?.runsOn));
    if (url.includes("/contents/.github/workflows/test.yml")) return json(encodedWorkflow(defaultRunsOn));
    throw new Error(url);
  }),
  "acme/repo",
  new Secret("token"),
);
it("observes every nonterminal status twice with case-insensitive repository identity", async () => {
  const statuses = ["queued", "in_progress", "requested", "waiting", "pending"];
  const fetcher = vi.fn(async (input: string | URL) => {
    const url = String(input);
    const status = statuses.find((value) => url.includes(`status=${value}`));
    if (status)
      return json({
        workflow_runs: [
          {
            id: statuses.indexOf(status) + 1,
            status,
            run_attempt: 1,
            head_repository: { full_name: "cyberhoward/graditas" },
          },
        ],
      });
    const id = url.match(/runs\/(\d+)\/attempts/)?.[1];
    if (id)
      return json({
        jobs: [
          {
            id: `j${id}`,
            status: statuses[Number(id) - 1],
            labels: required,
            created_at: "2026-01-01T00:00:00Z",
          },
        ],
      });
    throw new Error(url);
  });
  const result = await new GitHubClient(
    fetcher,
    "CyberHoward/graditas",
    new Secret("token"),
  ).listActiveMatchingJobs(required);
  expect(result.provenanceComplete).toBe(true);
  expect(result.jobs).toHaveLength(5);
});
it("excludes forks and fails closed on missing provenance", async () => {
  let request = 0;
  const fetcher = vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url.includes("/actions/runs?")) {
      request++;
      if (url.includes("status=queued"))
        return json({
          workflow_runs: [
            {
              id: request,
              status: "queued",
              run_attempt: 1,
              head_repository:
                request < 6 ? { full_name: "fork/repo" } : undefined,
            },
          ],
        });
      return json({ workflow_runs: [] });
    }
    return json({ jobs: [] });
  });
  const result = await new GitHubClient(
    fetcher,
    "CyberHoward/graditas",
    new Secret("token"),
  ).listActiveMatchingJobs(required);
  expect(result.jobs).toEqual([]);
  expect(result.provenanceComplete).toBe(false);
});
it("uses organization runner endpoints and rejects runner group access outside the allowlist", async () => {
  const fetcher = vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url.endsWith("/actions/runners?per_page=100")) return json({ runners: [] });
    if (url.endsWith("/actions/runner-groups/7")) return json({ name: "selected", visibility: "selected" });
    if (url.endsWith("/actions/runner-groups/7/repositories?per_page=100")) return json({ repositories: [{ full_name: "acme/one" }] });
    throw new Error(url);
  });
  const client = new GitHubClient(fetcher, "acme/one", new Secret("token"), new Redactor(), { name: "acme", repositories: ["acme/one", "acme/two"], runnerGroupId: 7, runnerGroupName: "selected" });
  await client.listManagedRunners();
  expect(fetcher).toHaveBeenCalledWith("https://api.github.com/orgs/acme/actions/runners?per_page=100", expect.anything());
  await expect(client.validateOrganizationScope()).rejects.toThrow("exactly match");
});
it("fails closed when active-run snapshots change between scans", async () => {
  let queuedScan = 0;
  const fetcher = vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url.includes("status=queued")) {
      queuedScan++;
      return json({
        workflow_runs: [
          {
            id: queuedScan,
            status: "queued",
            run_attempt: 1,
            head_repository: { full_name: "CyberHoward/graditas" },
          },
        ],
      });
    }
    if (url.includes("/actions/runs?")) return json({ workflow_runs: [] });
    if (url.includes("/jobs?")) return json({ jobs: [] });
    throw new Error(url);
  });
  const result = await new GitHubClient(
    fetcher,
    "CyberHoward/graditas",
    new Secret("token"),
  ).listActiveMatchingJobs(required);
  expect(result.provenanceComplete).toBe(false);
});
it.each([
  ["default Linux labels", ["linux", "x64"]],
  ["self-hosted labels", ["self-hosted", "linux", "x64"]],
  ["expressions", "${{ matrix.runner }}"],
])("refuses %s that can match a draining runner", async (_name, runsOn) => {
  await expect(routingClient(runsOn).validateWorkflowRouting(required)).rejects.toThrow();
});
it("refuses unsupported runs-on constructs", async () => {
  await expect(routingClient({ group: "trusted", labels: ["small"] }).validateWorkflowRouting(required)).rejects.toThrow("cannot be proven");
});
it("refuses active fork provenance", async () => {
  const fetcher = vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url.endsWith("/actions/workflows?per_page=100")) return json({ workflows: [] });
    if (url.includes("/actions/runs?")) return json({ total_count: url.includes("status=queued") ? 1 : 0, workflow_runs: url.includes("status=queued") ? [{ id: 1, head_repository: { full_name: "fork/repo" }, head_sha: "a".repeat(40), path: ".github/workflows/test.yml@refs/heads/feature" }] : [] });
    throw new Error(url);
  });
  await expect(new GitHubClient(fetcher, "acme/repo", new Secret("token")).validateWorkflowRouting(required)).rejects.toThrow("provenance");
});
it("accepts explicit custom labels for another pool and GitHub-hosted labels", async () => {
  await expect(routingClient(["self-hosted", "large"]).validateWorkflowRouting(required)).resolves.toBeUndefined();
  await expect(routingClient("ubuntu-latest").validateWorkflowRouting(required)).resolves.toBeUndefined();
});
it.each(["queued", "in_progress", "requested", "waiting", "pending"])("refuses an unsafe active %s revision", async (status) => {
  await expect(routingClient(["self-hosted", "small"], { sha: "a".repeat(40), runsOn: ["linux", "x64"], status }).validateWorkflowRouting(required)).rejects.toThrow("could match");
});
it("fails closed when active-run pagination cannot be completed", async () => {
  const fetcher = vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url.endsWith("/actions/workflows?per_page=100")) return json({ workflows: [] });
    if (url.includes("status=queued") && !url.includes("page=2")) return new Response(JSON.stringify({ total_count: 0, workflow_runs: [] }), { headers: { "content-type": "application/json", link: `<https://api.github.com/repos/acme/repo/actions/runs?status=queued&per_page=100&page=2>; rel=\"next\"` } });
    if (url.includes("page=2")) return new Response("unavailable", { status: 503 });
    if (url.includes("/actions/runs?")) return json({ workflow_runs: [] });
    throw new Error(url);
  });
  await expect(new GitHubClient(fetcher, "acme/repo", new Secret("token")).validateWorkflowRouting(required)).rejects.toThrow("provider request failed");
});
