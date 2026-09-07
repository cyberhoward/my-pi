---
name: requesting-code-review
description: Use independent review for meaningful completed units, substantial changes, or risk that benefits from a fresh technical assessment
---

# Requesting Code Review

Request review in proportion to risk. An independent Astra `reviewer` should review meaningful completed work and substantial integrated changes. A typo or tightly bounded, well-understood change can use direct inspection and focused verification instead. Review early when it can prevent costly rework, not as an unconditional checkpoint after every task.

The reviewer is read-only. A coordinator or worker runs checks and applies fixes. A review assessment of “ready” describes the inspected state only; it does not authorize merge, deployment, push, or any other delivery action.

## Prepare an evidence-based review

Provide the reviewer:

- the original requirements or plan excerpt, verbatim where practical;
- what changed and why;
- exact changed files and dependencies;
- verification commands, results, baseline failures, and limitations; and
- a status inventory (`git status --short`), including in-scope untracked files; and
- a review target that includes both committed changes and any residual staged/unstaged/untracked work when both exist.

Use the actual `subagent` tool and the `reviewer` role. Models are selected by agent definitions.

```text
subagent({
  agent: "reviewer",
  cwd: "<path>",
  task: `
Original requirements: <complete request or relevant plan excerpt>
What was implemented: <summary>
Working directory: <path>
Changed files: <paths>
Review target: <BASE_SHA>..<HEAD_SHA> | current working diff
Verification evidence: <commands and results>
Baseline failures/limitations: <facts>

Read-only review. Inspect the actual diff and relevant code. Check requirement coverage, correctness, architecture, security, maintainability, tests, compatibility, and scope. Categorize findings by severity with file:line references and evidence. State whether the inspected state is ready for the next authorized step; this is not merge authorization.
`,
})
```

Start with a status inventory. For a working diff, inspect unstaged and staged content and explicitly read each in-scope untracked file; `git diff` does not show untracked files. For a range, inspect its summary/content **and** the residual working state when present—having commits does not exclude later changes.

```bash
git status --short
git diff --stat BASE_SHA..HEAD_SHA
git diff BASE_SHA..HEAD_SHA
git diff
git diff --cached
# Read each in-scope untracked file named by git status --short.
```

## Act on findings

1. Evaluate each finding against the requirements and repository evidence.
2. Fix critical and relevant serious issues autonomously with a worker; run the affected checks.
3. Record a reasoned disposition for non-blocking, invalid, or out-of-scope suggestions.
4. Re-review the changed area when the fix changes the risk or reviewer confidence.

Ask for clarification only when a finding exposes a material unresolved product, compatibility, cost, or authorization decision. Continue independent understood fixes while that decision is pending. Do not turn reviewer feedback into unrequested scope.
