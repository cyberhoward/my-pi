import { describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { loadPolicyText } from "../policy-schema.js";
import { validPolicyObject, validPolicyYaml } from "./policy-fixtures.js";

it("loads and normalizes a safe YAML infrastructure policy", () => {
  const loaded = loadPolicyText(validPolicyYaml());
  expect(loaded.config.pool.routingLabels).toEqual(["small"]);
  expect(loaded.selectedTier.family).toBe("CX");
  expect(loaded.mutationEnabled).toBe(false);
});
it.each([
  "key: one\nkey: two\n",
  "value: &value one\ncopy: *value\n",
  "---\na: one\n---\na: two\n",
  "value: !unsafe tagged\n",
])("rejects unsafe YAML", (text) =>
  expect(() => loadPolicyText(text)).toThrow());
it("rejects oversized YAML", () =>
  expect(() => loadPolicyText("x".repeat(256 * 1024 + 1))).toThrow("256 KiB"));

describe("strict schema", () => {
  it.each([
    [
      "unknown key",
      (p: any) => {
        p.spec.unknown = true;
      },
    ],
    [
      "missing field",
      (p: any) => {
        delete p.spec.pool.timing;
      },
    ],
    [
      "wrong scalar",
      (p: any) => {
        p.spec.pool.maxSize = "1";
      },
    ],
    [
      "invalid env",
      (p: any) => {
        p.spec.credentials.hcloudTokenEnv = "token-value";
      },
    ],
    [
      "plaintext token",
      (p: any) => {
        p.spec.credentials.token = "secret";
      },
    ],
    [
      "unsafe network",
      (p: any) => {
        p.spec.hetzner.publicNetwork.ipv6 = false;
      },
    ],
    [
      "reserved label",
      (p: any) => {
        p.spec.inventory.classificationLabels["tau-state"] = "ready";
      },
    ],
    [
      "secret classification field",
      (p: any) => {
        p.spec.inventory.classificationLabels.password = "plaintext";
      },
    ],
  ])("rejects %s", (_name, mutate) =>
    expect(() => loadPolicyText(validPolicyYaml(mutate))).toThrow());
});

describe("tier compatibility", () => {
  it.each([
    "CX",
    "CPX",
    "CAX",
    "CCX",
  ])("rejects a false %s architecture declaration", (family) => {
    const policy = validPolicyObject();
    const tier: any = Object.values(policy.spec.tierCatalog).find(
      (entry: any) => entry.family === family,
    );
    tier.architecture = tier.architecture === "x86" ? "arm64" : "x86";
    expect(() => loadPolicyText(stringify(policy))).toThrow("truth table");
  });
  it("rejects CAX for the x64 runner locally", () => {
    expect(() =>
      loadPolicyText(
        validPolicyYaml((p) => {
          p.spec.pool.selectedTier = "cax-shared-arm64";
          p.spec.hetzner.serverType = "cax11";
        }),
      ),
    ).toThrow(
      "tier CAX/arm64 is incompatible with runner architecture x64; ARM runner support is not implemented",
    );
  });
  it.each([
    "cx-shared-x86",
    "cx-large-x86",
    "cpx-shared-x86",
    "ccx-dedicated-x86",
  ])("accepts x86 tier %s", (tier) =>
    expect(() =>
      loadPolicyText(
        validPolicyYaml((p) => {
          p.spec.pool.selectedTier = tier;
        }),
      ),
    ).not.toThrow());
  it("rejects a server type outside the selected tier", () =>
    expect(() =>
      loadPolicyText(
        validPolicyYaml((p) => {
          p.spec.hetzner.serverType = "cpx11";
        }),
      ),
    ).toThrow("selected tier"));
});

describe("canonical effective fingerprint", () => {
  const hash = async (yaml: string) => {
    const { configHash } = await import("../identity.js");
    return configHash(loadPolicyText(yaml).config);
  };
  it("ignores catalog documentation, unselected tiers, and credential env names", async () => {
    const baseline = await hash(validPolicyYaml());
    const changed = validPolicyYaml((p) => {
      p.spec.credentials.githubTokenEnv = "OTHER_GITHUB_TOKEN";
      p.spec.tierCatalog["cx-shared-x86"].sources.reverse();
      p.spec.tierCatalog["cax-shared-arm64"].serverTypes.push("cax51");
    });
    expect(await hash(changed)).toBe(baseline);
  });
  it("changes for effective safety and classification choices", async () => {
    const baseline = await hash(validPolicyYaml());
    expect(
      await hash(
        validPolicyYaml((p) => {
          p.spec.pool.timing.maximumLifetimeSeconds += 1;
        }),
      ),
    ).not.toBe(baseline);
    expect(
      await hash(
        validPolicyYaml((p) => {
          p.spec.inventory.classificationLabels.environment = "staging";
        }),
      ),
    ).not.toBe(baseline);
  });
});
it("rejects the removed JSON policy format with migration guidance", async () => {
  const { loadPolicy } = await import("../config.js");
  await expect(loadPolicy("old.json")).rejects.toThrow(
    "JSON policies are no longer supported",
  );
});
it("does not strand servers for coordination or selected catalog allowlist metadata changes", async () => {
  const { configHash } = await import("../identity.js");
  const baseline = loadPolicyText(validPolicyYaml()).config;
  const changed = loadPolicyText(
    validPolicyYaml((p) => {
      p.spec.coordination.lockPath = "/different/shared/lock";
      p.spec.tierCatalog["cx-shared-x86"].serverTypes.push("cx63");
    }),
  ).config;
  expect(configHash(changed)).toBe(configHash(baseline));
});
it("fingerprints effective tier, type, routing, but not mutation enablement", async () => {
  const { configHash } = await import("../identity.js");
  const live = (mutate?: (p: any) => void) =>
    loadPolicyText(
      validPolicyYaml((p) => {
        p.spec.pool.selectedTier = "cx-large-x86";
        p.spec.hetzner.serverType = "cx33";
        p.spec.hetzner.location = "fsn1";
        p.spec.hetzner.firewallId = "1";
        p.spec.runner.version = "2.999.0";
        p.spec.runner.archiveSha256 = "a".repeat(64);
        mutate?.(p);
      }),
    ).config;
  const baseline = configHash(live());
  expect(
    configHash(live((p) => (p.spec.hetzner.serverType = "cx43"))),
  ).not.toBe(baseline);
  expect(
    configHash(
      live((p) => {
        p.spec.pool.selectedTier = "cpx-shared-x86";
        p.spec.hetzner.serverType = "cpx11";
      }),
    ),
  ).not.toBe(baseline);
  expect(
    configHash(
      live((p) => {
        p.spec.tierCatalog["cx-large-x86"].githubRoutingLabels = ["custom"];
      }),
    ),
  ).not.toBe(baseline);
  expect(configHash(live((p) => (p.spec.mutation.enabled = true)))).toBe(
    baseline,
  );
});
