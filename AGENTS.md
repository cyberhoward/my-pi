# Pi Global Instructions

## Workflow Preferences

Instructions from the system, developer, and user take precedence over skills. Treat an explicit request for action as authorization to carry out its ordinary, reversible engineering work; skills guide judgment and cannot impose approval gates that conflict with it. Preserve project trust controls, credentials, personal data, user changes, and unrelated work.

- Choose applicable **superpowers skills** proportionately. A trivial understood fix needs focused inspection, implementation, and verification; substantial or unfamiliar work benefits from selective scouting, a concise plan, and architecture review when consequential.
- Use **subagents** when independent ownership improves quality or time. In shared workspaces, assign disjoint files and keep Git index, commits, branches, push, and PR operations with one coordinator. Fresh contexts do not isolate files or the index.
- Route implementation to GPT-5 workers and consequential architecture/planning or independent review to Astra at medium effort, as configured by agent frontmatter. Use the scout for routine reconnaissance; do not invent model aliases or silent fallbacks.
- Resolve routine ambiguity from evidence and use reversible defaults. Ask a focused question only when missing information materially changes scope, correctness, compatibility, cost, or authorization and cannot be resolved; continue independent work while waiting. Reassess the approach after repeated failed hypotheses rather than escalating ordinary failures.
- Capture relevant baseline evidence before edits when practical. Run checks proportionate to changed behavior, retain evidence of unrelated baseline failures, and state limitations precisely; focused checks do not mean every test passed.
- Search the web with **brave-search** when current documentation or information is needed; pair with **defuddle** to extract clean full-page content from result URLs.
- When the user corrects you, proactively save the lesson using `memory_save` with `source: "correction"`.

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

**Optional workflow presets:** `/implement`, `/scout-and-plan`, `/implement-and-review` may be available when installed for the project. Use `subagent` directly when they are absent; do not treat a preset as required.

Default agents (loaded from `~/.my-pi/engineering/agents/`): `scout`, `planner`, `reviewer`, `worker`, `remover`, `tooling-researcher`.

### Notifications (`notify`, `ask_user`)

System notifications with a custom chime sound. Cross-platform (macOS + Linux).

- `notify` — Send a system notification with optional chime sound
- `ask_user` — Play chime + notification + prompt user for input. Use this when the user’s attention is needed for a material decision.
- `/ping` — Test the chime sound

### Persistent Memory (`memory_save`, `memory_search`, `memory_list`, `memory_remove`)

Persistent memory across sessions. Memories are auto-injected into the system prompt.

- `memory_save` — Save a memory (project-scoped or global). Use `source: "correction"` when learning from mistakes.
- `memory_search` — Fuzzy search across memories
- `memory_list` — List all memories
- `memory_remove` — Remove a memory by ID

**When the user corrects you, proactively save the lesson using `memory_save` with `source: "correction"`.**

## Model and Prompting Guidance

Use clear task scope, ownership, acceptance criteria, and verification commands in delegated work. GPT-6 Astra follows instructions closely and can pause for consequential ambiguity: direct it to complete authorized work, infer routine details from evidence, and ask only focused material-decision questions. Astra does not support `none` reasoning effort; use a supported effort. GPT-5 workers implement scoped changes and report exact checks and limitations.

Do not add ritual progress scaffolding, forced approval loops, or exhaustive test runs without a reason. State the desired output shape and the concrete evidence needed. For substantial work, give reviewers the actual requirements, diff, and verification evidence; reviewers remain read-only and a review result does not authorize merge or deployment.
