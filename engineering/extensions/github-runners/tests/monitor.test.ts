import { describe, expect, it, vi } from "vitest";
import { footerText, listGitHubRunners, RunnerMonitor } from "../monitor.js";

const runner = (pages: unknown[]) => vi.fn(async (_file: string, args: string[]) => ({ stdout: JSON.stringify(pages[Number(args.at(-1)?.split("=").at(-1)) - 1]) }));

describe("GitHub runner monitoring", () => {
  it("paginates all runners and counts online separately", async () => {
    const run = runner([{ total_count: 3, runners: [{ busy: true, status: "online" }, { busy: false, status: "offline" }] }, { total_count: 3, runners: [{ busy: false, status: "online" }] }]);
    const inventory = await listGitHubRunners("owner/repo", run);
    expect(inventory).toEqual({ total: 3, runners: [{ busy: true, status: "online" }, { busy: false, status: "offline" }, { busy: false, status: "online" }] });
    expect(run).toHaveBeenCalledTimes(2);
  });
  it("uses unknown footer on gh failures", async () => {
    await expect(listGitHubRunners("owner/repo", vi.fn(async () => { throw new Error("authentication failed"); }))).rejects.toThrow("authentication failed");
    expect(footerText({ kind: "unknown", error: "authentication failed" })).toBe("?/? runners");
  });
  it("fences old responses after stop", async () => {
    let resolve!: (value: { kind: "ok"; busy: number; online: number; total: number }) => void;
    const read = vi.fn(() => new Promise<typeof resolve extends (value: infer T) => void ? T : never>((done) => { resolve = done; }));
    const update = vi.fn();
    const monitor = new RunnerMonitor("owner/repo", 60_000, update, read as never);
    monitor.start();
    monitor.stop();
    resolve({ kind: "ok", busy: 1, online: 1, total: 1 });
    await Promise.resolve();
    expect(update).not.toHaveBeenCalled();
  });
});
