import type { RepositoryBinding, CommandRunner } from "./repository.js";
import { nodeCommandRunner } from "./repository.js";
import { assertPolicyScope, generatedMaximumLifetimeSeconds, materializePolicies } from "./policies.js";
import type { RunnerSettings, RunnerSize } from "./settings.js";
import type { SetupCredentials, SetupPolicyPreview, SetupServices } from "./setup-types.js";
import { assertLiveConfig, loadPolicy } from "./src/config.js";
import { HCloudClient } from "./src/hcloud.js";
import { assertSupportedSystemImage } from "./src/hcloud-validation.js";
import { GitHubClient } from "./src/github.js";
import type { FetchLike } from "./src/http.js";
import { discoverCatalog, discoverRelease, quoteHcloud, validateGithubScope } from "./src/setup-discovery.js";
import { Secret } from "./src/types.js";

export interface SetupServiceOptions {
  fetcher?: FetchLike;
  env?: NodeJS.ProcessEnv;
  run?: CommandRunner;
}

function value(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const candidate = env[name]?.trim();
  return candidate || undefined;
}

export function createSetupServices(
  binding: RepositoryBinding,
  options: SetupServiceOptions = {},
): SetupServices {
  const fetcher = options.fetcher ?? fetch;
  const env = options.env ?? process.env;
  const run = options.run ?? nodeCommandRunner;
  const ghToken = async (): Promise<string | undefined> => {
    try {
      const result = await run("gh", ["auth", "token", "--hostname", "github.com"], { cwd: binding.root, timeoutMs: 5_000, maxBuffer: 16 * 1024 });
      return result.stdout.trim() || undefined;
    } catch { return undefined; }
  };
  const credentialNames = async (settings: RunnerSettings): Promise<{ hcloud: string[]; github: string[] }> => {
    const materialized = await materializePolicies(binding, settings);
    try {
      const loaded = await Promise.all(materialized.policies.map(async (policy) => loadPolicy(policy.path)));
      return loaded.length ? { hcloud: [...new Set(loaded.map((policy) => policy.credentials.hcloudTokenEnv))], github: [...new Set(loaded.map((policy) => policy.credentials.githubTokenEnv))] } : { hcloud: ["HCLOUD_TOKEN"], github: ["RUNNER_MANAGER_GITHUB_TOKEN"] };
    } finally { await materialized.cleanup(); }
  };
  const credentials = async (settings: RunnerSettings): Promise<SetupCredentials> => {
    const names = await credentialNames(settings);
    const hcloud = names.hcloud.length > 0 && names.hcloud.every((name) => Boolean(value(env, name)));
    const environmentGithub = names.github.length > 0 && names.github.every((name) => Boolean(value(env, name)));
    if (environmentGithub) return { hcloud, github: true, githubSource: "environment", guidance: hcloud ? [] : ["Set the configured Hetzner token environment variable before discovery or activation."] };
    const fallback = await ghToken();
    return { hcloud, github: Boolean(fallback), githubSource: fallback ? "gh" : "missing", guidance: [
      ...(hcloud ? [] : ["Set the configured Hetzner token environment variable before discovery or activation."]),
      ...(fallback ? [] : ["Set the configured GitHub token environment variable or run gh auth login for github.com."]),
    ] };
  };
  const hcloudToken = (): string => {
    const token = value(env, "HCLOUD_TOKEN");
    if (!token) throw new Error("Hetzner credentials are unavailable; set HCLOUD_TOKEN before discovery.");
    return token;
  };
  const assertPinnedRelease = (version: string): void => {
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("runner version must be pinned as digits.digits.digits");
  };
  return {
    credentials,
    catalog: () => discoverCatalog(fetcher, hcloudToken()),
    release: () => discoverRelease(fetcher),
    async validateScope(settings): Promise<void> {
      const available = await credentials(settings);
      if (!available.github) throw new Error("GitHub credentials are unavailable; configure a token or gh auth before validating scope.");
      const names = await credentialNames(settings);
      const token = names.github.map((name) => value(env, name)).find((entry): entry is string => Boolean(entry)) ?? await ghToken();
      if (!token) throw new Error("GitHub credentials are unavailable; configure a token or gh auth before validating scope.");
      await validateGithubScope(fetcher, token, binding.repository, settings.mode === "global" ? settings.organization : undefined);
    },
    async quote(size: RunnerSize, standbyMinutes: number) {
      if (!Number.isInteger(standbyMinutes) || standbyMinutes < 1 || standbyMinutes > 1440) throw new Error("standbyMinutes must be an integer between 1 and 1440");
      const maximumLifetimeSeconds = generatedMaximumLifetimeSeconds(standbyMinutes);
      const cost = await quoteHcloud(fetcher, hcloudToken(), { serverType: size.serverType, location: size.location, ipv4: true, ipv6: true, quantity: size.quantity, maximumLifetimeSeconds });
      return { ...cost, maximumLifetimeSeconds, excludes: ["VAT", "variable traffic"] as ["VAT", "variable traffic"] };
    },
    async preview(settings): Promise<SetupPolicyPreview[]> {
      const materialized = await materializePolicies(binding, settings);
      try {
        if (materialized.policies.length === 0) throw new Error("no active runner policy is configured; add a nonzero pool or policy before previewing");
        const policies = await Promise.all(materialized.policies.map(async (policy) => ({ policy, loaded: await loadPolicy(policy.path) })));
        for (const { loaded } of policies) {
          assertPolicyScope(binding, settings, loaded.config);
          assertLiveConfig(loaded.config);
          assertSupportedSystemImage(loaded.config.hcloud.image);
          assertPinnedRelease(loaded.config.runner.version);
        }
        const missing = policies.find(({ loaded }) => !value(env, loaded.credentials.hcloudTokenEnv));
        if (missing) throw new Error(`Hetzner credentials are unavailable; set ${missing.loaded.credentials.hcloudTokenEnv} before previewing.`);
        return Promise.all(policies.map(async ({ policy, loaded }) => ({
          name: policy.name,
          config: loaded.config,
          cost: await new HCloudClient(fetcher, new Secret(value(env, loaded.credentials.hcloudTokenEnv)!)).preflight(loaded.config),
        })));
      } finally { await materialized.cleanup(); }
    },
    async validate(settings): Promise<void> {
      const materialized = await materializePolicies(binding, settings);
      try {
        if (materialized.policies.length === 0) throw new Error("no active runner policy is configured; add a nonzero pool or policy before activation");
        const policies = await Promise.all(materialized.policies.map(async (policy) => ({ policy, loaded: await loadPolicy(policy.path) })));
        for (const { policy, loaded } of policies) {
          assertPolicyScope(binding, settings, loaded.config);
          if (!loaded.mutationEnabled) throw new Error(`${policy.name} must explicitly enable mutations`);
          assertLiveConfig(loaded.config);
          assertSupportedSystemImage(loaded.config.hcloud.image);
          assertPinnedRelease(loaded.config.runner.version);
        }
        const missingHcloud = policies.find(({ loaded }) => !value(env, loaded.credentials.hcloudTokenEnv));
        if (missingHcloud) throw new Error("credentials are unavailable; set every policy token environment variable or configure gh auth.");
        const allGithubEnvironment = policies.every(({ loaded }) => Boolean(value(env, loaded.credentials.githubTokenEnv)));
        const fallback = allGithubEnvironment ? undefined : await ghToken();
        if (!allGithubEnvironment && !fallback) throw new Error("credentials are unavailable; set every policy token environment variable or configure gh auth.");
        for (const { loaded } of policies) {
          const hcloud = value(env, loaded.credentials.hcloudTokenEnv)!;
          const github = value(env, loaded.credentials.githubTokenEnv) ?? fallback!;
          await validateGithubScope(fetcher, github, binding.repository, loaded.config.organization);
          const githubClient = new GitHubClient(fetcher, loaded.config.repository, new Secret(github), undefined, loaded.config.organization);
          await githubClient.validateOrganizationScope();
          await githubClient.validateWorkflowRouting(loaded.config.pool.routingLabels);
          await new HCloudClient(fetcher, new Secret(hcloud)).preflight(loaded.config);
        }
      } finally { await materialized.cleanup(); }
    },
  };
}
