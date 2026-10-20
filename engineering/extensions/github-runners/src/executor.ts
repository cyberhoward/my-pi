import { renderCloudInit } from "./cloud-init.js";
import {
  configHash,
  runnerName as identityRunnerName,
  newInstanceId,
  ownershipSelector,
  parseLifecycleEpoch,
  slotName,
} from "./identity.js";
import { hasExpectedRunnerLabels } from "./inventory.js";
import type { Clock, GitHubPort, HCloudPort } from "./ports.js";
import {
  type CloudServer,
  type PlanOperation,
  ProviderFailure,
  type RunnerManagerConfig,
  SafeRefusal,
} from "./types.js";

const systemClock: Clock = {
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
export class Executor {
  constructor(
    private readonly hcloud: HCloudPort,
    private readonly github: GitHubPort,
    private readonly config: RunnerManagerConfig,
    private readonly repoId: string,
    private readonly clock: Clock = systemClock,
  ) {}
  async ensureSlot(slot: number): Promise<void> {
    if (slot < 0 || slot >= this.config.pool.maxSize)
      throw new SafeRefusal("slot exceeds configured pool");
    const name = slotName(this.repoId, this.config.pool.name, slot, this.config.identity.slotPrefix);
    const existing = (await this.owned()).find(
      (server) => server.name === name,
    );
    if (existing) {
      this.fence(existing, existing.labels["tau-instance"], slot, name);
      await this.repairProtections(existing);
      await this.markReadyWhenOnline(existing);
      return;
    }
    await this.hcloud.preflight(this.config);
    const token = await this.github.createRegistrationToken();
    const instance = newInstanceId();
    const runnerName = identityRunnerName(
      this.repoId,
      this.config.pool.name,
      slot,
      instance,
      this.config.identity.slotPrefix,
    );
    const labels = {
      ...this.config.inventory.classificationLabels,
      "tau-managed": this.config.inventory.managedLabelValue,
      "tau-tier": this.config.tier.id,
      "tau-repo-id": this.repoId,
      "tau-pool": this.config.pool.name,
      "tau-slot": String(slot),
      "tau-instance": instance,
      "tau-state": "provisioning",
      "tau-config": configHash(this.config),
      "tau-runner-name": runnerName,
    };
    const userData = renderCloudInit({
      repository: this.config.repository,
      organization: this.config.organization ? {
        name: this.config.organization.name,
        repositories: this.config.organization.repositories,
        runnerGroupName: this.config.organization.runnerGroupName,
      } : undefined,
      runnerName,
      customLabels: [
        ...this.config.pool.routingLabels,
        "tau-managed",
        `tau-instance-${instance}`,
      ],
      registrationToken: token,
      runnerVersion: this.config.runner.version,
      archiveSha256: this.config.runner.archiveSha256,
    });
    try {
      const created = await this.hcloud.createServer({
        name,
        labels,
        userData,
        serverType: this.config.hcloud.serverType,
        location: this.config.hcloud.location,
        image: this.config.hcloud.image,
        firewallId: this.config.hcloud.firewallId,
        networkId: this.config.hcloud.networkId,
        sshKeyIds: this.config.hcloud.sshKeyIds,
        publicNet: this.config.hcloud.publicNet,
      });
      const server = await this.hcloud.getServer(created.id);
      if (!server) throw new ProviderFailure("created server disappeared");
      this.fence(server, instance, slot, name);
      await this.repairProtections(server);
      await this.markReadyWhenOnline(server);
    } catch (error) {
      const adopted = (await this.owned()).find(
        (server) => server.name === name,
      );
      if (!adopted) throw error;
      this.fence(adopted, adopted.labels["tau-instance"], slot, name);
      await this.repairProtections(adopted);
      if (
        error instanceof ProviderFailure &&
        error.message.startsWith("ambiguous create")
      ) {
        await this.markReadyWhenOnline(adopted);
        return;
      }
      throw error;
    }
  }
  async beginDrain(instance: string): Promise<void> {
    await this.assertDestructiveRouting();
    const { server, runner } = await this.find(instance, false, true);
    if (runner)
      await this.github.setRunnerLabels(runner.id, [
        "tau-managed",
        "tau-draining",
        `tau-instance-${instance}`,
      ]);
    await this.hcloud.updateLabels(server.id, {
      ...server.labels,
      "tau-state": "draining",
      "tau-drain-since": String(Math.floor(this.clock.now().getTime() / 1000)),
    });
  }
  async destroyAfterQuiescence(instance: string): Promise<void> {
    const first = await this.find(instance, false, true);
    const initialDrainLabel = first.server.labels["tau-drain-since"];
    const drainSince = parseLifecycleEpoch(
      initialDrainLabel,
      this.clock.now(),
      "tau-drain-since",
    );
    this.fenceDraining(first.server, instance, initialDrainLabel);
    if (
      this.clock.now().getTime() / 1000 - drainSince <
      this.config.pool.drainQuiescenceSeconds
    )
      throw new SafeRefusal("drain quiescence has not elapsed");
    if (first.runner?.busy)
      throw new SafeRefusal("runner is busy; refusing teardown");
    const firstDemand = await this.demand();
    if (!firstDemand.safe)
      throw new SafeRefusal("demand provenance is ambiguous");
    await this.clock.sleep(this.config.pool.drainProbeSeconds * 1000);
    const second = await this.find(instance, first.runner === undefined, true);
    this.fenceDraining(second.server, instance, initialDrainLabel);
    if (first.runner && !second.runner)
      throw new SafeRefusal("runner disappeared during drain probe");
    if (second.runner?.busy)
      throw new SafeRefusal("assignment appeared during drain probe");
    const secondDemand = await this.demand();
    if (!secondDemand.safe)
      throw new SafeRefusal("demand changed during drain probe");
    const final = second.runner
      ? await this.github.getRunner(second.runner.id)
      : undefined;
    if (second.runner && !final)
      throw new SafeRefusal("runner disappeared before unregister");
    if (final?.busy)
      throw new SafeRefusal("runner became busy before unregister");
    if (final && second.runner) {
      this.fenceRunner(
        final,
        instance,
        second.server.labels["tau-runner-name"],
        true,
      );
      if (
        final.id !== second.runner.id ||
        final.name !== second.runner.name ||
        JSON.stringify([...final.labels].sort()) !==
          JSON.stringify([...second.runner.labels].sort())
      )
        throw new SafeRefusal("runner identity changed before unregister");
      await this.github.deleteRunner(final.id);
    }
    const owned = await this.hcloud.getServer(second.server.id);
    if (!owned)
      throw new SafeRefusal("server disappeared before deletion fence");
    this.fenceDraining(owned, instance, initialDrainLabel);
    await this.hcloud.setProtections(owned.id, {
      delete: false,
      rebuild: false,
    });
    const unprotected = await this.hcloud.getServer(owned.id);
    if (!unprotected)
      throw new SafeRefusal("server disappeared after unprotect");
    this.fenceDraining(unprotected, instance, initialDrainLabel);
    if (unprotected.protected || unprotected.rebuildProtected)
      throw new SafeRefusal("server protections remain enabled");
    await this.hcloud.deleteServer(unprotected.id);
  }
  async execute(operation: PlanOperation): Promise<void> {
    await this.assertOrganizationScope();
    if (operation.kind === "ensure-slot") {
      if (operation.slot === undefined)
        throw new SafeRefusal("ensure lacks slot");
      return this.ensureSlot(operation.slot);
    }
    if (!operation.instance)
      throw new SafeRefusal("operation lacks immutable instance identity");
    if (operation.kind === "unregister" || operation.kind === "probe-drain")
      await this.assertDestructiveRouting();
    if (operation.kind === "begin-drain")
      return this.beginDrain(operation.instance);
    if (operation.kind === "probe-drain")
      return this.destroyAfterQuiescence(operation.instance);
    if (operation.kind === "set-idle" || operation.kind === "clear-idle") {
      const { server } = await this.find(operation.instance);
      const labels = { ...server.labels };
      if (operation.kind === "set-idle")
        labels["tau-idle-since"] = String(
          Math.floor(this.clock.now().getTime() / 1000),
        );
      else delete labels["tau-idle-since"];
      await this.hcloud.updateLabels(server.id, labels);
      return;
    }
    if (operation.kind === "unregister") {
      await this.unregisterStaleRunner(operation.instance);
      return;
    }
    if (operation.kind === "mark-ready") {
      const { server, runner } = await this.find(operation.instance);
      if (!runner || runner.status !== "online")
        throw new SafeRefusal("runner is not conclusively online");
      await this.hcloud.updateLabels(server.id, {
        ...server.labels,
        "tau-state": "ready",
      });
      return;
    }
    if (operation.kind === "repair-protection") {
      const server = await this.findServer(operation.instance);
      await this.repairProtections(server);
      return;
    }
    if (
      ["retain-draining", "refuse", "report-foreign"].includes(operation.kind)
    )
      return;
    throw new SafeRefusal(`unsupported operation ${operation.kind}`);
  }
  private async markReadyWhenOnline(server: CloudServer): Promise<void> {
    if (server.labels["tau-state"] === "ready") return;
    const runnerName = server.labels["tau-runner-name"];
    const instance = server.labels["tau-instance"];
    const created = new Date(server.createdAt).getTime();
    const deadline = created + this.config.pool.bootstrapGraceSeconds * 1000;
    while (true) {
      const candidates = (await this.github.listManagedRunners()).filter(
        (runner) =>
          runner.name === runnerName ||
          runner.labels.includes(`tau-instance-${instance}`),
      );
      const candidate = candidates.length === 1 ? candidates[0] : undefined;
      let validOnline = false;
      if (candidate?.status === "online") {
        try {
          this.fenceRunner(candidate, instance, runnerName);
          validOnline = true;
        } catch {
          validOnline = false;
        }
      }
      if (candidate && validOnline) {
        const fresh = await this.hcloud.getServer(server.id);
        if (!fresh)
          throw new SafeRefusal("server disappeared before ready persistence");
        this.fence(fresh, instance);
        if (
          fresh.labels["tau-state"] !== "provisioning" ||
          !fresh.protected ||
          !fresh.rebuildProtected
        )
          throw new SafeRefusal(
            "server provisioning state or protections changed before ready persistence",
          );
        await this.hcloud.updateLabels(fresh.id, {
          ...fresh.labels,
          "tau-state": "ready",
        });
        return;
      }
      if (this.clock.now().getTime() > deadline) break;
      await this.clock.sleep(this.config.pool.drainProbeSeconds * 1000);
    }
    throw new ProviderFailure(
      "runner bootstrap grace expired before online registration",
    );
  }
  private async repairProtections(server: CloudServer): Promise<void> {
    if (!server.protected || !server.rebuildProtected)
      await this.hcloud.setProtections(server.id, {
        delete: true,
        rebuild: true,
      });
    const verified = await this.hcloud.getServer(server.id);
    if (!verified)
      throw new ProviderFailure("server disappeared during protection repair");
    this.fence(verified, server.labels["tau-instance"]);
    if (!verified.protected || !verified.rebuildProtected)
      throw new ProviderFailure("delete/rebuild protections not enabled");
  }
  private async assertOrganizationScope(): Promise<void> {
    if (!this.config.organization) return;
    if (!this.github.validateOrganizationScope) throw new SafeRefusal("GitHub client cannot validate organization runner group");
    await this.github.validateOrganizationScope();
  }
  private async assertDestructiveRouting(): Promise<void> {
    if (this.config.identity.apiVersion !== "runner-manager.pi.dev/v1alpha1") return;
    if (!this.github.validateWorkflowRouting) throw new SafeRefusal("GitHub client cannot prove workflow routing safety");
    await this.github.validateWorkflowRouting(this.config.pool.routingLabels);
  }
  private async demand(): Promise<{ safe: boolean }> {
    const value = await this.github.listActiveMatchingJobs(
      this.config.pool.routingLabels,
    );
    return { safe: value.provenanceComplete };
  }
  private owned(): Promise<CloudServer[]> {
    return this.hcloud.listOwned(ownershipSelector(this.repoId, this.config.inventory.managedLabelValue));
  }
  private fence(
    server: CloudServer,
    instance?: string,
    expectedSlot?: number,
    expectedName?: string,
  ): void {
    const slot = Number(server.labels["tau-slot"]);
    const name =
      Number.isInteger(slot) && slot >= 0 && slot < this.config.pool.maxSize
        ? slotName(this.repoId, this.config.pool.name, slot, this.config.identity.slotPrefix)
        : "";
    const state = server.labels["tau-state"];
    let timestampsValid = true;
    try {
      if (server.labels["tau-idle-since"] !== undefined)
        parseLifecycleEpoch(
          server.labels["tau-idle-since"],
          this.clock.now(),
          "tau-idle-since",
        );
      if (server.labels["tau-drain-since"] !== undefined)
        parseLifecycleEpoch(
          server.labels["tau-drain-since"],
          this.clock.now(),
          "tau-drain-since",
        );
      if (state === "draining")
        parseLifecycleEpoch(
          server.labels["tau-drain-since"],
          this.clock.now(),
          "tau-drain-since",
        );
    } catch {
      timestampsValid = false;
    }
    const policyLabelsValid =
      this.config.tier.id === "legacy-x86" ||
      (server.labels["tau-tier"] === this.config.tier.id &&
        Object.entries(this.config.inventory.classificationLabels).every(
          ([key, value]) => server.labels[key] === value,
        ));
    if (
      !instance ||
      !policyLabelsValid ||
      server.labels["tau-managed"] !==
        this.config.inventory.managedLabelValue ||
      server.labels["tau-repo-id"] !== this.repoId ||
      server.labels["tau-pool"] !== this.config.pool.name ||
      server.labels["tau-config"] !== configHash(this.config) ||
      server.labels["tau-instance"] !== instance ||
      !["provisioning", "ready", "draining"].includes(state ?? "") ||
      !timestampsValid ||
      server.name !== name ||
      server.labels["tau-runner-name"] !==
        identityRunnerName(
          this.repoId,
          this.config.pool.name,
          slot,
          instance,
          this.config.identity.slotPrefix,
        ) ||
      (expectedSlot !== undefined && slot !== expectedSlot) ||
      (expectedName !== undefined && name !== expectedName)
    )
      throw new SafeRefusal("complete server ownership fence failed");
  }
  private fenceDraining(
    server: CloudServer,
    instance: string,
    drainSince: string | undefined,
  ): void {
    this.fence(server, instance);
    if (
      server.labels["tau-state"] !== "draining" ||
      server.labels["tau-drain-since"] !== drainSince
    )
      throw new SafeRefusal("draining state changed during teardown");
  }
  private async unregisterStaleRunner(instance: string): Promise<void> {
    const matches = (await this.github.listManagedRunners()).filter((runner) =>
      runner.labels.includes(`tau-instance-${instance}`),
    );
    if (matches.length !== 1)
      throw new SafeRefusal(
        `stale runner identity must have exactly one match; found ${matches.length}`,
      );
    const runner = matches[0];
    const normalized = new Set(
      runner.labels.map((label) => label.toLowerCase()),
    );
    const required = ["self-hosted", "linux", "x64", "tau-managed"];
    const identityLabels = runner.labels.filter((label) =>
      label.startsWith("tau-instance-"),
    );
    const deterministicName = Array.from(
      { length: this.config.pool.maxSize },
      (_, slot) =>
        identityRunnerName(this.repoId, this.config.pool.name, slot, instance, this.config.identity.slotPrefix),
    ).includes(runner.name);
    if (
      !required.every((label) => normalized.has(label)) ||
      identityLabels.length !== 1 ||
      !deterministicName ||
      runner.status !== "offline" ||
      runner.busy
    )
      throw new SafeRefusal("stale runner deterministic identity changed");
    const fresh = await this.github.getRunner(runner.id);
    if (!fresh)
      throw new SafeRefusal("stale runner disappeared before unregister");
    if (
      fresh.id !== runner.id ||
      fresh.name !== runner.name ||
      fresh.busy ||
      fresh.status !== "offline" ||
      fresh.status !== runner.status ||
      JSON.stringify([...fresh.labels].sort()) !==
        JSON.stringify([...runner.labels].sort())
    )
      throw new SafeRefusal(
        "stale runner changed or is busy before unregister",
      );
    await this.github.deleteRunner(fresh.id);
  }
  private fenceRunner(
    runner: { name: string; labels: string[] },
    instance: string,
    expectedName: string,
    draining = false,
  ): void {
    if (
      runner.name !== expectedName ||
      !hasExpectedRunnerLabels(runner.labels, instance, this.config, draining)
    )
      throw new SafeRefusal("runner complete identity fence failed");
  }
  private async findServer(instance: string): Promise<CloudServer> {
    const matches = (await this.owned()).filter(
      (server) => server.labels["tau-instance"] === instance,
    );
    if (matches.length !== 1)
      throw new SafeRefusal(
        `owned server identity must be unique; found ${matches.length}`,
      );
    this.fence(matches[0], instance);
    return matches[0];
  }
  private async find(
    instance: string,
    allowAbsentRunner = false,
    allowInterruptedDrain = false,
  ) {
    const [servers, runners] = await Promise.all([
      this.owned(),
      this.github.listManagedRunners(),
    ]);
    const matchingServers = servers.filter(
      (value) => value.labels["tau-instance"] === instance,
    );
    const matchingRunners = runners.filter((value) =>
      value.labels.includes(`tau-instance-${instance}`),
    );
    if (matchingServers.length !== 1)
      throw new SafeRefusal(
        `owned server identity must be unique; found ${matchingServers.length}`,
      );
    if (matchingRunners.length > 1)
      throw new SafeRefusal(
        `runner identity must be unique; found ${matchingRunners.length}`,
      );
    const server = matchingServers[0];
    this.fence(server, instance);
    const runner = matchingRunners[0];
    if (runner)
      this.fenceRunner(
        runner,
        instance,
        server.labels["tau-runner-name"],
        server.labels["tau-state"] === "draining" ||
          (allowInterruptedDrain &&
            server.labels["tau-state"] === "ready" &&
            hasExpectedRunnerLabels(
              runner.labels,
              instance,
              this.config,
              true,
            )),
      );
    if (!runner && !allowAbsentRunner && server.labels["tau-state"] === "ready")
      throw new SafeRefusal("expected runner is absent");
    return { server, runner };
  }
}
