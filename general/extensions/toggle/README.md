# Toggle Dashboard

Interactive TUI for picking which `~/.my-pi` skills, extensions, and agents are enabled **for the current project**.

## Usage

```
/toggle     # Must be run inside a project directory (errors out in $HOME)
```

### Controls

| Key | Action |
|-----|--------|
| ↑↓ | Navigate |
| ←→ / Enter | Toggle enabled/disabled |
| / | Search/filter |
| Esc | Close (reloads pi with the new config applied) |

### Group Toggles

Top-level categories (Engineering, General, Libraries, Personal) and sub-groups (Agents, Extensions, Skills, Superpowers, and external library sources such as Expo or Mobbin) act as group toggles — toggling them cascades to all children.

Mixed groups show the count of enabled items (e.g., `3/5 enabled`). Newly discovered components under `general/` start enabled. Newly discovered components in every other category start disabled, so they are only loaded after you select them.

## What it writes

Every toggle updates two files in the project's `.pi/` directory (creating them on first use):

| File | Purpose |
|------|---------|
| `.pi/toggle-config.json` | Source of truth for what you've chosen — disabled paths plus the component paths already presented to you |
| `.pi/settings.json` | Pi's settings file — gets one include entry per **enabled** component |

Entries in `.pi/settings.json` that point into `~/.my-pi/` are considered managed by this extension and rewritten on every toggle. Any other entries (user-authored includes, excludes of unrelated paths) are preserved verbatim. `/toggle` does not create or modify `AGENTS.md`.

### Include paths by component type

| Component layout | Include entry |
|---|---|
| `<dir>/SKILL.md` | `~/.my-pi/<category>/skills/<name>` |
| `<dir>/index.ts` | `~/.my-pi/<category>/extensions/<name>` |
| `<name>.ts` (single file) | `~/.my-pi/<category>/extensions/<name>.ts` |
| `<name>.md` (agent) | `~/.my-pi/<category>/agents/<name>.md` |

## Why project-only?

Global `~/.pi/agent/settings.json` carries a small hand-curated set of always-on tools (toggle itself, subagent + its agents, notifications, memory). Everything else is project-gated so a fresh pi session outside a project stays minimal, and each project declares exactly the toolkit it needs.

## How changes apply

Changes are written to disk immediately on every toggle. Opening `/toggle` also performs an initial sync of `.pi/settings.json`; if that sync changes it, closing the dashboard calls `ctx.reload()` even if no checkbox was toggled.
