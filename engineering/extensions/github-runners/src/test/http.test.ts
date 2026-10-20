import { expect, it, vi } from "vitest";
import { collectLinkPages, requestJson } from "../http.js";

it("follows GitHub pagination with a bound", async () => {
  let call = 0;
  const fetcher = async () => {
    call++;
    return new Response(JSON.stringify({ items: [call] }), {
      headers: {
        "content-type": "application/json",
        ...(call === 1 ? { link: '<https://next>; rel="next"' } : {}),
      },
    });
  };
  expect(
    await collectLinkPages(fetcher, "https://first", (v) => (v as any).items),
  ).toEqual([1, 2]);
});
it("reports only safe provider metadata", async () => {
  const fetcher = async () =>
    new Response("secret body", {
      status: 500,
      headers: { "x-request-id": "safe-id" },
    });
  await expect(
    requestJson(fetcher, "https://host", {
      headers: { authorization: "secret" },
    }),
  ).rejects.not.toThrow("secret");
});
it("retries bounded read rate limits but never retries mutations", async () => {
  const read = vi
    .fn()
    .mockResolvedValueOnce(
      new Response("", { status: 429, headers: { "retry-after": "0" } }),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      }),
    );
  await expect(requestJson(read, "https://host")).resolves.toMatchObject({
    data: { ok: true },
  });
  expect(read).toHaveBeenCalledTimes(2);
  const mutation = vi.fn().mockResolvedValue(new Response("", { status: 500 }));
  await expect(
    requestJson(mutation, "https://host", { method: "POST" }),
  ).rejects.toThrow("status=500");
  expect(mutation).toHaveBeenCalledTimes(1);
});
