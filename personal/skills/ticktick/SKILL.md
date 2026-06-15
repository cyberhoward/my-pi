---
name: ticktick
description: "Personal task management workflows for TickTick. Use when the user wants to process their inbox, do a weekly review, capture tasks, triage, categorize, tag, or manage their task system. Also use when they mention tasks, todos, inbox, or weekly review."
---

# TickTick Task Management

## First Step — Always

Before ANY workflow, call the `ticktick` tool with `action: "load_config"` to fetch the full system configuration. This returns:
- **Tags** — prefixed tag taxonomy (area:, action:, energy:, loc:)
- **Projects Guide** — what each project is for and routing rules
- **Review Checklist** — weekly review protocol
- **Current Priorities** — user's top life themes
- **Inbox Processing Rules** — decision tree for triaging tasks

Parse and internalize this config before proceeding. Use it for all categorization decisions.

## Detecting Workflow

Based on what the user says, pick one:
- **Inbox processing** — "process inbox", "triage", "categorize tasks", "clean up inbox"
- **Weekly review** — "weekly review", "review my tasks", "go through my system"
- **Quick capture** — "add a task", "remind me to", "I need to", or any task creation request

If ambiguous, ask which workflow they want.

## Workflow 1: Inbox Processing

### Step 1: Fetch inbox
Call `ticktick` with `action: "list_tasks"`, `project: "Inbox"`.

### Step 2: Analyze and batch propose
For each task, propose:
- **Project** — where it should live (per Projects Guide from config)
- **Tags** — area: + optional action:, energy:, loc: tags (per Tag taxonomy from config)
- **Priority** — Eisenhower via priority flags (see Priority Assignment below)
- **Date** — if applicable

Format each proposal as:
```
Task: "[title]"
  → Project: [emoji] [name]
  → Tags: [tag1], [tag2]
  → Priority: [emoji] [level] ([reasoning])
  → Date: [date or "none"]
```

### Step 3: Flag ambiguous tasks
Separate tasks that are ambiguous into a "needs discussion" group. A task is ambiguous when:
- It could fit multiple projects equally well
- It's a question or reflection that might be actionable OR just a thought
- It has no clear action verb or deliverable
- Its content needs interpretation for categorization

### Step 4: Present to user
Show the batch proposal with a summary:
"**X tasks categorized, Y flagged for discussion.** Review the batch above — tell me to apply all, or point out specific tasks to adjust."

Group proposals by target project for readability.

### Step 5: Apply
On approval, update each task via `ticktick` with `action: "update_task"` with the agreed tags and priority.

**Important:** Use `move_task` to move tasks between projects when the user approves. This is implemented as create-in-target-project + delete-original, so the task ID changes and comments/history may not be preserved.

### Step 6: Handle ambiguous tasks
Walk through flagged tasks one at a time. Present options, get user input, then apply.

## Workflow 2: Weekly Review

Follow the Review Checklist from Config step by step:

1. **Process Inbox → Zero** — trigger Inbox Processing workflow (steps above)
2. **Set Priority Flags** — fetch tasks across projects that have no priority set, suggest priorities
3. **Review ⏳Waiting For** — call `ticktick` with `action: "list_tasks"`, `project: "⏳Waiting For"`, ask about follow-ups
4. **Review 🔴 High Priority** — fetch high-priority tasks, confirm still urgent + important, identify top 3 for the week
5. **Check 🟡 Medium Priority Backlog** — pick 2-3 to advance, suggest dates
6. **Align with Current Priorities** — compare this week's focus against Current Priorities note from config
7. **Clean Up** — identify completed tasks, duplicates, stale items

Present each step's findings and get confirmation before moving to the next.

## Workflow 3: Quick Capture

1. User describes a task naturally
2. Based on Config (Projects Guide + Tags), auto-suggest:
   - **Title** — clean up user's phrasing if needed
   - **Project** — best fit per routing rules
   - **Tags** — relevant area: + action: tags
   - **Priority** — per Eisenhower mapping
   - **Date** — if mentioned or implied
3. Present the proposal concisely:
   "**[title]** → [project] | [tags] | [priority] | [date]"
4. On confirmation, create via `ticktick` with `action: "create_task"`

## Priority Assignment (Eisenhower Matrix)

Use TickTick's built-in priority flags:
- 🔴 **High** — Urgent + Important: deadlines, people waiting, time-sensitive obligations
- 🟡 **Medium** — Not Urgent + Important: growth, planning, relationship building, health
- 🔵 **Low** — Urgent + Not Important: nice to have, could delegate or automate
- ⚪ **None** — Not Urgent + Not Important: someday/maybe, tag with `action:someday`

## Limitations

- **Move caveat:** `move_task` recreates the task in the target project and deletes the original; this changes the task ID and may not preserve comments/history/metadata that `tickrs` does not expose.
- **Cannot list tags globally** — the tag taxonomy lives in the Config project's Tags note.
- **Cannot create subtasks independently** — use the `items` parameter when creating/updating tasks.
