import { spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installReaper, installScript, reaperInstallationId, reaperStatus, requestReaper, uninstallReaper, type ReaperTransport } from "../remote-reaper.js";
import { parseReaperConfig } from "../reaper-runtime.js";
import type { RepositoryBinding } from "../repository.js";
import type { RunnerSettings } from "../settings.js";

const binding: RepositoryBinding = { root: "/workspace/repo", repository: "acme/repo" };
const settings: RunnerSettings = { mode: "local", policies: [], pollIntervalSeconds: 60, standbyMinutes: 15, startOnLoad: false, automationEnabled: false, sizes: [{ name: "small", labels: ["ci-small"], quantity: 1, serverType: "cpx11", location: "fsn1", image: "ubuntu-24.04", firewallId: "1", runnerVersion: "2.321.0", runnerArchiveSha256: "a".repeat(64), maxHourlyCostEur: 1, maxEligibilityCostEur: 1 }], sourcePath: "/workspace/repo/.pi/github-runners.json" };

function transport(results: Array<{ code?: number; stdout?: string; stderr?: string }> = []): { calls: Parameters<ReaperTransport>[0][]; run: ReaperTransport } {
  const calls: Parameters<ReaperTransport>[0][] = [];
  return { calls, run: async (input) => { calls.push(input); const result = results.shift() ?? {}; return { code: result.code ?? 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" }; } };
}
async function shell(script: string, input: Buffer, env: NodeJS.ProcessEnv): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("sh", ["-c", script, "--", "0123456789abcdef", env.env ?? "/tmp/private.env"], { env, stdio: ["pipe", "pipe", "pipe"] }); let stderr = "";
    child.stderr.on("data", (value: Buffer) => { stderr += value; }); child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(stderr || `script failed: ${code}`)));
    child.stdin.end(input);
  });
}
async function archive(directory: string): Promise<Buffer> {
  await mkdir(join(directory, "dist"), { recursive: true });
  await Promise.all([writeFile(join(directory, "package.json"), "{}"), writeFile(join(directory, "package-lock.json"), "{}"), writeFile(join(directory, "config.json"), "{}"), writeFile(join(directory, "dist/reaper-cli.js"), "")]);
  return await new Promise<Buffer>((resolve, reject) => { const child = spawn("tar", ["-czf", "-", "-C", directory, "."], { stdio: ["ignore", "pipe", "inherit"] }); const chunks: Buffer[] = []; child.stdout.on("data", (value: Buffer) => chunks.push(value)); child.once("error", reject); child.once("close", (code) => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error("tar failed"))); });
}
async function fakeCommands(root: string): Promise<string> {
  const bin = join(root, "bin"); await mkdir(bin); const script = async (name: string, body: string) => { const path = join(bin, name); await writeFile(path, `#!/bin/sh\n${body}\n`); await chmod(path, 0o755); };
  await script("npm", "exit 0"); await script("node", "exit 0"); await script("flock", "exit 0");
  await script("mv", "if test \"${FAIL_BASE_BACKUP_MV_ONCE:-}\" = 1 && ! test -e \"$HOME/failed-base-mv\"; then case \"$1\" in \"$HOME\"/.local/share/pi-github-runners/.*) ;; \"$HOME\"/.local/share/pi-github-runners/*) : > \"$HOME/failed-base-mv\"; exit 1;; esac; fi; if test \"${FAIL_UNIT_BACKUP_MV_ONCE:-}\" = 1 && ! test -e \"$HOME/failed-unit-mv\"; then case \"$1\" in \"$HOME\"/.config/systemd/user/pi-github-runners-*.service) : > \"$HOME/failed-unit-mv\"; exit 1;; esac; fi; exec /bin/mv \"$@\"");
  await script("systemctl", "log=$HOME/systemctl.log; echo \"$*\" >> \"$log\"; for arg in \"$@\"; do case \"$arg\" in is-active|stop|start|enable|disable|daemon-reload) cmd=$arg; break;; esac; done; case \"$cmd\" in is-active) test -f \"$HOME/active\";; stop) rm -f \"$HOME/active\";; start) if test \"${FAIL_START_ONCE:-}\" = 1 && ! test -e \"$HOME/failed-start\"; then : > \"$HOME/failed-start\"; exit 1; fi; : > \"$HOME/active\";; enable) : > \"$HOME/enabled\";; disable) rm -f \"$HOME/enabled\";; esac");
  return bin;
}

