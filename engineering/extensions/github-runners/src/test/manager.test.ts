import { expect, it, vi } from "vitest";
import { observe } from "../manager.js";
import type { GitHubPort, HCloudPort } from "../ports.js";
import { loadPolicyText } from "../policy-schema.js";
import { validPolicyYaml } from "./policy-fixtures.js";

it("observes demand using workflow capacity labels only", async () => {
  const hcloud = {
    listOwned: vi.fn().mockResolvedValue([]),
  } as unknown as HCloudPort;
  const github = {
    getRepository: vi
      .fn()
      .mockResolvedValue({ id: "123", fullName: "CyberHoward/graditas" }),
    listManagedRunners: vi.fn().mockResolvedValue([]),
    listActiveMatchingJobs: vi
      .fn()
      .mockResolvedValue({ jobs: [], provenanceComplete: true }),
  } as unknown as GitHubPort;

  await observe(hcloud, github, loadPolicyText(validPolicyYaml()).config);

  expect(github.listActiveMatchingJobs).toHaveBeenCalledWith(["small"]);
});
