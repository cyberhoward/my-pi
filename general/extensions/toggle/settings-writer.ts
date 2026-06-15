import { readFile, writeFile, mkdir, stat } from "fs/promises";
import { homedir } from "os";
import { join, dirname } from "path";
import type { ComponentItem } from "./discovery.ts";
import type { ToggleConfig } from "./config.ts";
import { isDisabled } from "./config.ts";

/**
 * Project-scoped settings-writer.
 *
 * The toggle extension writes **include entries** into `{cwd}/.pi/settings.json`
 * — one plain path per enabled component. "Enabled" means the component is
 * not listed in the project's `toggle-config.json`.
 *
 * Global `~/.pi/agent/settings.json` is never touched by this extension;
 * always-on tools (toggle, memory, notifications, subagent, agents) live
 * there and are hand-maintained.
 *
 * Managed vs user-authored entries
 * --------------------------------
 * Any entry whose path (after stripping a leading `-`, `!`, or `+` prefix)
 * points into `~/.my-pi/` is considered managed and rewritten on every
 * apply. This also sweeps up legacy exclusion-style entries (`-path` /
 * `!path/**`) from earlier versions of this writer.
 *
 * Entries outside `~/.my-pi/` (user-authored includes/excludes of their own)
 * are preserved verbatim.
 */

const MY_PI_DIR = join(homedir(), ".my-pi");
const HOME_MARKER = "~/.my-pi/";
const ABS_MARKER = MY_PI_DIR + "/";

/** Stripped-prefix check for managed-ness. */
function isManagedEntry(entry: string): boolean {
  const stripped = entry.replace(/^[-!+]\s*/, "").trim();
  return (
    stripped === "~/.my-pi" ||
    stripped === MY_PI_DIR ||
    stripped.startsWith(HOME_MARKER) ||
    stripped.startsWith(ABS_MARKER)
  );
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Compute the include entry for a component.
 *
 * - Skill (directory)         → `~/.my-pi/<relPath>`
 * - Extension (directory)     → `~/.my-pi/<relPath>` (has `index.ts` inside)
 * - Extension (single .ts)    → `~/.my-pi/<relPath>.ts`
 * - Agent                     → `~/.my-pi/<relPath>.md`
 */
async function includeEntryFor(item: ComponentItem): Promise<string> {
  const rel = `~/.my-pi/${item.relativePath}`;
  const abs = join(MY_PI_DIR, item.relativePath);

  if (item.type === "extension") {
    if (await fileExists(abs + ".ts")) return `${rel}.ts`;
    return rel;
  }
  if (item.type === "agent") return `${rel}.md`;
  return rel; // skill
}

/**
 * Rewrite the project `settings.json` to include exactly the enabled
 * components. User-authored entries are preserved; managed entries are
 * replaced wholesale.
 */
export async function applyToggleConfig(
  config: ToggleConfig,
  allItems: ComponentItem[],
  scope: "global" | "project",
  cwd?: string,
): Promise<boolean> {
  if (scope !== "project" || !cwd) {
    // Global scope is a no-op in the new model — always-on tools live in
    // the hand-maintained global settings.json.
    return false;
  }

  const settingsPath = join(cwd, ".pi", "settings.json");

  let existingRaw = "";
  let settings: Record<string, unknown>;
  try {
    existingRaw = await readFile(settingsPath, "utf-8");
    settings = JSON.parse(existingRaw);
  } catch {
    settings = {};
  }

  // Enabled = not disabled (by path or ancestor path) in toggle-config.json.
  const enabled = allItems.filter((i) => !isDisabled(config, i.relativePath));

  const includes: Record<"skills" | "extensions" | "agents", string[]> = {
    skills: [],
    extensions: [],
    agents: [],
  };
  const keyMap: Record<ComponentItem["type"], "skills" | "extensions" | "agents"> = {
    skill: "skills",
    extension: "extensions",
    agent: "agents",
  };

  for (const item of enabled) {
    const key = keyMap[item.type];
    includes[key].push(await includeEntryFor(item));
  }

  for (const key of ["skills", "extensions", "agents"] as const) {
    const existing = Array.isArray(settings[key]) ? (settings[key] as unknown[]) : [];
    const userAuthored = existing
      .filter((e): e is string => typeof e === "string")
      .filter((e) => !isManagedEntry(e));
    const managed = includes[key].sort();

    if (userAuthored.length === 0 && managed.length === 0) {
      delete settings[key];
    } else {
      settings[key] = [...userAuthored, ...managed];
    }
  }

  const newContent = JSON.stringify(settings, null, 2) + "\n";
  if (existingRaw === newContent) return false;

  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, newContent, "utf-8");
  return true;
}
