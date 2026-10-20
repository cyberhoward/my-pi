import { describe, expect, it, vi } from "vitest";
import { applyBulkPlans, bulkPreviewText, decodeRemoteBulk, prepareBulkPlans, scopeFingerprint } from "../bulk.js";
import { parseRunnerCommand } from "../index.js";
import { parseReaperRequest } from "../reaper-runtime.js";

const output = (instance: string) => JSON.stringify({ plan: { desiredCapacity: 0, warnings: [], operations: [{ kind: "begin-drain", instance, reason: "destroy" }] }, targets: [{ instance, server: `runner-${instance}` }] });
const previews = [{ policy: "small", code: 0, output: output("first") }, { policy: "large", code: 0, output: output("second") }];

describe("bulk destroy orchestration", () => {
  it("accepts --all only for destroy in both command and remote schemas", () => {
    expect(parseRunnerCommand("destroy --all --apply").all).toBe(true);
    expect(parseReaperRequest({ operation: "destroy", all: true })).toEqual({ operation: "destroy", all: true });
    for (const operation of ["status", "ensure", "drain", "startup"]) expect(() => parseReaperRequest({ operation, all: true })).toThrow();
    expect(() => parseRunnerCommand("destroy --all --instance x")).toThrow();
    expect(() => parseReaperRequest({ operation: "destroy", all: true, instance: "11111111-1111-4111-8111-111111111111" })).toThrow();
  });
  it("binds every policy fingerprint and confirms the complete target preview", async () => {
    const plans = prepareBulkPlans(previews);
    expect(plans[0].fingerprint).not.toBe(plans[1].fingerprint);
    expect(bulkPreviewText(plans)).toContain("runner-first");
    expect(bulkPreviewText(plans)).toContain("runner-second");
    const apply = vi.fn(async (plan) => ({ policy: plan.policy, code: 0, output: "draining" }));
    const confirm = vi.fn(async () => true);
    expect(await applyBulkPlans(plans, confirm, apply)).toHaveLength(2);
    expect(confirm).toHaveBeenCalledOnce();
    expect(apply.mock.calls.map(([plan]) => plan.fingerprint)).toEqual(plans.map(plan => plan.fingerprint));
  });
  it("does not mutate cancelled or incomplete bulk previews", async () => {
    const apply = vi.fn();
    await applyBulkPlans(prepareBulkPlans(previews), async () => false, apply);
    expect(apply).not.toHaveBeenCalled();
    for (const value of [[...previews, previews[0]], [{ ...previews[0], code: 3 }], [{ ...previews[0], output: "truncated" }], [{ ...previews[0], output: JSON.stringify({ plan: { operations: [], warnings: ["unsafe"], desiredCapacity: 0 } }) }]]) expect(() => prepareBulkPlans(value)).toThrow();
  });
  it("stops on partial failure instead of applying unconfirmed replacement plans", async () => {
    const apply = vi.fn(async plan => ({ policy: plan.policy, code: 3, output: "plan changed" }));
    const results = await applyBulkPlans(prepareBulkPlans(previews), async () => true, apply);
    expect(results).toHaveLength(1); expect(apply).toHaveBeenCalledOnce();
  });
  it("requires named unique remote policies for an aggregate preview", () => {
    const scoped = previews.map(item => ({ ...item, scope: "Repository: installed/repo", scopeFingerprint: scopeFingerprint("Repository: installed/repo") }));
    expect(decodeRemoteBulk({ code: 0, text: JSON.stringify(scoped) })).toEqual(scoped);
    expect(decodeRemoteBulk({ code: 0, text: JSON.stringify([scoped[0]]) }, "small")[0].policy).toBe("small");
    expect(() => decodeRemoteBulk({ code: 0, text: JSON.stringify(previews) })).toThrow("authoritative scope");
    expect(() => decodeRemoteBulk({ code: 0, text: output("first") })).toThrow();
    expect(() => decodeRemoteBulk({ code: 0, text: JSON.stringify([previews[0], previews[0]]) })).toThrow();
  });
});
