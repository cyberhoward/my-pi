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

Top-level categories (Engineering, General, Personal) and sub-groups (Agents, Extensions, Skills, Superpowers) act as group toggles — toggling them cascades to all children.

Mixed groups show the count of enabled items (e.g., `3/5 enabled`).

## What it writes

Every toggle updates three files in the project's `.pi/` directory (creating them on first use):

| File | Purpose |
|------|---------|
| `.pi/toggle-config.json` | Source of truth for what you've chosen — a list of disabled component paths |
| `.pi/settings.json` | Pi's settings file — gets one include entry per **enabled** component |
| `{cwd}/AGENTS.md` | Assembled tool documentation for the agent (inside `<!-- toggle-managed-start/end -->` markers) |

Entries in `.pi/settings.json` that point into `~/.my-pi/` are considered managed by this extension and rewritten on every toggle. Any other entries (user-authored includes, excludes of unrelated paths) are preserved verbatim. Preserved project-local agent includes (for example `.pi/agents/my-agent.md`) are also documented in the generated `AGENTS.md` block so the visible agent list matches what Pi loads.

### Include paths by component type

| Component layout | Include entry |
|---|---|
| `<dir>/SKILL.md` | `~/.my-pi/<category>/skills/<name>` |
| `<dir>/index.ts` | `~/.my-pi/<category>/extensions/<name>` |
| `<name>.ts` (single file) | `~/.my-pi/<category>/extensions/<name>.ts` |
| `<name>.md` (agent) | `~/.my-pi/<category>/agents/<name>.md` |

## Why project-only?

Global `~/.pi/agent/settings.json` carries a small hand-curated set of always-on tools (toggle itself, subagent + its agents, notifications, memory). Everything else is project-gated so a fresh pi session outside a project stays minimal, and each project declares exactly the toolkit it needs.

## SNIPPET.md convention

Each component can ship a `SNIPPET.md` — prose written in imperative voice addressing the agent ("You have tool X; use it when…"). When a component is enabled, its snippet is inlined into the project's assembled `AGENTS.md`. For agents, the snippet is synthesized from frontmatter `description` + `model`.

| Component layout | Snippet location |
|---|---|
| `<name>/` (directory) | `<name>/SNIPPET.md` |
| `<name>.ts` (single file) | `<name>.SNIPPET.md` (sibling) |
| `<name>.md` (agent) | None — synthesized from frontmatter |

If a component has no snippet, it still loads (it just doesn't contribute to AGENTS.md).

## How changes apply

Changes are written to disk immediately on every toggle. When you close the dashboard, pi calls `ctx.reload()` to pick up the new settings without restarting.
