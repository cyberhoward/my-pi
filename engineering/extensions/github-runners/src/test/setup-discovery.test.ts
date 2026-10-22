import { expect, it, vi } from "vitest";
import { discoverCatalog, discoverRelease, quoteHcloud, validateGithubScope } from "../setup-discovery.js";

const json = (body: unknown, headers: HeadersInit = {}) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json", ...headers } });
const meta = (key: string, entries: unknown[]) => ({ [key]: entries, meta: { pagination: { next_page: null } } });
const rules = ["53", "53", "123", "80", "443"].map((port, index) => ({ direction: "out", protocol: index === 0 || index === 2 ? "udp" : "tcp", port, destination_ips: ["0.0.0.0/0", "::/0"] }));

it("discovers only active x86 choices and restrictive firewalls with GET requests", async () => {
  const fetcher = vi.fn((input: string | URL, init?: RequestInit) => {
    expect(init?.method).toBeUndefined();
    const url = String(input);
    if (url.includes("/locations")) return json(meta("locations", [{ name: "fsn1", description: "Falkenstein", deprecated: false, disabled: false }]));
    if (url.includes("/server_types")) return json(meta("server_types", [{ name: "cpx11", architecture: "x86", deprecated: false, cores: 2, memory: 4, disk: 80, prices: [{ location: "fsn1", price_hourly: { net: "0.01" } }] }, { name: "cax11", architecture: "arm", deprecated: false, cores: 2, memory: 4, disk: 80, prices: [] }]));
    if (url.includes("/images")) return json(meta("images", [{ name: "ubuntu-24.04", description: "Ubuntu", type: "system", architecture: "x86", status: "available", deprecated: null }]));
    return json(meta("firewalls", [{ id: 1, name: "safe", rules }, { id: 2, name: "open", rules: [{ direction: "in" }] }]));
  });
  await expect(discoverCatalog(fetcher, "secret")).resolves.toEqual({ locations: [{ name: "fsn1", description: "Falkenstein" }], serverTypes: [{ name: "cpx11", cores: 2, memoryGb: 4, diskGb: 80, locations: ["fsn1"] }], images: [{ name: "ubuntu-24.04", description: "Ubuntu" }], firewalls: [{ id: "1", name: "safe" }] });
});

it("only advertises bootstrap-supported system images", async () => {
  const fetcher = vi.fn((input: string | URL) => {
    const url = String(input);
    if (url.includes("/locations")) return json(meta("locations", []));
    if (url.includes("/server_types")) return json(meta("server_types", []));
    if (url.includes("/images")) return json(meta("images", [
      { name: "ubuntu-24.04", description: "supported", type: "system", architecture: "x86", status: "available", deprecated: null },
      { name: "fedora-42", description: "unsupported", type: "system", architecture: "x86", status: "available", deprecated: null },
      { name: "debian-12", description: "unsupported", type: "system", architecture: "x86", status: "available", deprecated: null },
    ]));
    return json(meta("firewalls", []));
  });
  await expect(discoverCatalog(fetcher, "secret")).resolves.toMatchObject({ images: [{ name: "ubuntu-24.04" }] });
});

it("rejects runner releases without the exact API SHA-256 digest", async () => {
  const fetcher = vi.fn().mockResolvedValue(json({ tag_name: "v2.1.0", draft: false, prerelease: false, assets: [{ name: "actions-runner-linux-x64-2.1.0.tar.gz", digest: "sha256:short", browser_download_url: "https://github.com/actions/runner/releases/download/v2.1.0/x" }] }));
  await expect(discoverRelease(fetcher)).rejects.toThrow("exact SHA-256");
});

it("requires exactly three numeric runner version components", async () => {
  const digest = `sha256:${"a".repeat(64)}`;
  for (const tag of ["v2.1", "v2.1.0.1", "vlatest"]) {
    const version = tag.slice(1);
    const fetcher = vi.fn().mockResolvedValue(json({ tag_name: tag, draft: false, prerelease: false, assets: [{ name: `actions-runner-linux-x64-${version}.tar.gz`, digest, browser_download_url: `https://github.com/actions/runner/releases/download/${tag}/actions-runner-linux-x64-${version}.tar.gz` }] }));
    await expect(discoverRelease(fetcher)).rejects.toThrow("stable actions/runner");
  }
});

