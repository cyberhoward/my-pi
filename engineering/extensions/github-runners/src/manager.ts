import { ownershipSelector } from "./identity.js";
import type { GitHubPort, HCloudPort } from "./ports.js";
import type { RunnerManagerConfig, Snapshot } from "./types.js";
export async function observe(
  hcloud: HCloudPort,
  github: GitHubPort,
  config: RunnerManagerConfig,
): Promise<{ snapshot: Snapshot; repoId: string }> {
  const repository = await github.getRepository();
  const [servers, runners, demand] = await Promise.all([
    hcloud.listOwned(ownershipSelector(repository.id, config.inventory.managedLabelValue)),
    github.listManagedRunners(),
    github.listActiveMatchingJobs(config.pool.routingLabels),
  ]);
  return {
    repoId: repository.id,
    snapshot: {
      repoId: repository.id,
      servers,
      runners,
      jobs: demand.jobs,
      provenanceComplete: demand.provenanceComplete,
    },
  };
}
