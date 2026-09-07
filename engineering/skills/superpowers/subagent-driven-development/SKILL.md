---
name: subagent-driven-development
description: Use when delegated implementation and independent review improve a planned or substantial change
---

# Subagent-Driven Development

Use subagents deliberately: a GPT-5 `worker` implements bounded work, and an Astra `reviewer` independently reviews meaningful completed units or a substantial integrated change. A trivial, understood fix may be implemented directly by a GPT-5 controller with focused verification.

Fresh context windows do **not** isolate the filesystem or Git index. In a shared worktree, assign disjoint files and make one coordinator responsible for the index, commits, branch operations, push, and PR actions. Serialize work that needs the same file. Use separate worktrees only when their setup and later integration are worthwhile.

## Decide the shape of work

1. Read the request, relevant plan or requirements, repository guidance, current status, and baseline evidence.
2. For unfamiliar or consequential architecture, delegate reconnaissance to `scout` and planning to `planner`; include the original requirements in every handoff. The planner and scout are read-only.
3. Split only independent work. Give each worker exact allowed files, dependencies, working directory, acceptance criteria, relevant baseline failures, verification commands, and delivery permissions.
4. Dispatch independent workers concurrently with `subagent`. Schedule dependent or overlapping work after its prerequisite or reassign the shared file.
5. Inspect reports and actual diffs, run integration checks, and request an independent `reviewer` review for meaningful work. The reviewer is read-only.
6. Evaluate findings against the requirements and code. Workers fix relevant, understood issues and rerun affected checks. Ask a focused question only when a material decision remains unresolved; continue independent work.

A review finding is technical input, not new user scope. One review can cover specification, architecture, quality, and security. Add separate review stages only for risk that warrants them. “Ready” means the reviewer’s assessment of the inspected state; it never authorizes merge, deployment, or another delivery action.

## Delegation contract

Use the installed `subagent` tool and role names; model selection belongs to the agent definitions, not tool arguments.

```text
subagent({
  agent: "worker",
  cwd: "<path>",
  task: `
Original requirements: <verbatim request or complete relevant excerpt>

Task: <bounded outcome>
Working directory: <path>
Allowed files: <exact paths/globs>
Dependencies and context: <relevant facts and prior output>
Acceptance criteria: <observable behavior>
Baseline failures: <known failures or "none recorded">
Verification: <focused commands or scenario checks>
Delivery permissions: <may edit/test; may not stage, commit, change branch, push, or create PR>

Preserve unrelated user work. Resolve routine assumptions from repository evidence.
Report changed files, checks and results, limitations, and blockers.
`,
})
```

Set the tool's `cwd` on every call (and every parallel task); the working-directory line is explanatory only. Parallel results retain only a 100-character preview, so writable parallel workers need uniquely owned report artifacts among their allowed files. The coordinator reads those artifacts and actual diffs; use single mode for detailed read-only reviews.

Do not invent `Task` types or model parameters. If no task tracker is available, keep a plain checklist in the coordinator context.

## Two-worker shared-worktree example

A change has independent modules:

```text
subagent({ agent: "worker", cwd: "/repo", task: "Original requirements: add validation. Working directory: /repo. Allowed files: src/a.ts, test/a.test.ts, .agent-reports/a-worker.md. Write the complete report to .agent-reports/a-worker.md. Implement and run npm test -- a. Do not stage, commit, change branch, push, or edit other files." })
subagent({ agent: "worker", cwd: "/repo", task: "Original requirements: add validation. Working directory: /repo. Allowed files: src/b.ts, test/b.test.ts, .agent-reports/b-worker.md. Write the complete report to .agent-reports/b-worker.md. Implement and run npm test -- b. Do not stage, commit, change branch, push, or edit other files." })
```

The coordinator dispatches these concurrently, reads both uniquely owned report artifacts and inspects both diffs, runs the integrated check, and alone performs any authorized Git delivery. If both tasks require `src/shared.ts`, serialize that edit or give it to one owner; do not let both workers race it.

## Review loop

Give the reviewer the original requirements, implementation summary, exact changed files, verification evidence, and either a Git range or the current working diff. The reviewer must inspect the actual diff and relevant code, not merely the worker report. Fix critical and relevant serious findings. Record justified non-blocking findings. Re-review changed areas when a fix materially affects the review; do not restart unrelated work or require an unconditional second review.

## Avoid

- Treating fresh context as filesystem isolation.
- Parallel edits to overlapping files or shared Git state.
- Worker staging, committing, changing branches, pushing, or creating PRs in a coordinator-owned shared workspace.
- Passing a prior summary instead of the original requirements.
- Requiring a scout, planner, worktree, or two reviews for every small change.
- Treating an ordinary uncertainty, review comment, or unrelated baseline failure as a stop signal.
