export class UsageError extends Error {
  readonly exitCode = 2;
}
export class SafeRefusal extends Error {
  readonly exitCode = 3;
}
export class OperatorWarning extends Error {
  readonly exitCode = 5;
}
export class ProviderFailure extends Error {
  readonly exitCode = 4;
}
export class Secret<T> {
  readonly #value: T;
  constructor(value: T) {
    this.#value = value;
  }
  reveal(): T {
    return this.#value;
  }
  toJSON(): "[REDACTED]" {
    return "[REDACTED]";
  }
}
export interface RunnerManagerConfig {
  identity: {
    apiVersion: "runner-manager.graditas.app/v1alpha1" | "runner-manager.pi.dev/v1alpha1";
    slotPrefix: string;
  };
  repository: string;
  organization?: {
    name: string;
    repositories: string[];
    runnerGroupId: number;
    runnerGroupName: string;
  };
  pool: {
    name: string;
    routingLabels: string[];
    maxSize: number;
    scaleUpDelaySeconds: number;
    idleGraceSeconds: number;
    bootstrapGraceSeconds: number;
    drainQuiescenceSeconds: number;
    drainProbeSeconds: number;
    maximumLifetimeSeconds: number;
    maxKnownHourlyPoolCostEur: number;
    maxKnownEligibilityCostEur: number;
  };
  hcloud: {
    serverType: string;
    location: string;
    image: string;
    firewallId: string;
    networkId?: string;
    sshKeyIds: string[];
    publicNet: { ipv4: boolean; ipv6: boolean };
  };
  coordination: { lockPath: string };
  runner: { architecture: "x64"; version: string; archiveSha256: string };
  tier: {
    id: string;
    family: "CX" | "CPX" | "CAX" | "CCX";
    architecture: "x86" | "arm64";
    serverTypes: string[];
    sources: string[];
  };
  inventory: {
    managedLabelValue: string;
    classificationLabels: Record<string, string>;
  };
}
export interface LoadedPolicy {
  config: RunnerManagerConfig;
  credentials: { hcloudTokenEnv: string; githubTokenEnv: string };
  mutationEnabled: boolean;
  selectedTier: RunnerManagerConfig["tier"];
}
export interface CloudServer {
  id: string;
  name: string;
  createdAt: string;
  status: string;
  labels: Record<string, string>;
  protected: boolean;
  rebuildProtected: boolean;
}
export interface GitHubRunner {
  id: string;
  name: string;
  busy: boolean;
  status: string;
  labels: string[];
}
export interface WorkflowJob {
  id: string;
  status: string;
  labels: string[];
  createdAt: string;
  runnerId?: string;
}
export interface Snapshot {
  repoId: string;
  servers: CloudServer[];
  runners: GitHubRunner[];
  jobs: WorkflowJob[];
  provenanceComplete: boolean;
}
export interface PlanOperation {
  kind: string;
  instance?: string;
  slot?: number;
  reason: string;
  destructive?: boolean;
}
export interface ReconcilePlan {
  desiredCapacity: number;
  operations: PlanOperation[];
  warnings: string[];
}
