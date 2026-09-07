---
name: writing-skills
description: Use when creating or revising reusable agent skills, workflow guidance, or supporting skill references
---

# Writing Skills

## Purpose

A skill is concise, discoverable guidance that helps an agent achieve a user outcome safely. It is guidance, not a higher-priority instruction: system, developer, and explicit user instructions always win.

Use evidence to improve a skill, but do not turn evaluation into an obedience contest. A good skill supports correct outcomes, preserves user work, respects boundaries, and makes appropriate verification easier.

## Authoring workflow

1. Define the user outcome, trigger, scope, and meaningful safeguards.
2. Inspect existing conventions and identify concrete confusion or failure modes.
3. Draft the smallest clear guidance with usable examples and accurate tool names.
4. Verify proportionally: metadata and links for reference edits; representative decision scenarios for workflow changes.
5. Revise coherent related skills together when their instructions otherwise conflict.

A baseline scenario is useful when it reveals a real behavior to change. It is not required for a typo, reference update, or other edit where a static check is the meaningful evidence. Never invent baseline failures or claim live trials that did not run.

## Structure

```yaml
---
name: lowercase-hyphenated-name
description: Use when [specific trigger or symptom]
---
```

Keep frontmatter limited to `name` and `description`. Let the description say when to load the skill, not recite its workflow. In the body, lead with the decision or technique, preserve technical examples that demonstrate it, and distinguish mandatory safety boundaries from flexible guidance. When a decision diagram clarifies a workflow, follow [graph conventions](graphviz-conventions.dot) and render it for inspection (for example, `dot -Tsvg graphviz-conventions.dot -o graph.svg`).

## Evaluation matrix

| Change | Meaningful evaluation |
| --- | --- |
| Reference, prose, or link update | Parse frontmatter, check local links, inspect diff |
| Technique with executable example | Run or type-check the example if project tooling supports it |
| Workflow or decision guidance | Read-only representative scenarios including explicit user instructions and a genuine boundary |
| High-impact policy | Scenario review plus independent architecture/review feedback where available |

For workflow scenarios, record loaded files, prompt, expected decision, observed decision, and limitations. Mark unavailable model/tool trials **blocked**, not passed. Static checks support a scenario; they do not prove real-world autonomy.

## Scenario design

Use realistic choices that test the intended outcome: preserve existing work when tests are added later; continue through unrelated baseline failures with disclosure; avoid destructive commands without authorization; obey explicit “plan only,” “stop,” and read-only constraints. Do not frame success as following a skill against explicit user instructions.

## Common mistakes

- Treating a skill as authority over user or system instructions.
- Requiring an interactive gate for routine authorized work.
- Requiring per-skill deployment, deletion, or live-agent trials for reference-only edits.
- Testing only whether an agent quotes the skill instead of whether it makes a sound decision.
- Leaving examples that contradict the revised guidance.

See [testing-skills-with-subagents.md](testing-skills-with-subagents.md) for scenario protocol, [graph conventions](graphviz-conventions.dot) for diagram structure/rendering, [anthropic-best-practices.md](anthropic-best-practices.md) for detailed authoring guidance where applicable, and [persuasion-principles.md](persuasion-principles.md) for historical research context and ethical limits.
