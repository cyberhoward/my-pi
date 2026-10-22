import type { SetupCatalog, SetupRelease } from "../setup-types.js";
import { knownHourlyPrice, maximumEligibilityCost, poolHourlyCost, publicIpHourlyPrice } from "./hcloud-costs.js";
import { assertRestrictiveFirewall, isSupportedSystemImage } from "./hcloud-validation.js";
import { type FetchLike, requestJson } from "./http.js";
import { ProviderFailure, SafeRefusal } from "./types.js";

const hcloud = "https://api.hetzner.cloud/v1";
const github = "https://api.github.com";
const maxPages = 20;
type RecordValue = Record<string, unknown>;

function record(value: unknown, name: string): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProviderFailure(`malformed ${name}`);
  return value as RecordValue;
}
function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new ProviderFailure(`malformed ${name}`);
  return value;
}
function list(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new ProviderFailure(`malformed ${name}`);
  return value;
}
function page(value: unknown, key: string): { entries: unknown[]; next?: number } {
  const root = record(value, "Hetzner response");
  const entries = list(root[key], key);
  const pagination = record(record(root.meta, "Hetzner metadata").pagination, "Hetzner pagination");
  const next = pagination.next_page;
  if (next === null || next === undefined) return { entries };
  if (!Number.isInteger(next) || (next as number) < 1) throw new ProviderFailure("malformed Hetzner next_page");
  return { entries, next: next as number };
}
async function hcloudPages(fetcher: FetchLike, path: string, key: string, headers: HeadersInit): Promise<unknown[]> {
  const entries: unknown[] = [];
  let current: number | undefined = 1;
  for (let count = 0; current !== undefined && count < maxPages; count++) {
    const separator = path.includes("?") ? "&" : "?";
    const { data } = await requestJson(fetcher, `${hcloud}${path}${separator}per_page=50&page=${current}`, { headers });
    const parsed = page(data, key);
    entries.push(...parsed.entries);
    current = parsed.next;
  }
  if (current !== undefined) throw new ProviderFailure("Hetzner pagination exceeded safe page bound");
  return entries;
}
function hcloudHeaders(token: string): HeadersInit { return { authorization: `Bearer ${token}` }; }

export async function discoverCatalog(fetcher: FetchLike, token: string): Promise<SetupCatalog> {
  const headers = hcloudHeaders(token);
  const [locations, types, images, firewalls] = await Promise.all([
    hcloudPages(fetcher, "/locations", "locations", headers),
    hcloudPages(fetcher, "/server_types", "server_types", headers),
    hcloudPages(fetcher, "/images?type=system&architecture=x86", "images", headers),
    hcloudPages(fetcher, "/firewalls", "firewalls", headers),
  ]);
  const activeLocations = new Set(locations.flatMap((item) => {
    const value = record(item, "Hetzner location");
    if (value.deprecated || value.disabled) return [];
    return [text(value.name, "Hetzner location name")];
  }));
  return {
    locations: locations.flatMap((item) => { const value = record(item, "Hetzner location"); if (value.deprecated || value.disabled) return []; return [{ name: text(value.name, "Hetzner location name"), description: text(value.description, "Hetzner location description") }]; }),
    serverTypes: types.flatMap((item) => {
      const value = record(item, "Hetzner server type");
      const name = text(value.name, "Hetzner server type name");
      if (!/^(cx|cpx|ccx)\d+$/.test(name) || value.architecture !== "x86" || value.deprecated) return [];
      const locations = [...new Set(list(value.prices, "Hetzner server type prices").flatMap((price) => { const entry = record(price, "Hetzner server type price"); if (typeof entry.location !== "string") throw new ProviderFailure("malformed Hetzner server type price location"); knownHourlyPrice(record(entry.price_hourly, "Hetzner server hourly price").net, "server hourly"); return activeLocations.has(entry.location) ? [entry.location] : []; }))];
      if (!locations.length) return [];
      const cores = value.cores; const memory = value.memory; const disk = value.disk;
      if (typeof cores !== "number" || typeof memory !== "number" || typeof disk !== "number" || !Number.isFinite(cores) || !Number.isFinite(memory) || !Number.isFinite(disk) || cores <= 0 || memory <= 0 || disk <= 0) throw new ProviderFailure("malformed Hetzner server type capacity");
      return [{ name, cores, memoryGb: memory, diskGb: disk, locations }];
    }),
    images: images.flatMap((item) => { const value = record(item, "Hetzner image"); const name = text(value.name, "Hetzner image name"); if (value.type !== "system" || value.architecture !== "x86" || value.status !== "available" || value.deprecated !== null || !isSupportedSystemImage(name)) return []; return [{ name, description: text(value.description, "Hetzner image description") }]; }),
    firewalls: firewalls.flatMap((item) => { const value = record(item, "Hetzner firewall"); try { assertRestrictiveFirewall(value.rules); } catch (error) { if (error instanceof SafeRefusal) return []; throw error; } const id = value.id; if ((typeof id !== "string" && typeof id !== "number") || !/^\d+$/.test(String(id))) throw new ProviderFailure("malformed Hetzner firewall id"); return [{ id: String(id), name: text(value.name, "Hetzner firewall name") }]; }),
  };
}

