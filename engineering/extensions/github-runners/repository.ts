import { execFile } from "node:child_process";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

export interface RepositoryBinding {
  root: string;
  repository: string;
}

export type CommandRunner = (
  file: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; maxBuffer: number; signal?: AbortSignal },
) => Promise<{ stdout: string; stderr?: string }>;

export const nodeCommandRunner: CommandRunner = async (file, args, options) => {
  const result = await executeFile(file, args, {
    cwd: options.cwd,
    timeout: options.timeoutMs,
    maxBuffer: options.maxBuffer,
    encoding: "utf8",
    signal: options.signal,
    windowsHide: true,
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

export function parseGitHubOrigin(value: string): string | undefined {
  const origin = value.trim();
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(origin);
  return match ? `${match[1]}/${match[2]}` : undefined;
}

export async function detectRepository(
  cwd: string,
  run: CommandRunner = nodeCommandRunner,
  signal?: AbortSignal,
): Promise<RepositoryBinding | undefined> {
  try {
    const root = (await run("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      timeoutMs: 5_000,
      maxBuffer: 16 * 1024,
      signal,
    })).stdout.trim();
    if (!root) return undefined;
    const urls = (await run("git", ["config", "--get-all", "remote.origin.url"], {
      cwd: root,
      timeoutMs: 5_000,
      maxBuffer: 16 * 1024,
      signal,
    })).stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    const repositories = [...new Set(urls.map(parseGitHubOrigin).filter((value): value is string => Boolean(value)))];
    return repositories.length === 1 && urls.length === 1 ? { root, repository: repositories[0] } : undefined;
  } catch {
    return undefined;
  }
}

export function sameRepository(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}
