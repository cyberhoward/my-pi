### Subagents (`subagent`)

Delegate tasks to specialized subagents with isolated context windows.

**Modes:**
- Single: `{ agent: "scout", cwd: "/repo", task: "find all auth code" }`
- Parallel: `{ tasks: [{ agent: "worker", cwd: "/repo", task: "..." }, ...] }` (up to 8 tasks, 4 concurrent)
- Chain: `{ chain: [{ agent: "scout", cwd: "/repo", task: "..." }, { agent: "planner", cwd: "/repo", task: "Based on the original requirements and findings: {previous}" }] }`

Use `subagent` directly. `/implement`, `/scout-and-plan`, and `/implement-and-review` are optional separately installed presets; this repository does not provide them.

Use subagents for focused reconnaissance, independent disjoint-file implementation, and proportional review. Agent roles and explicit model choices come from agent frontmatter. An unavailable or unauthorized explicit model has no configured silent substitution to another model.

Child contexts are isolated, but their filesystem and Git index are shared unless separate worktrees are assigned. Set `cwd` on every call/task; task prose alone does not select the child's workspace. Give parallel workers disjoint ownership and keep staging, commits, branch operations, pushes, and PRs with the shared-worktree coordinator.

Parallel model-visible results retain only a 100-character preview per child. For parallel writable work, give every worker a unique report artifact in its allowed files and have the coordinator read it; do not treat success counts as verification. Use single mode for substantive read-only scouting or reviews so findings are returned in full. Read-only roles remain read-only.

Available agents are listed in the **Agents** section below.
