---
name: ticktick
description: "Personal TickTick task management: inbox processing, weekly review, or an explicitly requested personal capture/update. Do not use for engineering task lists, project checklists, or code-work planning."
---

# TickTick Task Management

Use this skill only for clear personal TickTick intent: processing a personal inbox, a personal weekly review, or an explicit request to create, update, or move a TickTick task. Mentions of engineering tasks, todos, checklists, plans, issues, or a repository task list do not invoke this skill.

## Start with context

For a personal TickTick workflow, call `ticktick` with `action: "load_config"` before categorizing or mutating. Use its tags, projects guide, review checklist, priorities, and inbox rules. If the requested action is already exact and authorized (for example, “Create task X in Inbox”), load configuration and carry it out without a redundant confirmation.

## Workflow selection

- **Inbox processing:** “process my TickTick inbox”, “triage my personal tasks”, or “clean up my TickTick inbox”.
- **Weekly review:** “review my TickTick tasks” or “weekly review”.
- **Capture or update:** an explicit request to create, update, complete, or move a named TickTick task.

Ask which personal workflow is intended only when it remains ambiguous after context.

## Inbox processing

1. List Inbox tasks with `action: "list_tasks"`, `project: "Inbox"`.
2. Propose project, tags, priority, and date for each task using the configuration. Group ambiguous items separately.
3. Present the batch proposal, including this warning for each proposed move: `move_task` recreates the task in the target project, changes its ID, and may not preserve comments, history, or metadata.
4. Apply categorization or moves only after the user confirms the proposed batch or a specified subset. Use `update_task` for tags/priority and `move_task` only for approved moves.
5. Discuss ambiguous items individually before changing them.

## Weekly review

Follow the configured review checklist: inbox, priority flags, waiting-for tasks, high-priority work, medium-priority backlog, current priorities, and cleanup. Present findings and proposals; confirm before any batch mutation. A review may continue through read-only steps without repeated confirmation.

## Explicit capture or update

For an exact authorized request, infer routine title, tags, priority, and date from the configuration, then perform the named ordinary capture or update and report what changed. Do not apply unrelated suggested changes. If the request leaves a material target, content, or destructive consequence unresolved, present a concise proposal and ask that focused question.

## Priority assignment

- 🔴 **High:** urgent and important.
- 🟡 **Medium:** important but not urgent.
- 🔵 **Low:** urgent but not important.
- ⚪ **None:** neither urgent nor important; use `action:someday` where appropriate.

## Limitations

- `move_task` recreates the task in the target project and deletes the original; task ID, comments, history, and metadata may not be preserved.
- Global tag listing is unavailable; use the Config project’s Tags note.
- Subtasks must be supplied through the `items` parameter when creating or updating a task.
