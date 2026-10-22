import { glob, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, resolve } from "node:path";

const maxDepth = 8;
const maxFiles = 64;
const maxFileBytes = 1024 * 1024;
const maxHosts = 256;
export const safeSshTargetPattern = /^(?:[A-Za-z0-9][A-Za-z0-9._-]*@)?[A-Za-z0-9][A-Za-z0-9._-]*$/;

type DiscoveryOptions = { home?: string; configPath?: string };
type SshTargetUI = { select(title: string, options: string[]): Promise<string | undefined>; input(title: string, placeholder?: string): Promise<string | undefined>; notify(message: string, type?: "info" | "warning" | "error"): void };

function words(line: string): string[] {
  const values: string[] = [];
  let value = "";
  let quote = "";
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote) {
      if (character === quote) quote = "";
      else value += character;
      continue;
    }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (character === "#") break;
    if (/\s/.test(character)) { if (value) { values.push(value); value = ""; } continue; }
    value += character;
  }
  if (value) values.push(value);
  return values;
}

function directive(line: string): { name: string; values: string[] } | undefined {
  const values = words(line.replace(/^(\s*[^\s=]+)\s*=\s*/, "$1 "));
  if (!values.length) return undefined;
  return { name: values[0].toLowerCase(), values: values.slice(1) };
}

function includePath(value: string, home: string, sshDirectory: string): string | undefined {
  if (!value || value.includes("$") || value.includes("%") || value.includes("`") || value.startsWith("~") && !value.startsWith("~/")) return undefined;
  const expanded = value.startsWith("~/") ? join(home, value.slice(2)) : value;
  return isAbsolute(expanded) ? normalize(expanded) : resolve(sshDirectory, expanded);
}

async function matchingFiles(pattern: string, limit: number): Promise<string[]> {
  if (limit <= 0) return [];
  if (!/[?*[]/.test(pattern)) return [pattern];
  const matches: string[] = [];
  for await (const path of glob(pattern, { withFileTypes: false })) {
    matches.push(path);
    if (matches.length >= limit) break;
  }
  return matches.sort((left, right) => left.localeCompare(right));
}

export async function discoverSshHosts(options: DiscoveryOptions = {}): Promise<string[]> {
  const home = options.home ?? homedir();
  const sshDirectory = join(home, ".ssh");
  const configPath = options.configPath ?? join(sshDirectory, "config");
  const hosts: string[] = [];
  const seenHosts = new Set<string>();
  const seenFiles = new Set<string>();
  let files = 0;
  const add = (value: string): void => {
    if (hosts.length >= maxHosts || !safeSshTargetPattern.test(value)) return;
    const key = value.toLowerCase();
    if (!seenHosts.has(key)) { seenHosts.add(key); hosts.push(value); }
  };
  const visit = async (path: string, depth: number): Promise<void> => {
    if (depth > maxDepth || files >= maxFiles) return;
    const normalized = normalize(path);
    if (seenFiles.has(normalized)) return;
    seenFiles.add(normalized);
    let size: number;
    try {
      const info = await stat(normalized);
      if (!info.isFile()) return;
      size = info.size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      if (depth === 0) throw error;
      return;
    }
    if (size > maxFileBytes) return;
    let contents: Buffer;
    try { contents = await readFile(normalized); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      if (depth === 0) throw error;
      return;
    }
    if (contents.byteLength > maxFileBytes) return;
    files += 1;
    for (const line of contents.toString("utf8").split(/\r?\n/)) {
      const parsed = directive(line);
      if (!parsed) continue;
      if (parsed.name === "host") for (const value of parsed.values) if (!value.startsWith("!") && !/[?*[]/.test(value)) add(value);
      if (parsed.name !== "include") continue;
      for (const value of parsed.values) {
        const pattern = includePath(value, home, sshDirectory);
        if (!pattern) continue;
        for (const child of await matchingFiles(pattern, maxFiles - files)) await visit(child, depth + 1);
      }
    }
  };
  await visit(configPath, 0);
  return hosts;
}

export async function selectSshTarget(ui: SshTargetUI, discover: () => Promise<string[]> = discoverSshHosts): Promise<string | undefined> {
  let hosts: string[];
  try { hosts = await discover(); } catch { ui.notify("Unable to read SSH configuration; enter an existing SSH alias or user@host manually.", "warning"); return ui.input("SSH target (existing authenticated alias or user@host)"); }
  if (!hosts.length) {
    ui.notify("No literal SSH aliases were found in ~/.ssh/config; enter an existing SSH alias or user@host manually.", "warning");
    return ui.input("SSH target (existing authenticated alias or user@host)");
  }
  const selected = await ui.select("Select SSH target (uses your current SSH config and agent)", [...hosts, "Enter manually…"]);
  if (!selected) return undefined;
  return selected === "Enter manually…" ? ui.input("SSH target (existing authenticated alias or user@host)") : selected;
}
