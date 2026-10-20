import { expect, it, vi } from "vitest";
import { parseConfig } from "../config.js";
import { HCloudClient } from "../hcloud.js";
import { Secret } from "../types.js";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
const config = parseConfig({
  repository: "r/o",
  pool: {
    name: "p",
    routingLabels: ["r"],
    maxSize: 1,
    scaleUpDelaySeconds: 45,
    idleGraceSeconds: 1,
    bootstrapGraceSeconds: 1,
    drainQuiescenceSeconds: 65,
    drainProbeSeconds: 1,
    maximumLifetimeSeconds: 3600,
    maxKnownHourlyPoolCostEur: 1,
    maxKnownEligibilityCostEur: 1,
  },
  hcloud: {
    serverType: "cpx11",
    location: "fsn1",
    image: "ubuntu-24.04",
    firewallId: "1",
    publicNet: { ipv4: true, ipv6: true },
  },
  coordination: { lockPath: "/tmp/x" },
  runner: {},
});
config.tier = {
  id: "cpx-shared-x86",
  family: "CPX",
  architecture: "x86",
  serverTypes: ["cpx11"],
  sources: ["https://www.hetzner.com/cloud/regular-performance"],
};
it("uses bounded Hetzner meta pagination", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(
      json({ servers: [], meta: { pagination: { next_page: 2 } } }),
    )
    .mockResolvedValueOnce(
      json({ servers: [], meta: { pagination: { next_page: null } } }),
    );
  await new HCloudClient(fetcher, new Secret("token")).listOwned("owned=true");
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(String(fetcher.mock.calls[1][0])).toContain("page=2");
});
it("preflights firewall, x86 availability, ancillary IP cost, and exclusions", async () => {
  const fetcher = vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url.includes("/firewalls/"))
      return json({
        firewall: {
          id: 1,
          rules: [
            ["udp", "53"],
            ["tcp", "53"],
            ["udp", "123"],
            ["tcp", "80"],
            ["tcp", "443"],
          ].map(([protocol, port]) => ({
            direction: "out",
            protocol,
            port,
            destination_ips: ["0.0.0.0/0", "::/0"],
          })),
        },
      });
    if (url.includes("/server_types?"))
      return json({
        server_types: [
          {
            name: "cpx11",
            architecture: "x86",
            prices: [{ location: "fsn1", price_hourly: { net: "0.01" } }],
          },
        ],
      });
    if (url.includes("/images?")) {
      expect(url).toContain("name=ubuntu-24.04");
      expect(url).toContain("architecture=x86");
      expect(url).toContain("type=system");
      return json({
        images: [
          {
            name: "ubuntu-24.04",
            status: "available",
            architecture: "x86",
            deprecated: null,
          },
        ],
      });
    }
    if (url.includes("/locations?"))
      return json({ locations: [{ name: "fsn1" }] });
    if (url.endsWith("/pricing"))
      return json({
        pricing: {
          primary_ips: [
            {
              type: "ipv4",
              prices: [{ location: "fsn1", price_hourly: { net: "0.001" } }],
            },
          ],
        },
      });
    throw new Error(url);
  });
  await expect(
    new HCloudClient(fetcher, new Secret("token")).preflight(config),
  ).resolves.toEqual({
    tierId: "cpx-shared-x86",
    family: "CPX",
    serverType: "cpx11",
    location: "fsn1",
    expectedArchitecture: "x86",
    observedArchitecture: "x86",
    hourlyPoolEur: 0.011,
    maximumEligibilityEur: 0.011,
    excludes: ["VAT", "variable traffic"],
    sources: ["https://www.hetzner.com/cloud/regular-performance"],
  });
});
it("rejects inbound firewall rules", async () => {
  const fetcher = vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url.includes("/firewalls/"))
      return json({ firewall: { id: 1, rules: [{ direction: "in" }] } });
    if (url.includes("/server_types?"))
      return json({
        server_types: [{ name: "cpx11", architecture: "x86", prices: [] }],
      });
    if (url.includes("/images?"))
      return json({
        images: [
          {
            name: "ubuntu-24.04",
            status: "available",
            architecture: "x86",
            deprecated: null,
          },
        ],
      });
    if (url.includes("/locations?"))
      return json({ locations: [{ name: "fsn1" }] });
    return json({ pricing: { primary_ips: {} } });
  });
  await expect(
    new HCloudClient(fetcher, new Secret("token")).preflight(config),
  ).rejects.toThrow("deny all inbound");
});
it("rejects wrong-protocol or IPv4-only egress", async () => {
  const fetcher = vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url.includes("/firewalls/"))
      return json({
        firewall: {
          id: 1,
          rules: [
            {
              direction: "out",
              protocol: "tcp",
              port: "53",
              destination_ips: ["0.0.0.0/0"],
            },
          ],
        },
      });
    if (url.includes("/server_types?"))
      return json({
        server_types: [{ name: "cpx11", architecture: "x86", prices: [] }],
      });
    if (url.includes("/images?"))
      return json({
        images: [
          {
            name: "ubuntu-24.04",
            status: "available",
            architecture: "x86",
            deprecated: null,
          },
        ],
      });
    if (url.includes("/locations?"))
      return json({ locations: [{ name: "fsn1" }] });
    return json({ pricing: { primary_ips: [] } });
  });
  await expect(
    new HCloudClient(fetcher, new Secret("token")).preflight(config),
  ).rejects.toThrow("IPv4/IPv6 egress");
});
it("does not retry ambiguous creates and preserves terminal action failures", async () => {
  const input = {
    name: "server",
    labels: {},
    userData: new Secret("cloud"),
    serverType: "cpx",
    location: "fsn1",
    image: "ubuntu",
    firewallId: "1",
    sshKeyIds: [],
    publicNet: { ipv4: true, ipv6: true },
  };
  const ambiguous = vi.fn().mockRejectedValue(new TypeError("timeout"));
  await expect(
    new HCloudClient(ambiguous, new Secret("token")).createServer(input),
  ).rejects.toThrow("ambiguous create");
  expect(ambiguous).toHaveBeenCalledTimes(1);
  const terminal = vi
    .fn()
    .mockResolvedValue(
      json({ server: { id: 1 }, action: { id: 2, status: "error" } }),
    );
  await expect(
    new HCloudClient(terminal, new Secret("token")).createServer(input),
  ).rejects.toThrow("action 2 failed");
});
it("rejects deprecated provisioning resources and extra egress", async () => {
  const approved = [
    ["udp", "53"],
    ["tcp", "53"],
    ["udp", "123"],
    ["tcp", "80"],
    ["tcp", "443"],
  ].map(([protocol, port]) => ({
    direction: "out",
    protocol,
    port,
    destination_ips: ["0.0.0.0/0", "::/0"],
  }));
  const fetcher = vi.fn(async (input: string | URL) => {
    const url = String(input);
    if (url.includes("/firewalls/"))
      return json({
        firewall: {
          id: 1,
          rules: [
            ...approved,
            {
              direction: "out",
              protocol: "tcp",
              port: "22",
              destination_ips: ["0.0.0.0/0", "::/0"],
            },
          ],
        },
      });
    if (url.includes("/server_types?"))
      return json({
        server_types: [
          {
            name: "cpx11",
            architecture: "x86",
            deprecated: true,
            prices: [],
          },
        ],
      });
    if (url.includes("/images?"))
      return json({
        images: [
          {
            name: "ubuntu-24.04",
            status: "available",
            architecture: "x86",
            deprecated: null,
          },
        ],
      });
    if (url.includes("/locations?"))
      return json({ locations: [{ name: "fsn1" }] });
    return json({ pricing: { primary_ips: [] } });
  });
  await expect(
    new HCloudClient(fetcher, new Secret("token")).preflight(config),
  ).rejects.toThrow("unapproved outbound");
});
it("rejects malformed provider IDs before using them", async () => {
  const fetcher = vi.fn().mockResolvedValue(
    json({
      server: {
        name: "x",
        created: "2026-01-01T00:00:00Z",
        status: "running",
        labels: {},
        protection: {},
      },
    }),
  );
  await expect(
    new HCloudClient(fetcher, new Secret("token")).getServer("1"),
  ).rejects.toThrow("server id");
});
it("rejects malformed provider creation timestamps", async () => {
  const fetcher = vi.fn().mockResolvedValue(
    json({
      server: {
        id: 1,
        name: "x",
        created: "not-a-date",
        status: "running",
        labels: {},
        protection: {},
      },
    }),
  );
  await expect(
    new HCloudClient(fetcher, new Secret("token")).getServer("1"),
  ).rejects.toThrow("created timestamp");
});
it("re-observes synchronous server label updates instead of polling an action", async () => {
  const labels = { "tau-state": "draining" };
  const fetcher = vi.fn(async (_input: string | URL, init?: RequestInit) => {
    if (init?.method === "PUT") return json({ server: { id: 1, labels } });
    return json({
      server: {
        id: 1,
        name: "server",
        created: "2026-01-01T00:00:00Z",
        status: "running",
        labels,
        protection: { delete: true, rebuild: true },
      },
    });
  });
  await expect(
    new HCloudClient(fetcher, new Secret("token")).updateLabels("1", labels),
  ).resolves.toBeUndefined();
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[0][1]?.method).toBe("PUT");
  expect(fetcher.mock.calls[1][1]?.method).toBeUndefined();
});

