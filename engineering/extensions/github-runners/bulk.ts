import { createHash } from "node:crypto";
import type { RunnerSettings } from "./settings.js";
import { planFingerprint } from "./src/cli.js";
import type { ReconcilePlan } from "./src/types.js";

export type BulkResult = { policy: string; code: number; output: string; scope?: string; scopeFingerprint?: string };
export function bulkScope(repository: string, settings: RunnerSettings): string {
  return settings.mode === "global" ? `SHARED ORGANIZATION POOL: ${settings.organization?.name}; group: ${settings.organization?.runnerGroupName} (#${settings.organization?.runnerGroupId}); affects repositories: ${settings.organization?.repositories.slice().sort().join(", ")}` : `Repository: ${repository}`;
}
export function scopeFingerprint(scope: string): string { return createHash("sha256").update(scope).digest("hex"); }
export type BulkPlan = BulkResult & { fingerprint: string };

export function prepareBulkPlans(results: BulkResult[]): BulkPlan[] {
  const names = new Set<string>();
  return results.map(result => {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(result.policy) || names.has(result.policy)) throw new Error("bulk preview has invalid or duplicate policy names");
    names.add(result.policy);
    if (result.code !== 0) throw new Error(`bulk preview failed for ${result.policy}: ${result.output}`);
    const value = JSON.parse(result.output) as { plan?: ReconcilePlan };
    const plan = value?.plan;
    if (!plan || plan.desiredCapacity !== 0 || !Array.isArray(plan.operations) || !Array.isArray(plan.warnings) || plan.warnings.length || plan.operations.some(operation => !["begin-drain", "probe-drain", "unregister"].includes(operation.kind) || typeof operation.instance !== "string")) throw new Error(`bulk preview is incomplete or unsafe for ${result.policy}`);
    return { ...result, fingerprint: planFingerprint(plan) };
  });
}
export function bulkPreviewText(results: BulkResult[]): string { return results.map(result => `Policy: ${result.policy}\n${result.output}`).join("\n\n"); }
export async function applyBulkPlans(plans: BulkPlan[], confirm: () => Promise<boolean>, apply: (plan: BulkPlan) => Promise<BulkResult>): Promise<BulkResult[]> {
  if (!plans.length || !await confirm()) return [];
  const results: BulkResult[] = [];
  for (const plan of plans) {
    const result = await apply(plan);
    results.push(result);
    if (result.code !== 0) break;
  }
  return results;
}
export function decodeRemoteBulk(result: { code: number; text: string }, policy?: string): BulkResult[] {
  if (result.code !== 0) throw new Error(result.text || "remote bulk preview failed");
  const value: unknown = JSON.parse(result.text);
  if (!Array.isArray(value) || value.some(item => !item || typeof item.policy !== "string" || !Number.isInteger(item.code) || typeof item.output !== "string")) throw new Error("remote bulk preview must contain named policy plans");
  const results = value as BulkResult[];
  if (policy && (results.length !== 1 || results[0].policy !== policy)) throw new Error("remote bulk preview does not match the selected policy");
  for (const item of results) {
    if (typeof item.scope !== "string" || !item.scope || item.scope.length > 64 * 1024 || item.scopeFingerprint !== scopeFingerprint(item.scope)) throw new Error("remote preview is missing authoritative scope; update the installed reaper");
    if (item.scope !== results[0].scope) throw new Error("remote bulk preview contains inconsistent scopes");
  }
  prepareBulkPlans(results);
  return results;
}
