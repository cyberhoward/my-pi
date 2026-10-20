import { readdir, readFile, stat } from "fs/promises";
import { join, relative, basename, dirname } from "path";
import { homedir } from "os";

// ============================================================================
// Types
// ============================================================================

export interface ComponentItem {
  /** e.g. "engineering/skills/superpowers/brainstorming" */
  relativePath: string;
  /** Human-readable name, e.g. "brainstorming" */
  name: string;
  /** "skill" | "extension" | "agent" */
  type: "skill" | "extension" | "agent";
  /** Top-level category: "engineering" | "general" | "libraries" | "personal" */
  category: string;
  /** Sub-group within category, e.g. "superpowers" or an external library source */
  subGroup?: string;
  /** Description from SKILL.md frontmatter (skills only) */
  description?: string;
}

export interface ComponentGroup {
  id: string;
  label: string;
  children: (ComponentGroup | ComponentItem)[];
}

// ============================================================================
// Constants
// ============================================================================

const MY_PI_DIR = join(homedir(), ".my-pi");
const CATEGORIES = ["engineering", "general", "libraries", "personal"] as const;
const SKIP_DIRS = new Set(["node_modules", ".git", "pi-remote", "toggle"]);

// ============================================================================
// Frontmatter Parsing
// ============================================================================

