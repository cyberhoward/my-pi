import { expect, it } from "vitest";
import { stringify } from "yaml";
import { configHash, ownershipSelector, runnerName, slotName } from "../identity.js";
import { validServerIdentity } from "../inventory.js";
import { loadPolicyText } from "../policy-schema.js";
import { validPolicyObject } from "./policy-fixtures.js";

const genericConfig = () => {
  const policy = validPolicyObject();
  policy.apiVersion = "runner-manager.pi.dev/v1alpha1";
  policy.metadata.name = "portable-runners";
  policy.spec.inventory.managedLabelValue = "pi-github-runners-v1";
  policy.spec.tierCatalog = {
    economical: policy.spec.tierCatalog["cx-shared-x86"],
  };
  policy.spec.pool.selectedTier = "economical";
  return loadPolicyText(stringify(policy)).config;
};

it("preserves the legacy name and effective-config hash golden", () => {
  const policy = validPolicyObject();
  policy.metadata.name = "x";
  policy.spec.github.repository = "owner/repo";
  policy.spec.coordination.lockPath = "/tmp/x";
  policy.spec.credentials.githubTokenEnv = "GITHUB_TOKEN";
  policy.spec.inventory.classificationLabels = { environment: "ci" };
  for (const [name, tier] of Object.entries(policy.spec.tierCatalog)) {
    tier.serverTypes = [name.startsWith("ccx") ? "ccx13" : name.startsWith("cpx") ? "cpx11" : name.startsWith("cax") ? "cax11" : name === "cx-large-x86" ? "cx33" : "cx23"];
    tier.sources = ["https://www.hetzner.com/cloud/cost-optimized"];
  }
  const config = loadPolicyText(stringify(policy)).config;
  expect(config.identity).toEqual({ apiVersion: "runner-manager.graditas.app/v1alpha1", slotPrefix: "tau-mg" });
  expect(slotName("123", "linux-x64", 0, config.identity.slotPrefix)).toBe("tau-mg-123-linux-x64-0");
  expect(configHash(config)).toBe("177757f4783b");
});

it("uses a generic isolated namespace and never adopts legacy inventory", () => {
  const config = genericConfig();
  const instance = "11111111-1111-4111-8111-111111111111";
  const name = slotName("123", config.pool.name, 0, config.identity.slotPrefix);
  expect(name).toBe("pi-ghr-123-linux-x64-0");
  expect(ownershipSelector("123", config.inventory.managedLabelValue)).toBe("tau-managed=pi-github-runners-v1,tau-repo-id=123");
  expect(ownershipSelector("123", "my-gratitude-runner-v1")).not.toBe(ownershipSelector("123", config.inventory.managedLabelValue));
  expect(validServerIdentity({
    id: "1",
    name: "tau-mg-123-linux-x64-0",
    createdAt: "2026-01-01T00:00:00Z",
    status: "running",
    protected: true,
    rebuildProtected: true,
    labels: {
      "tau-managed": "my-gratitude-runner-v1",
      "tau-repo-id": "123",
      "tau-pool": config.pool.name,
      "tau-slot": "0",
      "tau-instance": instance,
      "tau-state": "ready",
      "tau-config": configHash(config),
      "tau-runner-name": runnerName("123", config.pool.name, 0, instance, "tau-mg"),
    },
  }, instance, "123", config, new Date("2026-01-02T00:00:00Z"))).toBeUndefined();
});

it("accepts a minimal generic x64 tier catalog", () => {
  const config = genericConfig();
  expect(config.tier.id).toBe("economical");
  expect(config.tier.serverTypes).toEqual(["cx23"]);
});
