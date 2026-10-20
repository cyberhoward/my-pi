import assert from "node:assert/strict";
import test from "node:test";
import { registerDiscoveredComponents } from "./config.ts";
import type { ComponentItem } from "./discovery.ts";

function item(relativePath: string, category: string): ComponentItem {
  return { relativePath, category, name: relativePath.split("/").at(-1)!, type: "skill" };
}

test("new non-general components default disabled while general components default enabled", () => {
  const config = { disabled: [], known: ["engineering/skills/existing"] };
  const items = [
    item("engineering/skills/existing", "engineering"),
    item("libraries/skills/expo/new-skill", "libraries"),
    item("general/skills/new-general-skill", "general"),
  ];

  assert.deepEqual(registerDiscoveredComponents(config, items), {
    disabled: ["libraries/skills/expo/new-skill"],
    known: [
      "engineering/skills/existing",
      "general/skills/new-general-skill",
      "libraries/skills/expo/new-skill",
    ],
  });
});

test("legacy configs treat the newly introduced libraries category as undiscovered", () => {
  const config = { disabled: ["engineering/skills/disabled"] };
  const items = [
    item("engineering/skills/enabled", "engineering"),
    item("engineering/skills/disabled", "engineering"),
    item("libraries/skills/expo/new-skill", "libraries"),
  ];

  assert.deepEqual(registerDiscoveredComponents(config, items), {
    disabled: ["engineering/skills/disabled", "libraries/skills/expo/new-skill"],
    known: [
      "engineering/skills/disabled",
      "engineering/skills/enabled",
      "libraries/skills/expo/new-skill",
    ],
  });
});