function exactPreflightFetcher(patch: Record<string, unknown> = {}) {
  const approved = [
    ["udp", "53"],
    ["tcp", "53"],
    ["udp", "123"],
    ["tcp", "80"],
    ["tcp", "443"],
  ].map(([protocol, port]) => ({
    direction: "out",
    protocol,
    port,
    destination_ips: ["0.0.0.0/0", "::/0"],
  }));
  const bodies: Record<string, any> = {
    firewall: { firewall: { id: 1, rules: approved } },
    server_type: {
      server_types: [
        {
          name: "cpx11",
          architecture: "x86",
          deprecated: false,
          prices: [{ location: "fsn1", price_hourly: { net: "0.01" } }],
        },
      ],
    },
    image: {
      images: [
        {
          name: "ubuntu-24.04",
          status: "available",
          architecture: "x86",
          deprecated: null,
        },
      ],
    },
    location: {
      locations: [{ name: "fsn1", deprecated: false, disabled: false }],
    },
    pricing: {
      pricing: {
        primary_ips: [
          {
            type: "ipv4",
            prices: [{ location: "fsn1", price_hourly: { net: "0.001" } }],
          },
          {
            type: "ipv6",
            prices: [{ location: "fsn1", price_hourly: { net: "0" } }],
          },
        ],
      },
    },
    ...patch,
  };
  return vi.fn(async (input: string | URL, init?: RequestInit) => {
    expect(init?.method ?? "GET").toBe("GET");
    const url = String(input);
    const key = url.includes("/firewalls/")
      ? "firewall"
      : url.includes("/server_types?")
        ? "server_type"
        : url.includes("/images?")
          ? "image"
          : url.includes("/locations?")
            ? "location"
            : "pricing";
    return json(bodies[key]);
  });
}
it("refuses image lookup unless it resolves exactly one system image", async () => {
  await expect(
    new HCloudClient(
      exactPreflightFetcher({ image: { images: [] } }),
      new Secret("token"),
    ).preflight(config),
  ).rejects.toThrow("exactly one system image");
});
it.each([
  [
    "server type identity",
    {
      server_type: {
        server_types: [{ name: "cpx12", architecture: "x86", prices: [] }],
      },
    },
    "identity",
  ],
  [
    "provider architecture",
    {
      server_type: {
        server_types: [{ name: "cpx11", architecture: "arm", prices: [] }],
      },
    },
    "architecture",
  ],
  [
    "image architecture",
    {
      image: {
        images: [
          {
            name: "ubuntu-24.04",
            status: "available",
            architecture: "arm",
            deprecated: null,
          },
        ],
      },
    },
    "image must",
  ],
  [
    "location identity",
    { location: { locations: [{ name: "hel1" }] } },
    "location",
  ],
  [
    "firewall identity",
    { firewall: { firewall: { id: 2, rules: [] } } },
    "firewall identity",
  ],
  [
    "selected-location availability",
    {
      server_type: {
        server_types: [{ name: "cpx11", architecture: "x86", prices: [] }],
      },
    },
    "unavailable",
  ],
  [
    "malformed server pricing",
    {
      server_type: {
        server_types: [
          {
            name: "cpx11",
            architecture: "x86",
            prices: [{ location: "fsn1", price_hourly: { net: "NaN" } }],
          },
        ],
      },
    },
    "pricing",
  ],
])("rejects exact preflight %s mismatch with read-only calls", async (_name, patch, message) => {
  const fetcher = exactPreflightFetcher(patch);
  await expect(
    new HCloudClient(fetcher, new Secret("token")).preflight(config),
  ).rejects.toThrow(message);
  expect(fetcher).toHaveBeenCalled();
});
