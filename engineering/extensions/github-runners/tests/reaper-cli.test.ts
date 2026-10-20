import { describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  executeReaper: vi.fn(async () => ({ code: 0, text: "ok" })),
  parsePrivateEnvironment: vi.fn(async () => ({ HCLOUD_TOKEN: "file-token" })),
  parseReaperRequest: vi.fn(() => ({ operation: "status" })),
  readBoundedJson: vi.fn(async () => ({ operation: "status" })),
  serveReaper: vi.fn(async () => async () => undefined),
}));

vi.mock("../reaper-runtime.js", () => runtime);

import { runReaperCli } from "../reaper-cli.js";

const io = () => ({ stdin: (async function* () { yield Buffer.from("{}"); })(), stdout: vi.fn(), stderr: vi.fn() });

describe("reaper cli", () => {
  it("accepts and loads an environment file for serve", async () => {
    const output = io();
    await expect(runReaperCli(["serve", "--config", "/config.json", "--env-file", "/private.env"], output, { BASE: "base" })).resolves.toBe(0);
    expect(runtime.parsePrivateEnvironment).toHaveBeenCalledWith("/private.env");
    expect(runtime.serveReaper).toHaveBeenCalledWith("/config.json", expect.objectContaining({ env: { BASE: "base", HCLOUD_TOKEN: "file-token" }, status: expect.any(Function) }));
  });
  it("loads an environment file for requests", async () => {
    const output = io();
    await expect(runReaperCli(["request", "--config", "/config.json", "--env-file", "/private.env"], output, { BASE: "base" })).resolves.toBe(0);
    expect(runtime.parsePrivateEnvironment).toHaveBeenCalledWith("/private.env");
    expect(runtime.executeReaper).toHaveBeenCalledWith("/config.json", { operation: "status" }, { BASE: "base", HCLOUD_TOKEN: "file-token" });
  });
});
