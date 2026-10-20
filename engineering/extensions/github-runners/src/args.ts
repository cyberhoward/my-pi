import { UsageError } from "./types.js";
export interface CliArgs {
  command: string;
  apply: boolean;
  json: boolean;
  instance?: string;
  all: boolean;
  capacity?: number;
  configPath: string;
}
export function parseArgs(argv: string[]): CliArgs {
  const command = argv.shift();
  if (
    !command ||
    !["list", "status", "ensure", "reconcile", "drain", "destroy"].includes(
      command,
    )
  )
    throw new UsageError("unknown command");
  const result: CliArgs = {
    command,
    apply: false,
    all: false,
    json: false,
    configPath: "runner-manager.policy.yaml",
  };
  while (argv.length) {
    const flag = argv.shift();
    if (flag === "--apply") result.apply = true;
    else if (flag === "--all") {
      if (result.all) throw new UsageError("duplicate --all");
      result.all = true;
    }
    else if (flag === "--json") result.json = true;
    else if (flag === "--instance") result.instance = argv.shift();
    else if (flag === "--capacity") result.capacity = Number(argv.shift());
    else if (flag === "--config") result.configPath = argv.shift() ?? "";
    else throw new UsageError(`unknown option ${flag}`);
  }
  if (result.all && command !== "destroy") throw new UsageError("--all is valid only for destroy");
  if (result.all && result.instance) throw new UsageError("--all and --instance are mutually exclusive");
  if (["drain", "destroy"].includes(command) && !result.instance && !result.all)
    throw new UsageError("--instance or destroy --all is required");
  if (
    result.instance &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      result.instance,
    )
  )
    throw new UsageError("--instance must be an exact UUID");
  if (["list", "status"].includes(command) && result.apply)
    throw new UsageError("--apply is not valid for read-only commands");
  if (command !== "ensure" && result.capacity !== undefined)
    throw new UsageError("--capacity is valid only for ensure");
  if (!["drain", "destroy"].includes(command) && result.instance)
    throw new UsageError("--instance is valid only for drain/destroy");
  return result;
}
