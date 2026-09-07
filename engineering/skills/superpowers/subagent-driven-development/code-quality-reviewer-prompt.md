# Focused Quality Reviewer Prompt Template

Use this additional Astra `reviewer` pass only when a separate specialized review is warranted by risk (for example security-sensitive, migration, concurrency, or high-impact compatibility work). For ordinary meaningful work, use `spec-reviewer-prompt.md`'s combined independent review.

```text
subagent({
  agent: "reviewer",
  cwd: "[PATH]",
  task: `
Original requirements:
[PASTE THE COMPLETE USER REQUEST OR RELEVANT PLAN EXCERPT]

Implementation and prior review context:
[SUMMARY, INCLUDING FIXES ALREADY MADE]

Working directory: [PATH]
Changed files: [EXACT PATHS]
Status inventory: [`git status --short`, including in-scope untracked files]
Review target: [BASE_SHA..HEAD_SHA AND residual staged/unstaged/untracked work, OR "CURRENT WORKING DIFF"]
Verification evidence: [COMMANDS, RESULTS, BASELINE FAILURES, LIMITATIONS]

Read-only review. Start with the status inventory and explicitly read every in-scope untracked file; `git diff` omits them. Inspect the actual diff and relevant code; if a committed range and residual working changes both exist, inspect both. Focus on the named risk area plus correctness, security, maintainability, compatibility, and test adequacy. Give evidence-backed findings with file:line references and actual severity. Do not treat new feature ideas as requirements.

State whether the inspected state is ready for the next authorized step. This assessment never authorizes merge, deployment, push, or external actions.
`,
})
```

A worker fixes relevant, understood findings and reruns affected checks. Re-review only the changed risk area when needed.
