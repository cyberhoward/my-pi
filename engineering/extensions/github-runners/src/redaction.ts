import { Secret } from "./types.js";

const sensitive = /(authorization|token|secret|password|user.?data)/i;
export class Redactor {
  readonly #values = new Set<string>();
  register(value: string | Secret<string>): void {
    const raw = value instanceof Secret ? value.reveal() : value;
    if (!raw) return;
    this.#values.add(raw);
    const base64 = Buffer.from(raw, "utf8").toString("base64");
    const base64url = Buffer.from(raw, "utf8").toString("base64url");
    this.#values.add(base64);
    this.#values.add(base64url);
  }
  redact(value: unknown): unknown {
    const visit = (input: unknown, key = ""): unknown => {
      if (sensitive.test(key)) return "[REDACTED]";
      if (typeof input === "string") {
        let result = input
          .replace(
            /([?&](?:token|key|secret|password)=)[^&#\s]+/gi,
            "$1[REDACTED]",
          )
          .replace(/:\/\/[^/@\s]+@/g, "://[REDACTED]@");
        for (const raw of this.#values)
          result = result.split(raw).join("[REDACTED]");
        return result;
      }
      if (Array.isArray(input)) return input.map((item) => visit(item));
      if (input && typeof input === "object") {
        if (input instanceof Secret) return "[REDACTED]";
        return Object.fromEntries(
          Object.entries(input).map(([k, v]) => [k, visit(v, k)]),
        );
      }
      return input;
    };
    return visit(value);
  }
  stringify(value: unknown): string {
    return JSON.stringify(this.redact(value));
  }
}
