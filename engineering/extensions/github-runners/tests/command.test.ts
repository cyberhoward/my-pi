import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertPolicyRepository, parseRunnerCommand, snapshotPolicy } from "../index.js";

describe("runner command safeguards", () => {
  it("keeps mutations dry-run unless --apply is explicit", () => {
    expect(parseRunnerCommand("ensure --capacity 2")).toMatchObject({ operation: "ensure", capacity: "2", apply: false });
    expect(parseRunnerCommand("ensure --capacity 2 --apply")).toMatchObject({ apply: true });
    expect(() => parseRunnerCommand("status --apply")).toThrow("--apply");
  });
  it("refuses cross-repository policies", () => {
    expect(() => assertPolicyRepository("Owner/repo", "owner/other")).toThrow("does not match");
    expect(() => assertPolicyRepository("Owner/repo", "owner/REPO")).not.toThrow();
  });
  it("pins policy bytes for the full plan and apply flow", async () => {
    const directory = await mkdtemp(join(tmpdir(), "runner-policy-"));
    const policy = join(directory, "policy.yaml");
    await writeFile(policy, "repository: owner/repo\n");
    const pinned = await snapshotPolicy(policy);
    await writeFile(policy, "repository: owner/other\n");
    await expect(readFile(pinned.path, "utf8")).resolves.toBe("repository: owner/repo\n");
    await pinned.cleanup();
  });
});
