import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { packReaper } from "../remote-reaper.js";

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("reaper deployment package", () => {
  it("archives only the manifest, lockfile, configuration, and compiled output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-reaper-archive-test-"));
    const archive = join(directory, "reaper.tgz");
    try {
      await writeFile(archive, await packReaper(Buffer.from('{"repository":"acme/repo"}\n'), root));
      const { stdout } = await execute("tar", ["-tzf", archive]);
      const entries = stdout.trim().split("\n").map((entry) => entry.replace(/^\.\//, "")).filter(Boolean);
      expect(entries).toEqual(expect.arrayContaining(["package.json", "package-lock.json", "config.json", "dist/index.js", "dist/reaper-cli.js", "dist/src/cli.js"]));
      expect(entries.every((entry) => entry === "package.json" || entry === "package-lock.json" || entry === "config.json" || entry === "dist" || entry.startsWith("dist/"))).toBe(true);
      expect(entries.some((entry) => /(^|\/)(node_modules|tests|docs)(\/|$)/.test(entry))).toBe(false);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
