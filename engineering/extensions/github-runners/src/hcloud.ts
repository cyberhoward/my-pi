import { type FetchLike, requestJson } from "./http.js";
import type { CreateServerInput, HCloudPort, KnownCost } from "./ports.js";
import {
  type CloudServer,
  ProviderFailure,
  type RunnerManagerConfig,
  SafeRefusal,
  type Secret,
} from "./types.js";

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ProviderFailure(`malformed Hetzner ${name}`);
  return value as Record<string, unknown>;
}
function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value))
    throw new ProviderFailure(`malformed Hetzner ${name}`);
  return value;
}
function providerId(value: unknown, name: string): string {
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    !/^\d+$/.test(String(value))
  )
    throw new ProviderFailure(`malformed Hetzner ${name}`);
  return String(value);
}
function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value)
    throw new ProviderFailure(`malformed Hetzner ${name}`);
  return value;
}
function knownPrice(value: unknown, name: string): number {
  if (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value))
    throw new SafeRefusal(`provider ${name} pricing is unavailable`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0)
    throw new SafeRefusal(`provider ${name} pricing is unavailable`);
  return parsed;
}

export class HCloudClient implements HCloudPort {
  readonly #headers: HeadersInit;
  constructor(
    private readonly fetcher: FetchLike,
    credential: Secret<string>,
    private readonly baseUrl = "https://api.hetzner.cloud/v1",
  ) {
    this.#headers = {
      authorization: `Bearer ${credential.reveal()}`,
      "content-type": "application/json",
    };
  }
  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }
  private server(value: unknown): CloudServer {
    const v = object(value, "server");
    const protection = object(v.protection ?? {}, "server protection");
    const labels = object(v.labels ?? {}, "server labels");
    if (Object.values(labels).some((entry) => typeof entry !== "string"))
      throw new ProviderFailure("malformed Hetzner server labels");
    const createdAt = text(v.created, "server created");
    if (!Number.isFinite(Date.parse(createdAt)))
      throw new ProviderFailure("malformed Hetzner server created timestamp");
    return {
      id: providerId(v.id, "server id"),
      name: text(v.name, "server name"),
      createdAt,
      status: text(v.status, "server status"),
      labels: labels as Record<string, string>,
      protected: protection.delete === true,
      rebuildProtected: protection.rebuild === true,
    };
  }
  async listOwned(selector: string): Promise<CloudServer[]> {
    const result: CloudServer[] = [];
    let page: number | undefined = 1;
    for (let count = 0; page !== undefined && count < 20; count++) {
      const { data } = await requestJson(
        this.fetcher,
        this.url(
          `/servers?label_selector=${encodeURIComponent(selector)}&per_page=50&page=${page}`,
        ),
        { headers: this.#headers },
      );
      const root = object(data, "server list");
      result.push(...array(root.servers, "servers").map((v) => this.server(v)));
      const pagination = object(
        object(root.meta, "server list meta").pagination,
        "server pagination",
      );
      const next = pagination.next_page;
      if (next === null || next === undefined) page = undefined;
      else if (typeof next === "number" && Number.isInteger(next) && next > 0)
        page = next;
      else throw new ProviderFailure("malformed Hetzner next_page");
    }
    if (page !== undefined)
      throw new ProviderFailure("Hetzner pagination exceeded safe page bound");
    return result;
  }
  async getServer(id: string): Promise<CloudServer | undefined> {
    const { data } = await requestJson(
      this.fetcher,
      this.url(`/servers/${id}`),
      {
        headers: this.#headers,
      },
    );
    return data
      ? this.server(object(data, "server response").server)
      : undefined;
  }
  private async get(
    path: string,
    key: string,
  ): Promise<Record<string, unknown>> {
    const { data } = await requestJson(this.fetcher, this.url(path), {
      headers: this.#headers,
    });
    return object(object(data, `${key} response`)[key], key);
  }
  private async getImage(
    name: string,
    architecture: string,
  ): Promise<Record<string, unknown>> {
    const query = new URLSearchParams({ name, architecture, type: "system" });
    const { data } = await requestJson(
      this.fetcher,
      this.url(`/images?${query.toString()}`),
      { headers: this.#headers },
    );
    const images = array(object(data, "image list").images, "images");
    if (images.length !== 1)
      throw new SafeRefusal(
        "image lookup must resolve exactly one system image",
      );
    return object(images[0], "image");
  }
  private async getLocation(name: string): Promise<Record<string, unknown>> {
    const query = new URLSearchParams({ name });
    const { data } = await requestJson(
      this.fetcher,
      this.url(`/locations?${query.toString()}`),
      { headers: this.#headers },
    );
    const locations = array(
      object(data, "location list").locations,
      "locations",
    );
    if (locations.length !== 1)
      throw new SafeRefusal(
        "location lookup must resolve exactly one location",
      );
    return object(locations[0], "location");
  }
  private async getServerType(name: string): Promise<Record<string, unknown>> {
    const query = new URLSearchParams({ name });
    const { data } = await requestJson(
      this.fetcher,
      this.url(`/server_types?${query.toString()}`),
      { headers: this.#headers },
    );
    const serverTypes = array(
      object(data, "server type list").server_types,
      "server types",
    );
    if (serverTypes.length !== 1)
      throw new SafeRefusal(
        "server type lookup must resolve exactly one server type",
      );
    return object(serverTypes[0], "server type");
  }
  async preflight(config: RunnerManagerConfig): Promise<KnownCost> {
    const [firewall, serverType, image, location, pricingRoot] =
      await Promise.all([
        this.get(`/firewalls/${config.hcloud.firewallId}`, "firewall"),
        this.getServerType(config.hcloud.serverType),
        this.getImage(config.hcloud.image, config.tier.architecture),
        this.getLocation(config.hcloud.location),
        requestJson(this.fetcher, this.url("/pricing"), {
          headers: this.#headers,
        }).then(({ data }) =>
          object(object(data, "pricing response").pricing, "pricing"),
        ),
      ]);
    if (providerId(firewall.id, "firewall id") !== config.hcloud.firewallId)
      throw new SafeRefusal("firewall identity mismatched");
    if (text(serverType.name, "server type name") !== config.hcloud.serverType)
      throw new SafeRefusal("server type identity mismatched");
    if (
      !config.tier.serverTypes.includes(config.hcloud.serverType) ||
      !config.hcloud.serverType.startsWith(config.tier.family.toLowerCase())
    )
      throw new SafeRefusal("server type is outside selected tier allowlist");
    const observedArchitecture = text(
      serverType.architecture,
      "server type architecture",
    );
    if (
      config.tier.architecture !== "x86" ||
      observedArchitecture !== "x86" ||
      observedArchitecture !== config.tier.architecture
    )
      throw new SafeRefusal(
        "server type architecture mismatched selected tier",
      );
    if (text(image.name, "image name") !== config.hcloud.image)
      throw new SafeRefusal("image identity mismatched");
    const rules = array(firewall.rules, "firewall rules").map((v) =>
      object(v, "firewall rule"),
    );
    if (rules.some((rule) => rule.direction === "in"))
      throw new SafeRefusal("firewall must deny all inbound traffic");
    const required = [
      { protocol: "udp", port: "53" },
      { protocol: "tcp", port: "53" },
      { protocol: "udp", port: "123" },
      { protocol: "tcp", port: "80" },
      { protocol: "tcp", port: "443" },
    ];
    for (const rule of rules) {
      if (rule.direction !== "out") continue;
      const approved = required.some(
        (expected) =>
          rule.protocol === expected.protocol &&
          String(rule.port ?? "") === expected.port,
      );
      if (!approved)
        throw new SafeRefusal("firewall contains unapproved outbound egress");
    }
    for (const expected of required) {
      const allowed = rules.some((rule) => {
        if (
          rule.direction !== "out" ||
          rule.protocol !== expected.protocol ||
          String(rule.port ?? "") !== expected.port
        )
          return false;
        const destinations = array(
          rule.destination_ips,
          "firewall destination_ips",
        );
        return (
          destinations.includes("0.0.0.0/0") && destinations.includes("::/0")
        );
      });
      if (!allowed)
        throw new SafeRefusal(
          `firewall missing ${expected.protocol}/${expected.port} IPv4/IPv6 egress`,
        );
    }
    if (
      image.status !== "available" ||
      image.architecture !== observedArchitecture ||
      image.deprecated !== null
    )
      throw new SafeRefusal(
        "image must be active, nondeprecated, available x86",
      );
    if (serverType.deprecated === true)
      throw new SafeRefusal("server type must be active and nondeprecated");
    if (
      location.name !== config.hcloud.location ||
      location.deprecated === true ||
      location.disabled === true
    )
      throw new SafeRefusal("location is inactive or identity mismatched");
    const prices = array(serverType.prices, "server type prices").map((v) =>
      object(v, "server type price"),
    );
    const selected = prices.find((v) => v.location === config.hcloud.location);
    if (!selected)
      throw new SafeRefusal("server type unavailable in selected location");
    const serverHourly = knownPrice(
      object(selected.price_hourly, "hourly price").net,
      "server hourly",
    );
    const primaryTypes = array(
      pricingRoot.primary_ips,
      "primary IP pricing",
    ).map((value) => object(value, "primary IP type"));
    const primaryPrice = (type: "ipv4" | "ipv6"): number => {
      const entry = primaryTypes.find((value) => value.type === type);
      if (!entry && type === "ipv6") return 0;
      if (!entry)
        throw new SafeRefusal(`provider ${type} pricing is unavailable`);
      const locationPrice = array(entry.prices, `${type} prices`)
        .map((value) => object(value, `${type} price`))
        .find((value) => value.location === config.hcloud.location);
      if (!locationPrice)
        throw new SafeRefusal(
          `provider ${type} price unavailable in selected location`,
        );
      return knownPrice(
        object(locationPrice.price_hourly, `${type} hourly price`).net,
        `${type} hourly`,
      );
    };
    const ipv4 = config.hcloud.publicNet.ipv4 ? primaryPrice("ipv4") : 0;
    const ipv6 = config.hcloud.publicNet.ipv6 ? primaryPrice("ipv6") : 0;
    const hourlyPoolEur = (serverHourly + ipv4 + ipv6) * config.pool.maxSize;
    const maximumEligibilityEur =
      hourlyPoolEur * (config.pool.maximumLifetimeSeconds / 3600);
    if (hourlyPoolEur > config.pool.maxKnownHourlyPoolCostEur)
      throw new SafeRefusal("known hourly pool cost exceeds configured cap");
    if (maximumEligibilityEur > config.pool.maxKnownEligibilityCostEur)
      throw new SafeRefusal(
        "known maximum eligibility cost exceeds configured cap",
      );
    return {
      tierId: config.tier.id,
      family: config.tier.family,
      serverType: config.hcloud.serverType,
      location: config.hcloud.location,
      expectedArchitecture: config.tier.architecture,
      observedArchitecture,
      hourlyPoolEur,
      maximumEligibilityEur,
      excludes: ["VAT", "variable traffic"],
      sources: config.tier.sources,
    };
  }
  private async waitForAction(data: unknown): Promise<void> {
    const action = object(object(data, "action response").action, "action");
    const id = providerId(action.id, "action id");
    for (let probe = 0; probe < 30; probe++) {
      const current =
        probe === 0 ? action : await this.get(`/actions/${id}`, "action");
      if (current.status === "success") return;
      if (current.status === "error")
        throw new ProviderFailure(`Hetzner action ${id} failed`);
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(250 * 2 ** probe, 2000)),
      );
    }
    throw new ProviderFailure(`Hetzner action ${id} timed out`);
  }
  async createServer(input: CreateServerInput): Promise<{ id: string }> {
    const body = {
      name: input.name,
      labels: input.labels,
      user_data: input.userData.reveal(),
      server_type: input.serverType,
      location: input.location,
      image: input.image,
      firewalls: [{ firewall: input.firewallId }],
      networks: input.networkId ? [input.networkId] : [],
      ssh_keys: input.sshKeyIds,
      public_net: {
        enable_ipv4: input.publicNet.ipv4,
        enable_ipv6: input.publicNet.ipv6,
      },
    };
    try {
      const result = await requestJson(this.fetcher, this.url("/servers"), {
        method: "POST",
        headers: this.#headers,
        body: JSON.stringify(body),
      });
      await this.waitForAction(result.data);
      return {
        id: providerId(
          object(
            object(result.data, "create response").server,
            "created server",
          ).id,
          "created server id",
        ),
      };
    } catch (error) {
      if (
        error instanceof ProviderFailure &&
        error.message.startsWith("Hetzner action")
      )
        throw error;
      throw new ProviderFailure(
        "ambiguous create; re-observe deterministic name",
      );
    }
  }
  async updateLabels(
    id: string,
    labels: Record<string, string>,
  ): Promise<void> {
    await requestJson(this.fetcher, this.url(`/servers/${id}`), {
      method: "PUT",
      headers: this.#headers,
      body: JSON.stringify({ labels }),
    });
    const observed = await this.getServer(id);
    const expectedEntries = Object.entries(labels).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    const observedEntries = Object.entries(observed?.labels ?? {}).sort(
      ([a], [b]) => a.localeCompare(b),
    );
    if (JSON.stringify(observedEntries) !== JSON.stringify(expectedEntries))
      throw new ProviderFailure("Hetzner label update was not observed");
  }
  async setProtections(
    id: string,
    input: { delete: boolean; rebuild: boolean },
  ): Promise<void> {
    const { data } = await requestJson(
      this.fetcher,
      this.url(`/servers/${id}/actions/change_protection`),
      { method: "POST", headers: this.#headers, body: JSON.stringify(input) },
    );
    await this.waitForAction(data);
  }
  async deleteServer(id: string): Promise<void> {
    const { data } = await requestJson(
      this.fetcher,
      this.url(`/servers/${id}`),
      {
        method: "DELETE",
        headers: this.#headers,
      },
    );
    if (data) await this.waitForAction(data);
  }
}
