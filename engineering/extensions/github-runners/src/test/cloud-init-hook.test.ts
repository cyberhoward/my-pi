import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { renderCloudInit } from "../cloud-init.js";
import { Secret } from "../types.js";

function hookPath(): string {
  const cloud = renderCloudInit({
    repository: "CyberHoward/graditas",
    runnerName: "runner-1",
    customLabels: ["safe"],
    registrationToken: new Secret("token"),
    runnerVersion: "2.999.0",
    archiveSha256: "a".repeat(64),
  }).reveal();
  const encoded = cloud.match(/content: (\S+)/)?.[1] ?? "";
  const dir = mkdtempSync(join(tmpdir(), "runner-hook-"));
  const path = join(dir, "hook");
  writeFileSync(path, Buffer.from(encoded, "base64"));
  chmodSync(path, 0o700);
  return path;
}
function run(event: string, payload?: string): number | null {
  const hook = hookPath();
  const path = `${hook}.json`;
  const sudo = join(hook, "..", "sudo");
  writeFileSync(sudo, "#!/bin/sh\nexit 0\n");
  chmodSync(sudo, 0o700);
  if (payload !== undefined) writeFileSync(path, payload);
  return spawnSync(hook, [], {
    env: {
      ...process.env,
      GITHUB_EVENT_NAME: event,
      GITHUB_REPOSITORY: "CyberHoward/graditas",
      GITHUB_EVENT_PATH: path,
      PATH: `${join(hook, "..")}:/usr/bin:/bin`,
    },
  }).status;
}
it("allows non-PR and same-repository PR events", () => {
  expect(run("push")).toBe(0);
  expect(
    run(
      "pull_request",
      JSON.stringify({
        pull_request: {
          head: { repo: { full_name: "cyberhoward/graditas" } },
        },
      }),
    ),
  ).toBe(0);
});
it("fails closed for forks and malformed or incomplete PR provenance", () => {
  expect(
    run(
      "pull_request",
      JSON.stringify({
        pull_request: { head: { repo: { full_name: "fork/repo" } } },
      }),
    ),
  ).not.toBe(0);
  expect(run("pull_request", JSON.stringify({ pull_request: {} }))).not.toBe(0);
  expect(run("pull_request", "not-json")).not.toBe(0);
  expect(run("pull_request")).not.toBe(0);
});
it("wires the pre-job hook to a GitHub-supported script extension", () => {
  const cloud = renderCloudInit({
    repository: "CyberHoward/graditas",
    runnerName: "runner-1",
    customLabels: ["safe"],
    registrationToken: new Secret("token"),
    runnerVersion: "2.999.0",
    archiveSha256: "a".repeat(64),
  }).reveal();
  expect(cloud).toContain("/usr/local/libexec/tau-runner-pre-job.sh");
  expect(cloud).not.toContain("/usr/local/libexec/tau-runner-pre-job\\n");
  expect(cloud).toContain("packages: [curl, jq, docker.io, nodejs, sudo]");
});

it("cleans the complete work root before an accepted job", () => {
  const cloud = renderCloudInit({
    repository: "CyberHoward/graditas",
    runnerName: "runner-1",
    customLabels: ["safe"],
    registrationToken: new Secret("token"),
    runnerVersion: "2.999.0",
    archiveSha256: "a".repeat(64),
  }).reveal();
  const encoded = cloud.match(/content: (\S+)/)?.[1] ?? "";
  const hook = Buffer.from(encoded, "base64").toString();
  const cleanerEncoded =
    cloud.match(
      /path: \/usr\/local\/sbin\/tau-runner-clean-workspace\n {4}permissions: '0755'\n {4}encoding: b64\n {4}content: (\S+)/,
    )?.[1] ?? "";
  const cleaner = Buffer.from(cleanerEncoded, "base64").toString();
  expect(hook).toContain("sudo -n /usr/local/sbin/tau-runner-clean-workspace");
  expect(cleaner).toContain("workspace=/opt/actions-runner/_work");
  expect(cleaner).toContain('find "$workspace" -mindepth 1 -depth -delete');
  expect(cleaner).toContain('install -d -o actions -g actions "$workspace"');
  expect(cloud).toContain(
    "actions ALL=(root) NOPASSWD: /usr/local/sbin/tau-runner-clean-workspace",
  );
  expect(cloud).toContain("permissions: '0440'");
});
