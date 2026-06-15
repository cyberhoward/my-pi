import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { homedir } from "os";
import { resolve } from "path";
import { discoverComponents, buildGroupTree } from "./discovery.ts";
import { loadConfig, saveConfig, toggleItem } from "./config.ts";
import { applyToggleConfig } from "./settings-writer.ts";
import { assembleProjectAgentsMd } from "./assembler.ts";
import { buildSettingItems, createToggleUI } from "./ui.ts";
import type { ToggleSettingItem } from "./ui.ts";

// ============================================================================
// Extension
// ============================================================================

export default function toggleExtension(pi: ExtensionAPI) {
  pi.registerCommand("toggle", {
    description: "Toggle which ~/.my-pi components are enabled for this project",
    handler: async (_args, ctx) => {
      const cwd = ctx.cwd;
      const home = homedir();

      // Reject use in the home directory — /toggle is a project-scoping tool
      // and would have no meaningful effect at $HOME (no project settings to
      // write, and we don't want to litter $HOME with an AGENTS.md block).
      if (resolve(cwd) === resolve(home)) {
        ctx.ui.notify(
          "/toggle must be run inside a project directory — cd into a project first.",
          "error",
        );
        return;
      }

      const allItems = await discoverComponents();
      const groups = buildGroupTree(allItems);

      if (allItems.length === 0) {
        ctx.ui.notify("No components found in ~/.my-pi", "warning");
        return;
      }

      // Initial sync: materialize the current project config into settings.json
      // and AGENTS.md so opening `/toggle` always brings these files in line
      // with the saved toggle-config.json, even without any user toggles.
      const initialConfig = await loadConfig("project", cwd);
      const settingsChanged = await applyToggleConfig(initialConfig, allItems, "project", cwd);
      const agentsMdChanged = await assembleProjectAgentsMd(initialConfig, allItems, cwd);

      let changed = settingsChanged || agentsMdChanged;
      let running = true;

      while (running) {
        const config = await loadConfig("project", cwd);
        const items = buildSettingItems(groups, allItems, config);

        const result = await ctx.ui.custom<null | undefined>(
          (tui, theme, _kb, done) => {
            return createToggleUI(tui, theme, done, {
              items,
              onToggle: async (id, enabled) => {
                const item = items.find((i) => i.id === id) as ToggleSettingItem | undefined;
                if (!item) return;

                let updatedConfig = config;

                if (item.childIds && item.childIds.length > 0) {
                  // Group toggle: apply to all children
                  for (const childId of item.childIds) {
                    updatedConfig = toggleItem(updatedConfig, childId, enabled);
                  }
                } else {
                  updatedConfig = toggleItem(updatedConfig, id, enabled);
                }

                Object.assign(config, updatedConfig);
                await saveConfig(updatedConfig, "project", cwd);
                await applyToggleConfig(updatedConfig, allItems, "project", cwd);
                await assembleProjectAgentsMd(updatedConfig, allItems, cwd);

                changed = true;
              },
            });
          },
        );

        // Escape closes the UI; any other resolution re-runs with fresh state.
        if (result === undefined) running = false;
      }

      if (changed) {
        await ctx.reload();
      }
    },
  });
}
