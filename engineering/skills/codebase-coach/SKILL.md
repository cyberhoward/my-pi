---
name: codebase-coach
description: Interactive coaching on tools, libraries, and architectural patterns used in the current codebase. Researches both official docs and local usage, then runs a Socratic teaching session with comprehension questions. Use when the user wants to learn about a tool, library, or pattern in their project.
---

# Codebase Coach

Interactive coaching skill that helps developers deeply understand the tools, libraries, and architectural patterns in their codebase.

## Flow

### Phase 1 — Research

Dispatch the `tooling-researcher` sub-agent to investigate the topic:

```
subagent: tooling-researcher
task: "Research [topic] — investigate both official documentation (use brave-search) and local codebase usage. Produce comprehensive teaching material."
```

The researcher will return structured findings covering:
- Tool concepts and architecture (from official docs)
- Codebase usage patterns (from local code)
- Design decisions and trade-offs
- Key concepts and quiz questions

### Phase 2 — Teach

Present the research findings as a structured lesson:

1. **Start with the big picture** — What is this tool and why does the project use it?
2. **Core concepts** — Walk through the key abstractions, building from simple to complex
3. **Show the code** — Reference actual files and patterns from the codebase
4. **Bridge general → specific** — Explain which features the project uses and which it doesn't, and why

Keep the teaching conversational. After presenting each major concept, pause and check:
- "Does this make sense so far?"
- "Have you seen this pattern before?"
- "Any questions before we go deeper?"

### Phase 3 — Quiz (Socratic)

After the teaching section, shift to Socratic questioning:

1. **Start easy** — Basic recall questions about what was just covered
2. **Build up** — Application questions: "If you needed to add X, which file would you modify?"
3. **Go deep** — Trade-off questions: "Why do you think the project chose X over Y?"
4. **Challenge** — Edge case questions: "What would happen if...?"

Use the quiz questions from the researcher's output as a starting point, but adapt based on the learner's responses:
- If they nail it → skip ahead, go deeper
- If they struggle → back up, re-explain, try a different angle
- If they have misconceptions → correct gently with evidence from the code

### Phase 4 — Save

When the user says "done", "save", "I'm finished", or similar, end the teaching session and save a concise topic summary to `.learning/topics/<topic-name>.md`. Do not require a quiz or retrieval test. Offer an optional retrieval exercise only if the user asks for one.

## Topic File Format

```markdown
---
title: [Topic Name]
created: YYYY-MM-DD
updated: YYYY-MM-DD
tool: [tool/library name]
retrieval-score: X/3
review-priority: low|medium|high
tags:
  - [tag-1]
  - [tag-2]
---

# [Topic Name]

## What It Is
[Brief description of the tool and its purpose]

## Core Concepts
[Key abstractions and mental model]

## How This Project Uses It
[Specific patterns, files, and conventions]

## Key Files
- `path/to/file` — description

## Design Decisions
[Why the project uses it this way]

## Trade-offs
[What's gained and what's sacrificed]

## Gotchas
[Things that might trip you up]

## Resources
- [Official docs link]
- [Other useful links]
```

### File Naming
Use kebab-case: `drizzle-orm.md`, `react-query.md`, `hono-middleware.md`

### Updating Existing Files
If the topic file already exists:
- Read current contents
- Merge new insights (don't overwrite)
- Update `updated` date
- Update `retrieval-score` with latest

## Session Signals

- **User says "done"/"save"/"wrap up"** → Phase 4
- **User asks a tangential question** → Answer briefly, then steer back
- **User seems lost** → Back up to fundamentals, use simpler examples
- **User is clearly expert** → Skip basics, focus on codebase-specific patterns and edge cases

## Example Interaction

**User:** `/skill:codebase-coach drizzle`

**Coach:**
> Let me research how Drizzle ORM works and how this project uses it...
>
> *[dispatches tooling-researcher]*
>
> Great, here's what I found. Drizzle is a TypeScript ORM that...
>
> In this project, the schema is defined in `apps/core/src/db/schema.ts` and...
>
> Does the table definition pattern make sense so far?

**User:** "Yeah, but why not Prisma?"

**Coach:**
> Good question. Drizzle was chosen here because... [trade-offs from research]
>
> Now, if you needed to add a new table to this project, what steps would you take?

**User:** "Edit the schema file and run migrations?"

**Coach:**
> Exactly. And which command generates the migration? What directory do they end up in?