export async function discoverRelease(fetcher: FetchLike): Promise<SetupRelease> {
  const { data } = await requestJson(fetcher, `${github}/repos/actions/runner/releases/latest`, { headers: { accept: "application/vnd.github+json" } });
  const release = record(data, "GitHub runner release");
  const tag = text(release.tag_name, "GitHub runner release tag");
  const version = /^v(\d+\.\d+\.\d+)$/.exec(tag)?.[1];
  if (!version || typeof release.draft !== "boolean" || typeof release.prerelease !== "boolean" || release.draft || release.prerelease) throw new SafeRefusal("official stable actions/runner Linux x64 release is unavailable");
  const expected = `actions-runner-linux-x64-${version}.tar.gz`;
  const assets = list(release.assets, "GitHub runner release assets").filter((asset) => record(asset, "GitHub runner asset").name === expected);
  if (assets.length !== 1) throw new SafeRefusal("official stable actions/runner Linux x64 asset is unavailable");
  const asset = record(assets[0], "GitHub runner asset");
  if (typeof asset.digest !== "string" || !asset.digest) throw new SafeRefusal("official runner asset lacks a SHA-256 digest; manually pin a verified release before activation");
  const match = /^sha256:([a-f0-9]{64})$/i.exec(asset.digest);
  const url = text(asset.browser_download_url, "GitHub runner asset URL");
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new SafeRefusal("official runner asset URL is unavailable"); }
  if (!match) throw new SafeRefusal("official runner asset requires an exact SHA-256 digest");
  if (parsed.origin !== "https://github.com" || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== `/actions/runner/releases/download/${tag}/${expected}`) throw new SafeRefusal("official runner asset URL does not exactly match the stable release asset");
  return { version, sha256: match[1].toLowerCase(), url };
}

export async function quoteHcloud(fetcher: FetchLike, token: string, input: { serverType: string; location: string; ipv4: boolean; ipv6: boolean; quantity: number; maximumLifetimeSeconds: number }): Promise<{ perRunnerHourlyEur: number; hourlyPoolEur: number; maximumEligibilityEur: number }> {
  if (!/^(cx|cpx|ccx)\d+$/.test(input.serverType) || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(input.location) || typeof input.ipv4 !== "boolean" || typeof input.ipv6 !== "boolean" || !Number.isInteger(input.quantity) || input.quantity < 0 || input.quantity > 3 || !Number.isFinite(input.maximumLifetimeSeconds) || input.maximumLifetimeSeconds < 900 || input.maximumLifetimeSeconds > 86400) throw new SafeRefusal("quote input is invalid");
  const headers = hcloudHeaders(token);
  const [typeResponse, pricingResponse] = await Promise.all([
    requestJson(fetcher, `${hcloud}/server_types?name=${encodeURIComponent(input.serverType)}`, { headers }),
    requestJson(fetcher, `${hcloud}/pricing`, { headers }),
  ]);
  const types = list(record(typeResponse.data, "Hetzner server type response").server_types, "Hetzner server types");
  if (types.length !== 1) throw new SafeRefusal("selected server type is unavailable");
  const type = record(types[0], "Hetzner server type");
  if (type.name !== input.serverType || type.architecture !== "x86" || type.deprecated === true) throw new SafeRefusal("selected server type is unavailable");
  const price = list(type.prices, "Hetzner server type prices").map((entry) => record(entry, "Hetzner server type price")).find((entry) => entry.location === input.location);
  if (!price) throw new SafeRefusal("selected server type is unavailable in selected location");
  const server = knownHourlyPrice(record(price.price_hourly, "Hetzner server hourly price").net, "server hourly");
  const primary = record(record(pricingResponse.data, "Hetzner pricing response").pricing, "Hetzner pricing").primary_ips;
  const ipv4 = publicIpHourlyPrice(primary, input.location, "ipv4", input.ipv4);
  const ipv6 = publicIpHourlyPrice(primary, input.location, "ipv6", input.ipv6);
  const perRunnerHourlyEur = server + ipv4 + ipv6;
  const hourlyPoolEur = poolHourlyCost(server, ipv4, ipv6, input.quantity);
  return { perRunnerHourlyEur, hourlyPoolEur, maximumEligibilityEur: maximumEligibilityCost(hourlyPoolEur, input.maximumLifetimeSeconds) };
}

export async function validateGithubScope(fetcher: FetchLike, token: string, repository: string, organization?: { name: string; repositories: string[]; runnerGroupId: number; runnerGroupName: string }): Promise<void> {
  const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" };
  const { data } = await requestJson(fetcher, `${github}/repos/${repository}`, { headers });
  const fullName = text(record(data, "GitHub repository").full_name, "GitHub repository full name");
  if (fullName.toLowerCase() !== repository.toLowerCase()) throw new SafeRefusal("GitHub access does not match the active repository");
  if (!organization) return;
  const base = `${github}/orgs/${encodeURIComponent(organization.name)}/actions/runner-groups/${organization.runnerGroupId}`;
  const group = record((await requestJson(fetcher, base, { headers })).data, "GitHub runner group");
  if (group.name !== organization.runnerGroupName || group.visibility !== "selected") throw new SafeRefusal("configured organization runner group is not the selected named group");
  const repositories: string[] = []; let url: string | undefined = `${base}/repositories?per_page=100`;
  for (let count = 0; url && count < maxPages; count++) { const result = await requestJson(fetcher, url, { headers }); const entries = list(record(result.data, "GitHub runner group repositories").repositories, "GitHub runner group repositories"); repositories.push(...entries.map((entry) => text(record(entry, "GitHub runner group repository").full_name, "GitHub runner group repository name").toLowerCase())); const next = result.response.headers.get("link")?.match(/<([^>]+)>;\s*rel="next"/)?.[1]; if (next) { const parsed = new URL(next); if (parsed.origin !== github) throw new ProviderFailure("GitHub pagination left the official API"); url = parsed.toString(); } else url = undefined; }
  if (url) throw new ProviderFailure("GitHub pagination exceeded safe page bound");
  const expected = [...organization.repositories].map((value) => value.toLowerCase()).sort(); const actual = repositories.sort();
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) throw new SafeRefusal("organization runner group repository access does not exactly match configured allowlist");
}
