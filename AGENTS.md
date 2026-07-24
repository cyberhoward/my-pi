# Pi Global Instructions

## Workflow Preferences

- Use **superpowers skills** when available (brainstorming, writing-plans, subagent-driven-development, test-driven-development, etc.)
- Use **subagents** for non-trivial delegation: scout unfamiliar or broad code, plan multi-step work, then implement. For small, well-scoped mechanical edits, inspect the relevant file and implement directly without mandatory scouting.
- Search the web with **brave-search** when you need current docs or information; pair with **defuddle** to extract clean full-page content from result URLs
- **When the user corrects you, proactively save the lesson** using `memory_save` with `source: "correction"`.

## Tool Configuration

Tool, extension, and subagent availability is **project-specific** and assembled from per-component `SNIPPET.md` files.

- If you don't see an **Available Tools** section somewhere in your context files, the current project hasn't been configured yet (or you're not in a project). Tell the user they can run `/toggle` in the project directory to pick which extensions, skills, and agents should be enabled there — this updates `.pi/settings.json` *and* writes a managed block into `{cwd}/AGENTS.md` with per-tool usage guidance.
- Do **not** hand-edit the `<!-- toggle-managed-start -->` … `<!-- toggle-managed-end -->` block in any AGENTS.md. Changes there get overwritten the next time `/toggle` runs.

## Globally Available Tools

These are always loaded regardless of project context:

### Toggle (`/toggle`)

Interactive TUI for enabling/disabling skills, extensions, and agents for the current project. Run it inside a project directory — it errors out in `$HOME`.

### Subagents (`subagent`)

Delegate tasks to specialized subagents with isolated context windows.

**Modes:**
- Single: `{ agent: "scout", task: "find all auth code" }`
- Parallel: `{ tasks: [{ agent: "scout", task: "..." }, ...] }` (up to 8 tasks, 4 concurrent)
- Chain: `{ chain: [{ agent: "scout", task: "..." }, { agent: "planner", task: "Based on: {previous}" }] }`

**Workflow prompts:** `/implement`, `/scout-and-plan`, `/implement-and-review`

Default agents (loaded from `~/.my-pi/engineering/agents/`): `scout`, `planner`, `reviewer`, `worker`, `remover`, `tooling-researcher`.

### Notifications (`notify`, `ask_user`)

System notifications with a custom chime sound. Cross-platform (macOS + Linux).

- `notify` — Send a system notification with optional chime sound
- `ask_user` — Play chime + notification + prompt user for input. **Use this when you need the user's attention.**
- `/ping` — Test the chime sound

### Persistent Memory (`memory_save`, `memory_search`, `memory_list`, `memory_remove`)

Persistent memory across sessions. Memories are auto-injected into the system prompt.

- `memory_save` — Save a memory (project-scoped or global). Use `source: "correction"` when learning from mistakes.
- `memory_search` — Fuzzy search across memories
- `memory_list` — List all memories
- `memory_remove` — Remove a memory by ID

**When the user corrects you, proactively save the lesson using `memory_save` with `source: "correction"`.**

## Prompting Notes (Claude Opus 4.7)

Opus 4.7 interprets instructions literally and calibrates behavior per task rather than following fixed scaffolding. Adjust accordingly:

- **Be explicit about delegation.** 4.7 spawns fewer subagents by default. When a skill or workflow requires a subagent, state it as a requirement ("dispatch X"), not a suggestion ("consider using X").
- **Be explicit about tool use.** 4.7 reasons more and uses tools less. When a task needs tool calls (scout a codebase, run a verification command, search the web), say so directly.
- **Don't rely on inferred intent.** If you want a specific behavior, write it. 4.7 will not silently generalize from one item to another or infer requests you didn't make.
- **Skip progress scaffolding.** Don't add instructions like "summarize progress every N tool calls" — 4.7 produces user-facing progress updates natively in long agentic traces. If the update style is wrong, describe the desired style explicitly with examples.
- **Prefer positive examples over negative rules.** "Respond in 2-3 sentences with the file path" beats "Don't be verbose, don't add preamble, don't explain." Show the shape you want.
- **Raise effort for complex work.** At low/medium effort, 4.7 scopes tightly to what was asked. For genuinely complex reasoning, either raise effort or add "think carefully through this before responding" to the prompt.
