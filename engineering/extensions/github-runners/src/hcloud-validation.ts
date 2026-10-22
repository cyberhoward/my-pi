import { SafeRefusal } from "./types.js";

const supportedSystemImages = new Set(["ubuntu-24.04"]);

export function isSupportedSystemImage(value: unknown): value is string {
  return typeof value === "string" && supportedSystemImages.has(value);
}

export function assertSupportedSystemImage(value: unknown): asserts value is string {
  if (!isSupportedSystemImage(value))
    throw new SafeRefusal("image is not supported by the runner bootstrap");
}

export function assertRestrictiveFirewall(value: unknown): void {
  if (!Array.isArray(value)) throw new SafeRefusal("firewall rules are unavailable");
  const rules = value.map((rule) => {
    if (!rule || typeof rule !== "object" || Array.isArray(rule))
      throw new SafeRefusal("firewall rules are unavailable");
    return rule as Record<string, unknown>;
  });
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
    if (!required.some((entry) => entry.protocol === rule.protocol && entry.port === String(rule.port ?? "")))
      throw new SafeRefusal("firewall contains unapproved outbound egress");
  }
  for (const entry of required) {
    const allowed = rules.some((rule) =>
      rule.direction === "out" && rule.protocol === entry.protocol && String(rule.port ?? "") === entry.port &&
      Array.isArray(rule.destination_ips) && rule.destination_ips.includes("0.0.0.0/0") && rule.destination_ips.includes("::/0"),
    );
    if (!allowed)
      throw new SafeRefusal(`firewall missing ${entry.protocol}/${entry.port} IPv4/IPv6 egress`);
  }
}
