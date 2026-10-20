import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { FilesystemMutationLock } from "../lock.js";

it("refuses a contending mutation lock on the controller host", async () => {
  const dir = await mkdtemp(join(tmpdir(), "runner-lock-"));
  const path = join(dir, "mutation.lock");
  const lock = new FilesystemMutationLock();
  let release!: () => void;
  const held = lock.withLock(
    path,
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  while (!release) await new Promise((resolve) => setTimeout(resolve, 1));
  await expect(lock.withLock(path, async () => undefined)).rejects.toThrow(
    "local mutation lock",
  );
  release();
  await held;
  await rm(dir, { recursive: true, force: true });
});
it("allows a local lock to be reacquired after the operation completes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "runner-lock-"));
  const path = join(dir, "mutation.lock");
  const lock = new FilesystemMutationLock();
  await expect(lock.withLock(path, async () => "first")).resolves.toBe("first");
  await expect(lock.withLock(path, async () => "second")).resolves.toBe(
    "second",
  );
  await rm(dir, { recursive: true, force: true });
});
