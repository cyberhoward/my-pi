# Implementer Subagent Prompt Template

Dispatch a GPT-5 `worker` with the actual `subagent` tool. Agent definitions select the model; do not add model arguments.

```text
subagent({
  agent: "worker",
  cwd: "[PATH]",
  task: `
Original requirements:
[PASTE THE COMPLETE USER REQUEST OR RELEVANT PLAN EXCERPT]

Task:
[BOUNDED TASK AND EXPECTED OUTCOME]

Working directory:
[PATH]

Allowed files:
[EXACT PATHS OR GLOBS]

Context and dependencies:
[REPOSITORY PATTERNS, PRIOR OUTPUT, AND DEPENDENCIES]

Acceptance criteria:
[OBSERVABLE REQUIREMENTS]

Baseline failures:
[KNOWN FAILURES, OR "NONE RECORDED"]

Verification:
[FOCUSED COMMANDS OR READ-ONLY DECISION SCENARIOS]

Delivery permissions:
[EXACT PERMISSIONS, for example: edit and run checks only; do not stage, commit, change branch, push, create a PR, or modify files outside the allowed set.]

Work autonomously within this scope. Inspect repository evidence and resolve routine assumptions using existing patterns. Preserve unrelated user work. Do not overwrite other owners' files or shared Git state. Ask a focused question only when missing information materially changes correctness, compatibility, cost, scope, or authorization and cannot be resolved from evidence; continue independent work while blocked.

Prefer behavior-oriented tests when changing behavior. For documentation or configuration, use meaningful parsing, focused checks, or scenario validation rather than invented tests. Investigate relevant failures and distinguish new failures from recorded baseline failures.

Before reporting, inspect your diff and self-review for requirement coverage, unintended scope, safety, compatibility, and maintainability. Fix issues you can establish are relevant.

Report:
- completed outcome and any assumptions;
- exact files changed;
- verification commands/scenarios and results;
- baseline failures or limitations; and
- blockers or decisions that need coordinator input.
`,
})
```