async function parseSkillFrontmatter(
  skillMdPath: string
): Promise<{ name?: string; description?: string }> {
  try {
    const content = await readFile(skillMdPath, "utf-8");
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return {};
    const fm = match[1];
    const name = fm
      .match(/^name:\s*(.+)$/m)?.[1]
      ?.trim()
      .replace(/^["']|["']$/g, "");
    const description = fm
      .match(/^description:\s*["']?(.*?)["']?\s*$/m)?.[1]
      ?.trim();
    return { name, description };
  } catch {
    return {};
  }
}

// ============================================================================
// Discovery Helpers
// ============================================================================

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function walkDirectory(
  dir: string,
  callback: (filePath: string, isDir: boolean) => Promise<void>
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;

    const fullPath = join(dir, entry);
    const isDir = await isDirectory(fullPath);
    await callback(fullPath, isDir);

    if (isDir) {
      await walkDirectory(fullPath, callback);
    }
  }
}

// ============================================================================
// Component Discovery
// ============================================================================

/**
 * Discover all skills, extensions, and agents under ~/.my-pi
 */
export async function discoverComponents(): Promise<ComponentItem[]> {
  const items: ComponentItem[] = [];

  for (const category of CATEGORIES) {
    const categoryDir = join(MY_PI_DIR, category);
    if (!(await exists(categoryDir))) continue;

    // Discover agents: */agents/*.md (not .gitkeep)
    await discoverAgents(categoryDir, category, items);

    // Discover extensions: */extensions/*.ts or */extensions/*/index.ts
    await discoverExtensions(categoryDir, category, items);

    // Discover skills: **/SKILL.md
    await discoverSkills(categoryDir, category, items);
  }

  return items;
}

async function discoverAgents(
  categoryDir: string,
  category: string,
  items: ComponentItem[]
): Promise<void> {
  const agentsDir = join(categoryDir, "agents");
  if (!(await exists(agentsDir))) return;

  let entries: string[];
  try {
    entries = await readdir(agentsDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".md") || entry === ".gitkeep") continue;

    const fullPath = join(agentsDir, entry);
    if (await isDirectory(fullPath)) continue;

    const name = entry.replace(/\.md$/, "");
    const relativePath = relative(MY_PI_DIR, dirname(fullPath)) + "/" + name;

    items.push({
      relativePath,
      name,
      type: "agent",
      category,
    });
  }
}

async function discoverExtensions(
  categoryDir: string,
  category: string,
  items: ComponentItem[]
): Promise<void> {
  const extensionsDir = join(categoryDir, "extensions");
  if (!(await exists(extensionsDir))) return;

  let entries: string[];
  try {
    entries = await readdir(extensionsDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    // Skip the toggle extension itself
    if (entry === "toggle") continue;

    const fullPath = join(extensionsDir, entry);
    const isDir = await isDirectory(fullPath);

    if (isDir) {
      // Check for */index.ts
      const indexPath = join(fullPath, "index.ts");
      if (await exists(indexPath)) {
        const relativePath = relative(MY_PI_DIR, fullPath);
        items.push({
          relativePath,
          name: entry,
          type: "extension",
          category,
        });
      }
    } else if (entry.endsWith(".ts")) {
      // Direct *.ts file
      const name = entry.replace(/\.ts$/, "");
      const relativePath = relative(MY_PI_DIR, dirname(fullPath)) + "/" + name;

      items.push({
        relativePath,
        name,
        type: "extension",
        category,
      });
    }
  }
}

async function discoverSkills(
  categoryDir: string,
  category: string,
  items: ComponentItem[]
): Promise<void> {
  const skillsDir = join(categoryDir, "skills");
  if (!(await exists(skillsDir))) return;

  await walkDirectory(skillsDir, async (filePath, isDir) => {
    if (isDir || basename(filePath) !== "SKILL.md") return;

    const skillDir = dirname(filePath);
    const relativePath = relative(MY_PI_DIR, skillDir);
    const { name, description } = await parseSkillFrontmatter(filePath);

    const pathParts = relativePath.split("/");
    const isSuperpowers =
      category === "engineering" &&
      pathParts.length >= 3 &&
      pathParts[2] === "superpowers";
    const librarySource =
      category === "libraries" && pathParts.length >= 3
        ? pathParts[2]
        : undefined;

    const item: ComponentItem = {
      relativePath,
      name: name || basename(skillDir),
      type: "skill",
      category,
      description,
    };

    if (isSuperpowers) {
      item.subGroup = "superpowers";
    } else if (librarySource) {
      item.subGroup = librarySource;
    }

    items.push(item);
  });
}

// ============================================================================
// Group Tree Builder
// ============================================================================

/**
 * Organize a flat list of components into nested groups
 */
export function buildGroupTree(items: ComponentItem[]): ComponentGroup[] {
  const groups: ComponentGroup[] = [];

  for (const category of CATEGORIES) {
    const categoryItems = items.filter((i) => i.category === category);
    if (categoryItems.length === 0) continue;

    const categoryGroup: ComponentGroup = {
      id: category,
      label: category,
      children: [],
    };

    // Agents
    const agents = categoryItems.filter((i) => i.type === "agent");
    if (agents.length > 0) {
      categoryGroup.children.push({
        id: `${category}/agents`,
        label: "agents",
        children: agents,
      });
    }

    // Extensions
    const extensions = categoryItems.filter((i) => i.type === "extension");
    if (extensions.length > 0) {
      categoryGroup.children.push({
        id: `${category}/extensions`,
        label: "extensions",
        children: extensions,
      });
    }

    // Skills without a source-specific subgroup
    const regularSkills = categoryItems.filter(
      (i) => i.type === "skill" && !i.subGroup
    );
    if (regularSkills.length > 0) {
      categoryGroup.children.push({
        id: `${category}/skills`,
        label: "skills",
        children: regularSkills,
      });
    }

    // Source-specific skill groups
    const skillSubGroups = [
      ...new Set(
        categoryItems
          .filter((i) => i.type === "skill" && i.subGroup)
          .map((i) => i.subGroup!),
      ),
    ].sort();

    for (const subGroup of skillSubGroups) {
      const skills = categoryItems.filter(
        (i) => i.type === "skill" && i.subGroup === subGroup,
      );
      categoryGroup.children.push({
        id: `${category}/${subGroup}`,
        label: subGroup,
        children: skills,
      });
    }

    groups.push(categoryGroup);
  }

  return groups;
}
