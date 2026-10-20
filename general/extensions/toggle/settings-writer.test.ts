import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyToggleConfig } from "./settings-writer.ts";
import type { ComponentItem } from "./discovery.ts";

const skill: ComponentItem = {
  relativePath: "engineering/skills/example",
  category: "engineering",
  name: "example",
  type: "skill",
};

test("syncs managed settings entries without modifying AGENTS.md", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "toggle-settings-"));
  const settingsPath = join(cwd, ".pi", "settings.json");
  const agentsPath = join(cwd, "AGENTS.md");
  const agentsContent = "# Project instructions\n\n<!-- toggle-managed-start -->\nlegacy\n<!-- toggle-managed-end -->\n";

  try {
    await mkdir(join(cwd, ".pi"));
    await writeFile(agentsPath, agentsContent);
    await writeFile(
      settingsPath,
      JSON.stringify({
        skills: ["./project-skill", "~/.my-pi/engineering/skills/removed"],
        extensions: ["./project-extension"],
        agents: [".pi/agents/project-agent.md"],
      }),
    );

    assert.equal(
      await applyToggleConfig({ disabled: [], known: [skill.relativePath] }, [skill], "project", cwd),
      true,
    );

    assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf-8")), {
      skills: ["./project-skill", "~/.my-pi/engineering/skills/example"],
      extensions: ["./project-extension"],
      agents: [".pi/agents/project-agent.md"],
    });
    assert.equal(await readFile(agentsPath, "utf-8"), agentsContent);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
