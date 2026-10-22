import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { discoverSshHosts, selectSshTarget } from "../ssh-hosts.js";

describe("SSH host discovery", () => {
  it("reads literal aliases from config and included files without resolving them", async () => {
    const home = await mkdtemp(join(tmpdir(), "ssh-hosts-"));
    const ssh = join(home, ".ssh");
    await mkdir(join(ssh, "conf.d"), { recursive: true });
    await writeFile(join(ssh, "config"), "# aliases only\nInclude = conf.d/*.conf missing.conf # ignored\nHost root-alias shared_alias *.example !excluded invalid/target\nHost = second-alias SHARED_ALIAS # ignored\n");
    await writeFile(join(ssh, "conf.d", "a.conf"), "Host included-a\nInclude conf.d/nested.conf\n");
    await writeFile(join(ssh, "conf.d", "b.conf"), "Host included-b\n");
    await writeFile(join(ssh, "conf.d", "nested.conf"), "Host nested-alias\nInclude config\n");

    await expect(discoverSshHosts({ home })).resolves.toEqual(["included-a", "nested-alias", "included-b", "root-alias", "shared_alias", "second-alias"]);
  });

  it("expands quoted home-relative includes and ignores inline comments", async () => {
    const home = await mkdtemp(join(tmpdir(), "ssh-hosts-"));
    const ssh = join(home, ".ssh");
    await mkdir(join(home, "included files"), { recursive: true });
    await mkdir(ssh, { recursive: true });
    await writeFile(join(ssh, "config"), "Include = \"~/included files/*.conf\" # another include is not a value\n");
    await writeFile(join(home, "included files", "quoted.conf"), "Host quoted-include # ignored\n");

    await expect(discoverSshHosts({ home })).resolves.toEqual(["quoted-include"]);
  });

  it("returns no hosts when the SSH config is missing", async () => {
    const home = await mkdtemp(join(tmpdir(), "ssh-hosts-"));
    await expect(discoverSshHosts({ home })).resolves.toEqual([]);
  });

  it("skips non-regular includes while following symlinks to regular config files", async () => {
    const home = await mkdtemp(join(tmpdir(), "ssh-hosts-"));
    const ssh = join(home, ".ssh");
    await mkdir(join(ssh, "directory"), { recursive: true });
    const fifo = join(ssh, "fifo");
    execFileSync("mkfifo", [fifo]);
    await writeFile(join(ssh, "real.conf"), "Host through-symlink\n");
    await symlink(join(ssh, "real.conf"), join(ssh, "linked.conf"));
    await writeFile(join(ssh, "config"), "Include directory fifo linked.conf\n");

    await expect(discoverSshHosts({ home })).resolves.toEqual(["through-symlink"]);
  });

  it("does not execute Match commands while handling an Include cycle", async () => {
    const home = await mkdtemp(join(tmpdir(), "ssh-hosts-"));
    const ssh = join(home, ".ssh");
    const marker = join(home, "match-executed");
    await mkdir(ssh, { recursive: true });
    await writeFile(join(ssh, "config"), "Host root-alias\nInclude loop.conf\n");
    await writeFile(join(ssh, "loop.conf"), `Match exec \"touch ${marker}\"\nInclude config\n`);

    await expect(discoverSshHosts({ home })).resolves.toEqual(["root-alias"]);
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the exact selected alias and does not ask manually after cancellation", async () => {
    const calls: string[] = [];
    const ui = {
      select: async (_title: string, options: string[]) => { calls.push(`select:${options.join(",")}`); return "Alias_One"; },
      input: async () => { calls.push("input"); return "manual"; },
      notify: (message: string) => calls.push(`notify:${message}`),
    };
    await expect(selectSshTarget(ui, async () => ["Alias_One"])).resolves.toBe("Alias_One");
    expect(calls).toEqual(["select:Alias_One,Enter manually…"]);

    const cancelled = { ...ui, select: async () => undefined };
    await expect(selectSshTarget(cancelled, async () => ["Alias_One"])).resolves.toBeUndefined();
    expect(calls).not.toContain("input");
  });

  it("falls back to cancellable manual input when discovery fails or manual entry is selected", async () => {
    const messages: string[] = [];
    const failedUi = {
      select: async () => { throw new Error("unexpected selector"); },
      input: async () => undefined,
      notify: (message: string) => messages.push(message),
    };
    await expect(selectSshTarget(failedUi, async () => { throw new Error("unreadable config"); })).resolves.toBeUndefined();
    expect(messages.join(" ")).toContain("Unable to read SSH configuration");

    const manualUi = { ...failedUi, select: async () => "Enter manually…", notify: () => undefined };
    await expect(selectSshTarget(manualUi, async () => ["Alias_One"])).resolves.toBeUndefined();
  });

  it("falls back to manual input when no config aliases are available", async () => {
    const messages: string[] = [];
    const ui = { select: async () => { throw new Error("unexpected selector"); }, input: async () => "user@manual-host", notify: (message: string) => messages.push(message) };
    await expect(selectSshTarget(ui, async () => [])).resolves.toBe("user@manual-host");
    expect(messages.join(" ")).toContain("No literal SSH aliases");
  });
});