it("requires the release asset URL to exactly bind the tag and filename", async () => {
  const digest = `sha256:${"a".repeat(64)}`;
  const release = (url: string) => vi.fn().mockResolvedValue(json({ tag_name: "v2.1.0", draft: false, prerelease: false, assets: [{ name: "actions-runner-linux-x64-2.1.0.tar.gz", digest, browser_download_url: url }] }));
  await expect(discoverRelease(release("https://github.com/actions/runner/releases/download/v2.1.0/actions-runner-linux-x64-2.1.0.tar.gz?redirect=1"))).rejects.toThrow("URL does not exactly match");
  await expect(discoverRelease(release("https://github.com/actions/runner/releases/download/v2.1.1/actions-runner-linux-x64-2.1.0.tar.gz"))).rejects.toThrow("URL does not exactly match");
  await expect(discoverRelease(release("https://github.com/actions/runner/releases/download/v2.1.0/actions-runner-linux-x64-2.1.0.tar.gz"))).resolves.toMatchObject({ version: "2.1.0" });
});

it("treats missing prices as unavailable and preserves IPv6-free pricing semantics", async () => {
  const fetcher = vi.fn((input: string | URL) => String(input).includes("server_types") ? json({ server_types: [{ name: "cpx11", architecture: "x86", deprecated: false, prices: [{ location: "fsn1", price_hourly: { net: "0.01" } }] }] }) : json({ pricing: { primary_ips: [{ type: "ipv4", prices: [{ location: "fsn1", price_hourly: { net: "0.002" } }] }] } }));
  await expect(quoteHcloud(fetcher, "secret", { serverType: "cpx11", location: "fsn1", ipv4: true, ipv6: true, quantity: 2, maximumLifetimeSeconds: 3600 })).resolves.toMatchObject({ perRunnerHourlyEur: 0.012, hourlyPoolEur: 0.024, maximumEligibilityEur: 0.024 });
  const missing = vi.fn((input: string | URL) => String(input).includes("server_types") ? json({ server_types: [{ name: "cpx11", architecture: "x86", deprecated: false, prices: [{ location: "fsn1", price_hourly: {} }] }] }) : json({ pricing: { primary_ips: [] } }));
  await expect(quoteHcloud(missing, "secret", { serverType: "cpx11", location: "fsn1", ipv4: false, ipv6: false, quantity: 1, maximumLifetimeSeconds: 900 })).rejects.toThrow("pricing is unavailable");
});

it("rejects invalid quote inputs and unavailable requested IP pricing", async () => {
  const fetcher = vi.fn((input: string | URL) => String(input).includes("server_types") ? json({ server_types: [{ name: "cpx11", architecture: "x86", deprecated: false, prices: [{ location: "fsn1", price_hourly: { net: "0.01" } }] }] }) : json({ pricing: { primary_ips: [] } }));
  await expect(quoteHcloud(fetcher, "secret", { serverType: "cpx11", location: "fsn1", ipv4: true, ipv6: false, quantity: 4, maximumLifetimeSeconds: 900 })).rejects.toThrow("quote input is invalid");
  await expect(quoteHcloud(fetcher, "secret", { serverType: "cpx11", location: "fsn1", ipv4: true, ipv6: false, quantity: 1, maximumLifetimeSeconds: 900 })).rejects.toThrow("ipv4 pricing is unavailable");
});

it("does not advertise inactive locations or malformed server capacity", async () => {
  const fetcher = vi.fn((input: string | URL) => {
    const url = String(input);
    if (url.includes("/locations")) return json(meta("locations", [{ name: "fsn1", description: "inactive", deprecated: { announced: "now" } }, { name: "nbg1", description: "active", deprecated: false, disabled: false }]));
    if (url.includes("/server_types")) return json(meta("server_types", [{ name: "cpx11", architecture: "x86", deprecated: false, cores: 0, memory: 4, disk: 80, prices: [{ location: "nbg1", price_hourly: { net: "0.01" } }] }, { name: "cx22", architecture: "x86", deprecated: false, cores: 2, memory: 4, disk: 20, prices: [{ location: "fsn1", price_hourly: { net: "0.01" } }] }]));
    if (url.includes("/images")) return json(meta("images", []));
    return json(meta("firewalls", []));
  });
  await expect(discoverCatalog(fetcher, "secret")).rejects.toThrow("capacity");
});

it("validates exact repository scope and refuses cross-origin pagination", async () => {
  const fetcher = vi.fn((input: string | URL) => {
    const url = String(input);
    if (url.endsWith("/repos/o/r")) return json({ full_name: "o/r" });
    if (url.includes("runner-groups/4?") || url.endsWith("runner-groups/4")) return json({ name: "selected", visibility: "selected" });
    return json({ repositories: [{ full_name: "o/r" }] }, { link: '<https://example.test/next>; rel="next"' });
  });
  await expect(validateGithubScope(fetcher, "secret", "o/r", { name: "o", repositories: ["o/r"], runnerGroupId: 4, runnerGroupName: "selected" })).rejects.toThrow("left the official API");
});
