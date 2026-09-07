import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const superpowers = "engineering/skills/superpowers";
const skills = [
  "brainstorming",
  "dispatching-parallel-agents",
  "executing-plans",
  "finishing-a-development-branch",
  "receiving-code-review",
  "requesting-code-review",
  "subagent-driven-development",
  "systematic-debugging",
  "test-driven-development",
  "using-git-worktrees",
  "using-superpowers",
  "verification-before-completion",
  "writing-plans",
  "writing-skills",
];
const read = (relative) => readFileSync(path.join(root, relative), "utf8");

const frontmatter = (relative) => {
  const match = read(relative).match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match, `${relative} must start with YAML frontmatter`);
  const metadata = new Map();
  for (const line of match[1].split("\n").filter(Boolean)) {
    const separator = line.indexOf(":");
    assert.ok(separator > 0, `${relative} has a key/value frontmatter entry`);
    metadata.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim().replace(/^"|"$/g, ""));
  }
  return metadata;
};

const localLinks = (text) => [...text.matchAll(/\]\(([^)]+)\)/g)]
  .map((match) => match[1].trim())
  .filter((target) => target && !target.startsWith("#") && !/^[a-z][a-z\d+.-]*:/i.test(target) && !target.startsWith("/"));

test("all 14 Superpowers skills have matching, usable metadata", () => {
  assert.equal(skills.length, 14, "the Superpowers skill inventory is intentional");
  for (const name of skills) {
    const file = `${superpowers}/${name}/SKILL.md`;
    const metadata = frontmatter(file);
    assert.equal(metadata.get("name"), name, `${file} name matches its directory`);
    assert.ok(metadata.get("description"), `${file} has a non-empty description`);
  }
});

test("local supporting references from Superpowers skill entry points resolve", () => {
  for (const name of skills) {
    const skillFile = `${superpowers}/${name}/SKILL.md`;
    for (const target of localLinks(read(skillFile))) {
      const targetPath = target.split("#", 1)[0];
      assert.ok(
        existsSync(path.resolve(root, path.dirname(skillFile), targetPath)),
        `${skillFile} links to existing local file ${target}`,
      );
    }
  }
});
