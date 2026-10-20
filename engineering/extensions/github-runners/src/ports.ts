import type {
  CloudServer,
  GitHubRunner,
  RunnerManagerConfig,
  Secret,
  WorkflowJob,
} from "./types.js";

export interface Clock {
  now(): Date;
  sleep(ms: number): Promise<void>;
}
export interface MutationLockPort {
  withLock<T>(path: string, operation: () => Promise<T>): Promise<T>;
}
export interface KnownCost {
  tierId: string;
  family: string;
  serverType: string;
  location: string;
  expectedArchitecture: string;
  observedArchitecture: string;
  hourlyPoolEur: number;
  maximumEligibilityEur: number;
  excludes: ["VAT", "variable traffic"];
  sources: string[];
}
export interface CreateServerInput {
  name: string;
  labels: Record<string, string>;
  userData: Secret<string>;
  serverType: string;
  location: string;
  image: string;
  firewallId: string;
  networkId?: string;
  sshKeyIds: string[];
  publicNet: { ipv4: boolean; ipv6: boolean };
}
export interface HCloudPort {
  listOwned(selector: string): Promise<CloudServer[]>;
  getServer(id: string): Promise<CloudServer | undefined>;
  preflight(config: RunnerManagerConfig): Promise<KnownCost>;
  createServer(input: CreateServerInput): Promise<{ id: string }>;
  updateLabels(id: string, labels: Record<string, string>): Promise<void>;
  setProtections(
    id: string,
    input: { delete: boolean; rebuild: boolean },
  ): Promise<void>;
  deleteServer(id: string): Promise<void>;
}
export interface GitHubPort {
  getRepository(): Promise<{ id: string; fullName: string }>;
  listManagedRunners(): Promise<GitHubRunner[]>;
  getRunner(id: string): Promise<GitHubRunner | undefined>;
  listActiveMatchingJobs(
    labels: string[],
  ): Promise<{ jobs: WorkflowJob[]; provenanceComplete: boolean }>;
  createRegistrationToken(): Promise<Secret<string>>;
  setRunnerLabels(id: string, labels: string[]): Promise<void>;
  deleteRunner(id: string): Promise<void>;
  validateOrganizationScope?(): Promise<void>;
  validateWorkflowRouting?(labels: string[]): Promise<void>;
}
