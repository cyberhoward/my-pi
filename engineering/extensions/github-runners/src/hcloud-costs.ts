import { SafeRefusal } from "./types.js";

export function knownHourlyPrice(value: unknown, name: string): number {
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value))
    throw new SafeRefusal(`provider ${name} pricing is unavailable`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0)
    throw new SafeRefusal(`provider ${name} pricing is unavailable`);
  return parsed;
}

export function publicIpHourlyPrice(
  primaryIps: unknown,
  location: string,
  kind: "ipv4" | "ipv6",
  enabled: boolean,
): number {
  if (!enabled) return 0;
  if (!Array.isArray(primaryIps)) throw new SafeRefusal("provider primary IP pricing is unavailable");
  const entries = primaryIps.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry));
  if (entries.length !== primaryIps.length) throw new SafeRefusal("provider primary IP pricing is unavailable");
  const entry = entries.find((value) => value.type === kind);
  if (!entry && kind === "ipv6") return 0;
  if (!entry) throw new SafeRefusal(`provider ${kind} pricing is unavailable`);
  if (!Array.isArray(entry.prices)) throw new SafeRefusal(`provider ${kind} pricing is unavailable`);
  const price = entry.prices.find((value): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value) && value.location === location);
  if (!price) throw new SafeRefusal(`provider ${kind} price unavailable in selected location`);
  const hourly = price.price_hourly;
  if (!hourly || typeof hourly !== "object" || Array.isArray(hourly)) throw new SafeRefusal(`provider ${kind} pricing is unavailable`);
  return knownHourlyPrice((hourly as Record<string, unknown>).net, `${kind} hourly`);
}

export function poolHourlyCost(
  serverHourly: number,
  ipv4Hourly: number,
  ipv6Hourly: number,
  size: number,
): number {
  return (serverHourly + ipv4Hourly + ipv6Hourly) * size;
}

export function maximumEligibilityCost(
  hourlyPoolEur: number,
  maximumLifetimeSeconds: number,
): number {
  return hourlyPoolEur * (maximumLifetimeSeconds / 3600);
}