describe("remote reaper installer", () => {
  it("transports bulk destroy as structured data and rejects conflicting selectors", async () => {
    const fake = transport();
    const installation = { sshTarget: "controller", installationId: "a".repeat(16), environmentFile: "/private.env" };
    await requestReaper(installation, { operation: "destroy", all: true }, { transport: fake.run });
    expect(JSON.parse(fake.calls[0].stdin!.toString())).toEqual({ operation: "destroy", all: true });
    await expect(requestReaper(installation, { operation: "destroy", all: true, instance: "11111111-1111-4111-8111-111111111111" }, { transport: fake.run })).rejects.toThrow("mutually exclusive");
    expect(fake.calls).toHaveLength(1);
  });
  it("uses a deterministic safe scope identifier", () => {
    expect(reaperInstallationId(binding, settings)).toMatch(/^[a-f0-9]{16}$/);
    expect(reaperInstallationId(binding, settings)).toBe(reaperInstallationId(binding, settings));
  });

  it("preflights before sending an allowlisted archive and never embeds credentials", async () => {
    const fake = transport();
    const installation = await installReaper(binding, settings, { sshTarget: "runner@controller", environmentFile: "/etc/pi-runners.env" }, { transport: fake.run, pack: async (config) => {
      expect(config.toString()).toContain('"repository":"acme/repo"');
      expect(config.toString()).not.toContain("HCLOUD_TOKEN=");
      return Buffer.from("archive");
    } });
    expect(installation.environmentFile).toBe("/etc/pi-runners.env");
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0].stdin).toBeUndefined();
    expect(fake.calls[0].command).toContain("RUNNER_MANAGER_GITHUB_TOKEN");
    expect(fake.calls[1].stdin?.toString()).toBe("archive");
    expect(fake.calls[1].command).toContain("npm ci --omit=dev --ignore-scripts --legacy-peer-deps");
    expect(fake.calls[1].command).toContain("flock -x 9");
    expect(fake.calls[1].command).toContain("systemctl --user stop");
    expect(fake.calls[1].command).toContain("systemctl --user start");
    expect(fake.calls[1].command).toContain("serve --config");
    expect(fake.calls[1].command).not.toContain("EnvironmentFile=");
  });

  it("round-trips mixed active and disabled size drafts through the remote payload", async () => {
    const fake = transport();
    const disabled = { ...settings.sizes[0], name: "", labels: [], quantity: 0, serverType: "", location: "", image: "", firewallId: "", runnerVersion: "", runnerArchiveSha256: "", maxHourlyCostEur: 0, maxEligibilityCostEur: 0 };
    let payload: Buffer | undefined;
    await installReaper(binding, { ...settings, sizes: [settings.sizes[0], disabled] }, { sshTarget: "runner@controller", environmentFile: "/etc/pi-runners.env" }, { transport: fake.run, pack: async (config) => { payload = config; return Buffer.from("archive"); } });
    const parsed = parseReaperConfig(JSON.parse(payload!.toString("utf8")), "/installed/config.json");
    expect(parsed.settings.sizes).toEqual([settings.sizes[0], disabled]);
  });

  it("routes requests as bounded JSON stdin to the fixed CLI", async () => {
    const fake = transport([{ code: 0, stdout: "ok" }]);
    const installation = { sshTarget: "host", installationId: "0123456789abcdef", environmentFile: "/opt/private.env" };
    await expect(requestReaper(installation, { operation: "ensure", capacity: 1, apply: false }, { transport: fake.run })).resolves.toEqual({ code: 0, text: "ok" });
    expect(fake.calls[0].stdin?.toString()).toBe('{"operation":"ensure","capacity":1,"apply":false}');
    expect(fake.calls[0].command).toContain("dist/reaper-cli.js");
    expect(fake.calls[0].command).not.toContain("StrictHostKeyChecking=no");
  });

  it("refuses unsafe installation inputs without transport", async () => {
    const fake = transport();
    await expect(uninstallReaper({ sshTarget: "bad host", installationId: "0123456789abcdef", environmentFile: "/tmp/env" }, { transport: fake.run })).rejects.toThrow("ssh target");
    await expect(requestReaper({ sshTarget: "host", installationId: "0123456789abcdef", environmentFile: "/tmp/env" }, { operation: "ensure", capacity: -1 }, { transport: fake.run })).rejects.toThrow("invalid reaper request");
    expect(fake.calls).toHaveLength(0);
  });

  it("only uninstalls after ownership checks and reports service status", async () => {
    const fake = transport([{ stdout: "active\n" }, {}]);
    const installation = { sshTarget: "host", installationId: "0123456789abcdef", environmentFile: "/tmp/env" };
    await expect(reaperStatus(installation, { transport: fake.run })).resolves.toBe("active");
    await uninstallReaper(installation, { transport: fake.run });
    expect(fake.calls[1].command).toContain(".pi-reaper-owner");
    expect(fake.calls[1].command).toContain("flock -x 9");
  });

  it("executes the generated installer transactionally and preserves prewarm state", async () => {
    const root = await mkdtemp(join(tmpdir(), "reaper-install-"));
    try {
      const payload = await archive(join(root, "archive")); const bin = await fakeCommands(root); const id = "0123456789abcdef";
      const env = { ...process.env, HOME: root, PATH: `${bin}:${process.env.PATH}`, id, env: join(root, "private.env") };
      await shell(installScript, payload, env);
      const base = join(root, ".local/share/pi-github-runners", id);
      await writeFile(join(base, ".prewarm.json"), '{"at":1}\n', { mode: 0o600 });
      await shell(installScript, payload, env);
      expect(await readFile(join(base, ".prewarm.json"), "utf8")).toBe('{"at":1}\n');
      expect(await readFile(join(root, "systemctl.log"), "utf8")).toContain("start pi-github-runners-0123456789abcdef.service");
      await expect(shell(installScript, payload, { ...env, FAIL_START_ONCE: "1" })).rejects.toThrow();
      expect(await readFile(join(base, ".prewarm.json"), "utf8")).toBe('{"at":1}\n');
      await expect(access(join(root, "active"))).resolves.toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("preserves the original installation when either backup rename fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "reaper-rollback-"));
    try {
      const payload = await archive(join(root, "archive")); const bin = await fakeCommands(root); const id = "0123456789abcdef";
      const env = { ...process.env, HOME: root, PATH: `${bin}:${process.env.PATH}`, id, env: join(root, "private.env") };
      const base = join(root, ".local/share/pi-github-runners", id); const unit = join(root, ".config/systemd/user", `pi-github-runners-${id}.service`); const parent = join(root, ".local/share/pi-github-runners");
      await shell(installScript, payload, env);
      await writeFile(join(base, "original"), "base\n");
      const originalUnit = await readFile(unit, "utf8");
      await expect(shell(installScript, payload, { ...env, FAIL_BASE_BACKUP_MV_ONCE: "1" })).rejects.toThrow();
      expect(await readFile(join(base, "original"), "utf8")).toBe("base\n");
      expect(await readFile(unit, "utf8")).toBe(originalUnit);
      await expect(access(join(root, "active"))).resolves.toBeUndefined();
      await expect(shell(installScript, payload, { ...env, FAIL_UNIT_BACKUP_MV_ONCE: "1" })).rejects.toThrow();
      expect(await readFile(join(base, "original"), "utf8")).toBe("base\n");
      expect(await readFile(unit, "utf8")).toBe(originalUnit);
      await expect(access(join(root, "active"))).resolves.toBeUndefined();
      expect(await readFile(join(root, "systemctl.log"), "utf8")).not.toContain("disable pi-github-runners-0123456789abcdef.service");
      expect((await readdir(parent)).filter((name) => name.includes(".backup.") || name.includes(".stage."))).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("cleans a failed new installation without disabling an existing service", async () => {
    const root = await mkdtemp(join(tmpdir(), "reaper-new-rollback-"));
    try {
      const payload = await archive(join(root, "archive")); const bin = await fakeCommands(root); const id = "0123456789abcdef";
      const env = { ...process.env, HOME: root, PATH: `${bin}:${process.env.PATH}`, id, env: join(root, "private.env"), FAIL_START_ONCE: "1" };
      const base = join(root, ".local/share/pi-github-runners", id); const unit = join(root, ".config/systemd/user", `pi-github-runners-${id}.service`); const parent = join(root, ".local/share/pi-github-runners");
      await expect(shell(installScript, payload, env)).rejects.toThrow();
      await expect(access(base)).rejects.toThrow();
      await expect(access(unit)).rejects.toThrow();
      await expect(access(join(root, "active"))).rejects.toThrow();
      await expect(access(join(root, "enabled"))).rejects.toThrow();
      expect((await readdir(parent)).filter((name) => name.includes(".backup.") || name.includes(".stage.") || name === id)).toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
