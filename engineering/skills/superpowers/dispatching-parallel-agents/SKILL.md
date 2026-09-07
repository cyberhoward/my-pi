---
name: dispatching-parallel-agents
description: Use when independent investigation or implementation can improve speed or quality without conflicting ownership
---

# Dispatching Parallel Agents

Parallelism is a choice, not a ritual. Use it when tasks are independent and concurrent work improves time or quality. Investigate related failures together; serialize dependencies and shared files.

## Before dispatching

For each task, establish:

- the original requirements and bounded outcome;
- exact allowed files or a separate worktree;
- working directory, dependencies, and baseline failures;
- acceptance criteria and focused verification;
- delivery permissions; and
- who owns integration and Git operations.

Contexts are isolated, but a shared worktree and Git index are not. In a shared workspace, workers do not stage, commit, change branches, push, or create PRs. One coordinator owns those operations and resolves ownership collisions before dispatch.

## Dispatch

Use the actual `subagent` tool and role definitions. Do not supply fictional agent types or model parameters.

```text
subagent({
  tasks: [
    {
      agent: "worker",
      cwd: "/repo",
      task: `Original requirements: repair independent validation failures.
Working directory: /repo
Allowed files: src/abort.ts, test/abort.test.ts, .agent-reports/abort-worker.md
Report artifact: .agent-reports/abort-worker.md (uniquely owned; write the complete report there)
Task: diagnose and fix the abort failures.
Acceptance criteria: named tests pass without increasing arbitrary timeouts.
Baseline failures: recorded in /tmp/baseline.log.
Verification: npm test -- abort.test.ts
Delivery permissions: edit and test only; do not stage, commit, change branch, push, or edit other files.
Report root cause, exact files changed, checks/results, and limitations.`,
    },
    {
      agent: "worker",
      cwd: "/repo",
      task: `Original requirements: repair independent validation failures.
Working directory: /repo
Allowed files: src/batch.ts, test/batch.test.ts, .agent-reports/batch-worker.md
Report artifact: .agent-reports/batch-worker.md (uniquely owned; write the complete report there)
Task: diagnose and fix batch-completion failures.
Acceptance criteria: named tests pass and behavior remains compatible.
Baseline failures: recorded in /tmp/baseline.log.
Verification: npm test -- batch.test.ts
Delivery permissions: edit and test only; do not stage, commit, change branch, push, or edit other files.
Report root cause, exact files changed, checks/results, and limitations.`,
    },
  ],
})
```

Parallel tool results expose only a 100-character report preview. For writable parallel workers, assign each a unique coordinator-owned report artifact in its allowed files, then have the coordinator read those artifacts and inspect the actual diffs. Do not infer verification from parallel success counts. Use a single `subagent({ agent: "scout" | "reviewer", cwd: "/repo", task: "..." })` call for a detailed read-only reconnaissance or review; retain the role's read-only restrictions.

Use `scout` for read-only reconnaissance and `planner` for consequential architecture before workers when useful. Include the complete original requirements in every handoff, not only a previous agent’s summary.

## Integrate

1. Read each complete report artifact and inspect the actual diffs.
2. Confirm that ownership did not overlap and preserve unrelated work already in the tree or index.
3. Run an integration check appropriate to the combined change.
4. Request an independent read-only `reviewer` review for meaningful completed work or a substantial integrated change.
5. Have a worker fix relevant, understood findings, then rerun affected checks and re-review only the changed area when warranted.

Do not claim a focused check covers a full suite. Record unrelated baseline failures and limitations rather than starting an unrelated repair campaign.

## When not to parallelize

- One change depends on another’s result.
- Tasks edit the same file, lock, fixture, external resource, or Git state.
- The failures may share a root cause.
- The coordination cost exceeds a focused direct investigation.

For a shared file, serialize the tasks, assign that file to one worker, or use deliberately isolated worktrees with an explicit integration plan.
