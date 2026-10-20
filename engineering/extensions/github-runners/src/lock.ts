import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { SafeRefusal } from "./types.js";

export class FilesystemMutationLock {
  async withLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
    await mkdir(dirname(path), { recursive: true });
    const handle = await open(path, "a", 0o600);
    await handle.close();
    let release: (() => Promise<void>) | undefined;
    try {
      release = await lockfile.lock(path, {
        stale: 60_000,
        update: 20_000,
        retries: 0,
        realpath: true,
      });
      return await operation();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOCKED")
        throw new SafeRefusal("local mutation lock is held");
      throw error;
    } finally {
      if (release) await release();
    }
  }
}
