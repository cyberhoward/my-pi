import { describe, expect, it } from "vitest";
import { poolActivity, repositoryActivity } from "../activity.js";

function response(runs: unknown[], ok = true): Response { return { ok, status: ok ? 200 : 500, json: async () => ({ workflow_runs: runs }) } as Response; }

describe("runner activity", () => {
  it("refuses cleanup when an active queued run exists", async () => {
    const value = await repositoryActivity("owner/repo", "token", { fetcher: async (url) => response(String(url).includes("status=queued") ? [{ status: "queued", updated_at: "2025-01-01T00:00:00Z" }] : []) as Response });
    expect(value.kind).toBe("active");
  });
  it("uses completion updated_at rather than creation time", async () => {
    const value = await repositoryActivity("owner/repo", "token", { fetcher: async (url) => response(String(url).includes("status=completed") ? [{ status: "completed", updated_at: "2025-01-02T00:00:00Z" }] : []) as Response });
    expect(value).toMatchObject({ kind: "idle", lastActivity: new Date("2025-01-02T00:00:00Z") });
  });
  it("treats requested work as active", async () => {
    const value = await repositoryActivity("owner/repo", "token", { fetcher: async (url) => response(String(url).includes("status=requested") ? [{ status: "requested", updated_at: "2025-01-02T00:00:00Z" }] : []) as Response });
    expect(value.kind).toBe("active");
  });
  it("excludes more than 2000 old completed runs with a bounded history window", async () => {
    const urls: string[] = [];
    const value = await repositoryActivity("owner/repo", "token", { now: () => new Date("2025-02-10T00:00:00Z"), fetcher: async (url) => { urls.push(String(url)); return response([]) as Response; } });
    expect(value.kind).toBe("idle");
    expect(urls.filter((url) => url.includes("status=completed"))).toEqual([expect.stringContaining("created=%3E%3D2025-01-05T00%3A00%3A00.000Z")]);
  });
  it("fails closed on malformed run records", async () => {
    await expect(repositoryActivity("owner/repo", "token", { fetcher: async (url) => response(String(url).includes("status=completed") ? [{ status: "completed", updated_at: "not-a-date" }] : []) as Response })).resolves.toMatchObject({ kind: "unknown" });
    await expect(repositoryActivity("owner/repo", "token", { fetcher: async (url) => response(String(url).includes("status=completed") ? [{ status: "queued", updated_at: "2025-01-01T00:00:00Z" }] : []) as Response })).resolves.toMatchObject({ kind: "unknown" });
  });
  it("fails closed on API errors and incomplete pagination", async () => {
    await expect(repositoryActivity("owner/repo", "token", { fetcher: async () => response([], false) as Response })).resolves.toMatchObject({ kind: "unknown" });
    await expect(repositoryActivity("owner/repo", "token", { maxPages: 1, fetcher: async (url) => response(String(url).includes("status=completed") ? Array.from({ length: 100 }, () => ({ status: "completed", updated_at: "2025-01-01T00:00:00Z" })) : []) as Response })).resolves.toMatchObject({ kind: "unknown" });
  });
  it("aggregates global activity across every allowlisted repository", async () => {
    const value = await poolActivity(["org/one", "org/two"], "token", { fetcher: async (url) => response(String(url).includes("org/two") && String(url).includes("status=in_progress") ? [{ status: "in_progress", updated_at: "2025-01-01T00:00:00Z" }] : []) as Response });
    expect(value.kind).toBe("active");
  });
});
