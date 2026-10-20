import { executeReaper, parsePrivateEnvironment, parseReaperRequest, readBoundedJson, serveReaper } from "./reaper-runtime.js";

export type ReaperCliIo = { stdin: AsyncIterable<Uint8Array>; stdout(value: string): void; stderr(value: string): void };

function usage(): Error { return new Error("Usage: reaper-cli serve|request --config <path> [--env-file <path>]"); }
function argumentsFor(argv: string[]): { command: "serve" | "request"; config: string; envFile?: string } {
  const command = argv.shift();
  if (command !== "serve" && command !== "request") throw usage();
  let config: string | undefined; let envFile: string | undefined;
  while (argv.length) {
    const flag = argv.shift(); const value = argv.shift();
    if (!value || (flag !== "--config" && flag !== "--env-file")) throw usage();
    if (flag === "--config" && !config) config = value;
    else if (flag === "--env-file" && !envFile) envFile = value;
    else throw usage();
  }
  if (!config) throw usage();
  return { command, config, ...(envFile ? { envFile } : {}) };
}
export async function runReaperCli(argv: string[], io: ReaperCliIo, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  try {
    const args = argumentsFor([...argv]);
    const fileEnvironment = args.envFile ? await parsePrivateEnvironment(args.envFile) : {};
    const runtimeEnvironment = { ...env, ...fileEnvironment };
    if (args.command === "serve") { await serveReaper(args.config, { env: runtimeEnvironment, status: (value) => io.stderr(JSON.stringify({ status: value })) }); return 0; }
    const request = parseReaperRequest(await readBoundedJson(io.stdin));
    const result = await executeReaper(args.config, request, runtimeEnvironment);
    if (result.text) (result.code === 0 ? io.stdout : io.stderr)(result.text);
    return result.code;
  } catch (error) {
    const code = error && typeof error === "object" && "exitCode" in error && typeof (error as { exitCode?: unknown }).exitCode === "number" ? (error as { exitCode: number }).exitCode : 2;
    io.stderr(JSON.stringify({ error: error instanceof Error ? error.message : "request failed", exitCode: code }));
    return code;
  }
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  const code = await runReaperCli(process.argv.slice(2), { stdin: process.stdin, stdout: (value) => console.log(value), stderr: (value) => console.error(value) });
  process.exitCode = code;
}
