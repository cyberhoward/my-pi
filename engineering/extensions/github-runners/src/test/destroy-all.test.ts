import { describe, expect, it } from "vitest";
import { parseArgs } from "../args.js";
import { planDestroyAll } from "../destroy.js";
import { configHash, runnerName, slotName } from "../identity.js";
import { loadPolicyText } from "../policy-schema.js";
import type { CloudServer, GitHubRunner, Snapshot } from "../types.js";
import { validPolicyYaml } from "./policy-fixtures.js";

const config = loadPolicyText(validPolicyYaml(p => { p.spec.pool.maxSize = 3; })).config;
const now = new Date("2026-01-02T00:00:00Z");
const instances = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
function server(slot: number, state = "ready"): CloudServer {
  const instance = instances[slot];
  return { id: String(slot), name: slotName("123", config.pool.name, slot), createdAt: "2026-01-01T00:00:00Z", status: "running", protected: true, rebuildProtected: true, labels: {
    ...config.inventory.classificationLabels, "tau-managed": config.inventory.managedLabelValue, "tau-tier": config.tier.id, "tau-repo-id": "123", "tau-pool": config.pool.name, "tau-slot": String(slot), "tau-instance": instance, "tau-config": configHash(config), "tau-state": state, "tau-runner-name": runnerName("123", config.pool.name, slot, instance), ...(state === "draining" ? { "tau-drain-since": "1767311900" } : {}),
  } };
}
function snapshot(servers: CloudServer[] = [], runners: GitHubRunner[] = []): Snapshot { return { repoId: "123", servers, runners, jobs: [], provenanceComplete: true }; }

describe("destroy --all", () => {
  it("accepts only the mutually exclusive destroy selector", () => {
    expect(parseArgs(["destroy", "--all"]).all).toBe(true);
    for (const args of [["status", "--all"], ["ensure", "--all"], ["drain", "--all"], ["destroy", "--all", "--all"], ["destroy", "--all", "--instance", instances[0]], ["destroy"]]) expect(() => parseArgs(args)).toThrow();
  });
  it("plans every owned slot deterministically without creating runners", () => {
    const a = server(0); const b = server(1, "draining");
    const plan = planDestroyAll(snapshot([b, a]), config, now);
    expect(plan.desiredCapacity).toBe(0);
    expect(plan.operations.map(o => [o.kind, o.instance])).toEqual([["begin-drain", instances[0]], ["probe-drain", instances[1]]]);
    expect(plan).toEqual(planDestroyAll(snapshot([a, b]), config, now));
  });
  it("never targets another pool or repository", () => {
    const other = server(1); other.labels["tau-pool"] = "other"; other.labels["tau-repo-id"] = "456";
    expect(planDestroyAll(snapshot([server(0), other]), config, now).operations.map(o => o.instance)).toEqual([instances[0]]);
  });
  it("refuses mismatched or duplicate ownership within the selected pool", () => {
    const changed = server(0); changed.labels["tau-config"] = "different";
    expect(() => planDestroyAll(snapshot([changed]), config, now)).toThrow("ownership");
    expect(() => planDestroyAll(snapshot([server(0), server(0)]), config, now)).toThrow("ownership");
    expect(() => planDestroyAll({ ...snapshot([server(0)]), provenanceComplete: false }, config, now)).toThrow("provenance");
  });
  it("cleans owned offline registrations but refuses unbacked online registrations", () => {
    const runner: GitHubRunner = { id: "1", name: runnerName("123", config.pool.name, 0, instances[0]), status: "offline", busy: false, labels: ["self-hosted", "linux", "x64", "tau-managed", "small", `tau-instance-${instances[0]}`] };
    expect(planDestroyAll(snapshot([], [runner]), config, now).operations[0].kind).toBe("unregister");
    expect(() => planDestroyAll(snapshot([], [{ ...runner, status: "online" }]), config, now)).toThrow("online");
    expect(() => planDestroyAll(snapshot([], [{ ...runner, busy: true }]), config, now)).toThrow("busy");
  });
  it("is an empty no-op after deletion", () => { expect(planDestroyAll(snapshot(), config, now).operations).toEqual([]); });
});
