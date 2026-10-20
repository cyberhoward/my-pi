import { stringify } from "yaml";

export function validPolicyObject(): any {
  return {
    apiVersion: "runner-manager.graditas.app/v1alpha1",
    kind: "RunnerInfrastructurePolicy",
    metadata: { name: "graditas-external-runners" },
    spec: {
      mutation: { enabled: false },
      credentials: {
        hcloudTokenEnv: "HCLOUD_TOKEN",
        githubTokenEnv: "RUNNER_MANAGER_GITHUB_TOKEN",
      },
      coordination: { lockPath: "/var/tmp/graditas-runner-manager.lock" },
      github: { repository: "CyberHoward/graditas" },
      pool: {
        name: "linux-x64",
        selectedTier: "cx-shared-x86",
        maxSize: 1,
        costs: { maxKnownHourlyPoolEur: 0.01, maxKnownEligibilityEur: 0.01 },
        timing: {
          scaleUpDelaySeconds: 45,
          idleGraceSeconds: 900,
          bootstrapGraceSeconds: 900,
          drainQuiescenceSeconds: 65,
          drainProbeSeconds: 5,
          maximumLifetimeSeconds: 14400,
        },
      },
      runner: { architecture: "x64", version: null, archiveSha256: null },
      hetzner: {
        serverType: null,
        location: null,
        image: "ubuntu-24.04",
        firewallId: null,
        networkId: null,
        sshKeyIds: [],
        publicNetwork: { ipv4: true, ipv6: true },
      },
      inventory: {
        managedLabelValue: "my-gratitude-runner-v1",
        classificationLabels: {
          environment: "ci",
          workload: "github-actions",
          "data-classification": "internal",
        },
      },
      tierCatalog: {
        "cx-shared-x86": {
          family: "CX",
          cpuClass: "shared",
          performanceClass: "cost-optimized",
          architecture: "x86",
          serverTypes: ["cx23"],
          githubRoutingLabels: ["small"],
          sources: [
            "https://www.hetzner.com/cloud/cost-optimized",
            "https://docs.hetzner.com/cloud/technical-details/faq/",
          ],
        },
        "cx-large-x86": {
          family: "CX",
          cpuClass: "shared",
          performanceClass: "cost-optimized",
          architecture: "x86",
          serverTypes: ["cx33", "cx43", "cx53"],
          githubRoutingLabels: ["large"],
          sources: [
            "https://www.hetzner.com/cloud/cost-optimized",
            "https://docs.hetzner.com/cloud/technical-details/faq/",
          ],
        },
        "cpx-shared-x86": {
          family: "CPX",
          cpuClass: "shared",
          performanceClass: "regular",
          architecture: "x86",
          serverTypes: ["cpx11", "cpx12", "cpx21"],
          githubRoutingLabels: ["small"],
          sources: [
            "https://www.hetzner.com/cloud/regular-performance",
            "https://docs.hetzner.com/cloud/technical-details/faq/",
          ],
        },
        "cax-shared-arm64": {
          family: "CAX",
          cpuClass: "shared",
          performanceClass: "cost-optimized",
          architecture: "arm64",
          serverTypes: ["cax11", "cax21", "cax31", "cax41"],
          githubRoutingLabels: ["arm64"],
          sources: [
            "https://www.hetzner.com/cloud/cost-optimized",
            "https://docs.hetzner.com/cloud/technical-details/faq/",
          ],
        },
        "ccx-dedicated-x86": {
          family: "CCX",
          cpuClass: "dedicated",
          performanceClass: "general-purpose",
          architecture: "x86",
          serverTypes: ["ccx13", "ccx23", "ccx33"],
          githubRoutingLabels: ["large"],
          sources: [
            "https://www.hetzner.com/cloud/general-purpose",
            "https://docs.hetzner.com/cloud/technical-details/faq/",
          ],
        },
      },
    },
  };
}
export const validPolicyYaml = (patch?: (policy: any) => void): string => {
  const policy = validPolicyObject();
  patch?.(policy);
  return stringify(policy);
};
