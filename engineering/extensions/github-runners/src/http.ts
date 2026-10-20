import { ProviderFailure } from "./types.js";
export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;
export interface SafeHttpError {
  status: number;
  requestId?: string;
  retryAfterSeconds?: number;
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export async function requestJson(
  fetcher: FetchLike,
  url: string,
  init: RequestInit = {},
): Promise<{ data: unknown; response: Response }> {
  const observation = !init.method || init.method.toUpperCase() === "GET";
  let response: Response | undefined;
  for (let attempt = 0; attempt < (observation ? 3 : 1); attempt++) {
    try {
      response = await fetcher(url, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(15_000),
      });
    } catch (error) {
      if (observation && attempt < 2) {
        await sleep(25 * 2 ** attempt);
        continue;
      }
      throw new ProviderFailure(
        `provider observation transport failure: ${error instanceof Error ? error.name : "unknown"}`,
      );
    }
    if (
      observation &&
      (response.status === 429 || response.status >= 500) &&
      attempt < 2
    ) {
      const retryAfter = Number(response.headers.get("retry-after"));
      await sleep(
        Number.isFinite(retryAfter)
          ? Math.min(retryAfter * 1000, 2000)
          : 25 * 2 ** attempt,
      );
      continue;
    }
    break;
  }
  if (!response) throw new ProviderFailure("provider observation failed");
  if (response.status === 404) return { data: undefined, response };
  if (!response.ok) {
    const id =
      response.headers.get("x-request-id") ??
      response.headers.get("x-github-request-id");
    const retry = response.headers.get("retry-after");
    throw new ProviderFailure(
      `provider request failed status=${response.status}${id ? ` requestId=${id}` : ""}${retry ? ` retryAfter=${retry}` : ""}`,
    );
  }
  if (response.status === 204) return { data: undefined, response };
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("json"))
    throw new ProviderFailure("provider returned non-JSON response");
  return { data: await response.json(), response };
}
export async function collectLinkPages<T>(
  fetcher: FetchLike,
  firstUrl: string,
  parse: (value: unknown) => T[],
  init: RequestInit = {},
  maxPages = 20,
): Promise<T[]> {
  const result: T[] = [];
  let next: string | undefined = firstUrl;
  for (let page = 0; next && page < maxPages; page++) {
    const { data, response } = await requestJson(fetcher, next, init);
    result.push(...parse(data));
    const link = response.headers.get("link");
    next = link?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
  }
  if (next) throw new ProviderFailure("pagination exceeded safe page bound");
  return result;
}
