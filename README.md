# my-pi

Personal [pi](https://github.com/badlogic/pi-mono) dotfiles — extensions, skills, and agent configuration.

## Structure

```
~/.my-pi/
├── AGENTS.md              # Global workflow preferences (copy to ~/.pi/agent/AGENTS.md)
├── SETUP.md               # Step-by-step setup instructions for pi to follow
├── settings.example.json  # Example ~/.pi/agent/settings.json
├── engineering/           # Software development tools
│   ├── agents/            # Subagent definitions (scout, planner, reviewer, worker)
│   ├── extensions/        # code-ast (TS-aware code intelligence)
│   └── skills/            # Superpowers (TDD, debugging, code review, planning, etc.)
├── general/               # General-purpose tools (useful everywhere)
│   ├── extensions/        # subagent, memory, notifications
│   └── skills/            # brave-search, browser-tools, defuddle, annas-archive
└── personal/              # Personal skills (non-engineering workflows)
    └── skills/            # ticktick, obsidian-cli, obsidian-markdown, obsidian-bases, json-canvas
```

## Quick Start

```bash
git clone git@github.com:CyberHoward/my-pi.git ~/.my-pi
cd ~/.my-pi && pi "Read SETUP.md and walk me through setup."
```

## Directory Layout

### `general/` — Always useful

Extensions and skills that are valuable in any context.

| Component | Type | Description |
|-----------|------|-------------|
| **subagent/** | Extension | Delegate tasks to specialized subagents with isolated context windows. Tool: `subagent`. Optional workflow presets (`/implement`, `/scout-and-plan`, `/implement-and-review`) are not distributed by this repository. |
| **toggle/** | Extension | TUI dashboard for enabling/disabling skills, extensions, and agents. Command: `/toggle` (global) or `/toggle project` (per-project) |
| **memory.ts** | Extension | Persistent memory across sessions. Tools: `memory_save`, `memory_search`, `memory_list`, `memory_remove` |
| **notifications/** | Extension | System notifications with chime. Tools: `notify`, `ask_user`. Command: `/ping` |
| **brave-search/** | Skill | Web search + page content extraction. Requires `BRAVE_API_KEY` |
| **browser-tools/** | Skill | Browser automation via Chrome DevTools Protocol. Requires Chrome |
| **defuddle/** | Skill | Clean article extraction from URLs. Prefer over `WebFetch` for standard web pages. Requires `defuddle` CLI (`npm i -g defuddle`) |
| **annas-archive/** | Skill | Access Anna's Archive mirrors, torrent listings, metadata, and API endpoints |

### `engineering/` — Software development

Tools for coding workflows. Only load these in engineering projects.

| Component | Type | Description |
|-----------|------|-------------|
| **code-ast/** | Extension | TypeScript-aware code intelligence. Tools: `ast_references`, `ast_rename`, `ast_symbols` |
| **agents/** | Agents | Subagent definitions: `scout` (GPT-5.6 Luna), `planner` and `reviewer` (GPT-6 Astra), `worker` and `remover` (GPT-5.6 Terra), and `tooling-researcher` (GPT-5.6 Sol). |
| **superpowers/** | Skills | Brainstorming, TDD, systematic debugging, code review, git worktrees, planning, and more — from [superpowers](https://github.com/obra/superpowers) |

### `personal/` — Non-engineering workflows

Skills for personal productivity, writing, and knowledge management.

| Component | Type | Description |
|-----------|------|-------------|
| **ticktick/** | Skill | TickTick task workflows (inbox processing, weekly review, triage) |
| **obsidian-cli/** | Skill | Interact with a running Obsidian vault via the `obsidian` CLI (notes, tasks, properties, plugin dev) |
| **obsidian-markdown/** | Skill | Author valid Obsidian Flavored Markdown (wikilinks, embeds, callouts, properties) |
| **obsidian-bases/** | Skill | Create/edit Obsidian `.base` files (views, filters, formulas) |
| **json-canvas/** | Skill | Create/edit JSON Canvas `.canvas` files (nodes, edges, groups) |

Obsidian skills and `defuddle` are vendored from [kepano/obsidian-skills](https://github.com/kepano/obsidian-skills) (MIT). See [`personal/skills/ATTRIBUTION.md`](personal/skills/ATTRIBUTION.md).

## Usage

### Global setup (minimal always-on toolkit)

Global `~/.pi/agent/settings.json` only enables the tools you want everywhere — everything else is opt-in per project. A sensible minimum:

```json
{
  "extensions": [
    "~/.my-pi/general/extensions/toggle",
    "~/.my-pi/general/extensions/memory.ts",
    "~/.my-pi/general/extensions/notifications",
    "~/.my-pi/general/extensions/subagent"
  ],
  "skills": [],
  "packages": ["npm:pi-context"]
}
```

Then symlink the global prompt and agents directory so the repo stays the single source of truth. Project agent trust/enablement remains a local trust boundary:

```bash
ln -sf  ~/.my-pi/AGENTS.md           ~/.pi/agent/AGENTS.md
ln -sfn ~/.my-pi/engineering/agents  ~/.pi/agent/agents
```

### Per-project setup

Run `/toggle` inside the project directory. The dashboard picks which skills, extensions, and agents to enable for that project — it writes `.pi/settings.json` (one include per enabled component), `.pi/toggle-config.json` (the disabled list), and an assembled `AGENTS.md` with per-tool docs.

## Subagent routing and isolation

Agent models are configured in agent frontmatter and forwarded explicitly by the extension. An unavailable or unauthorized explicit model has no configured silent fallback to another model. Child context isolation does not isolate the filesystem or Git index: parallel workers need disjoint file ownership, and a shared-worktree coordinator owns Git delivery. Use the `subagent` tool directly; any named workflow presets are separately installed optional conveniences, not repository-provided commands.

## Environment Variables

```bash
export BRAVE_API_KEY="your-brave-api-key"
```

Get a free key at https://api-dashboard.search.brave.com/register
