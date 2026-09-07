---
name: writing-plans
description: Use for substantial multi-step work when a written plan improves implementation or handoff.
---

# Writing Plans

Write a plan that lets an engineer make the requested change safely without turning routine work into ceremony. A user request for planning only ends with the plan. An authorized implementation request proceeds after planning; do not offer an execution-choice handoff.

Save a durable plan as `docs/plans/YYYY-MM-DD-<feature-name>.md` when the project benefits from one. Small, understood changes may use a short in-session checklist instead.

## Plan format

```markdown
# [Feature] Implementation Plan

**Goal:** [requested outcome]
**Scope:** [included behavior and explicit exclusions]
**Approach:** [key design decision and rationale]
**Dependencies / assumptions:** [only material items]

### Task 1: [coherent unit]
**Files:** Modify `path`; add/update `test path` when behavior needs coverage.
**Work:** [concrete change and relevant precedent].
**Verification:** Run `[focused command or static/scenario check]`; expected evidence: [result].
**Ownership/dependencies:** [only when delegated or ordered].
```

Use exact paths where known, concrete behavior, acceptance criteria, dependencies, and proportionate verification. Include test-first steps for behavioral code when appropriate, but do not force a complete code listing, a 2–5 minute task size, a test that merely mirrors a low-impact edit, or a commit after each task.

For parallel work, define disjoint file ownership and integration order. In a shared worktree, the coordinator owns the Git index, commits, branches, push, and PR operations. Include baseline failures and their relevance when known.

## Quality checks

Review the plan against the request and repository evidence. Resolve routine ambiguity yourself. Ask only about a decision that materially affects scope, correctness, compatibility, cost, or authorization. State unverified assumptions rather than inventing them.

A useful plan describes how to verify the intended outcome and what could invalidate the evidence. It does not authorize destructive or external actions beyond the user’s request.
