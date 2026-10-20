import { readFile, writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";
import type { ComponentItem } from "./discovery.ts";

export interface ToggleConfig {
  disabled: string[];
  /** Component paths already presented to the user. */
  known?: string[];
}

const MY_PI_DIR = join(process.env.HOME!, ".my-pi");

export function getConfigPath(scope: "global" | "project", cwd?: string): string {
  if (scope === "global") return join(MY_PI_DIR, "toggle-config.json");
  return join(cwd!, ".pi", "toggle-config.json");
}

export async function loadConfig(scope: "global" | "project", cwd?: string): Promise<ToggleConfig> {
  const path = getConfigPath(scope, cwd);
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw);
  } catch {
    // A new project starts with no known components. Discovery will enable
    // general components and require explicit selection for everything else.
    return { disabled: [], known: [] };
  }
}

export async function saveConfig(config: ToggleConfig, scope: "global" | "project", cwd?: string): Promise<void> {
  const path = getConfigPath(scope, cwd);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

/**
 * Register newly discovered components and apply their initial state.
 * General components are available by default; every other category is
 * opt-in. Existing choices are preserved.
 */
export function registerDiscoveredComponents(
  config: ToggleConfig,
  allItems: ComponentItem[],
): ToggleConfig {
  // Configs written before `known` existed predate the libraries category.
  // Treat the old engineering/general/personal inventory as already seen,
  // while allowing newly added categories to follow the opt-in policy.
  const legacyCategories = new Set(["engineering", "general", "personal"]);
  const known = new Set(
    config.known ??
      allItems
        .filter((item) => legacyCategories.has(item.category))
        .map((item) => item.relativePath),
  );
  const disabled = new Set(config.disabled);

  for (const item of allItems) {
    if (known.has(item.relativePath)) continue;
    known.add(item.relativePath);
    if (item.category !== "general") disabled.add(item.relativePath);
  }

  return {
    disabled: [...disabled].sort(),
    known: [...known].sort(),
  };
}

/** Check if a component path is disabled. Supports group paths (e.g. disabling "engineering" disables all under it) */
export function isDisabled(config: ToggleConfig, relativePath: string): boolean {
  return config.disabled.some(d => relativePath === d || relativePath.startsWith(d + "/"));
}

/** Toggle an item. enabled=true removes it from disabled list, enabled=false adds it. */
export function toggleItem(config: ToggleConfig, relativePath: string, enabled: boolean): ToggleConfig {
  const disabled = new Set(config.disabled);
  if (enabled) {
    disabled.delete(relativePath);
  } else {
    disabled.add(relativePath);
  }
  return { ...config, disabled: [...disabled].sort() };
}
