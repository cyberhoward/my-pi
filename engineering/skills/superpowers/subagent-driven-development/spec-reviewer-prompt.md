# Requirements Reviewer Prompt Template

Dispatch an Astra `reviewer` for independent, read-only review when the completed unit is meaningful or risk warrants it. This review covers requirement compliance and may also flag architecture, security, quality, or test issues. Do not require a separate quality review unless risk justifies one.

```text
subagent({
  agent: "reviewer",
  cwd: "[PATH]",
  task: `
Original requirements:
[PASTE THE COMPLETE USER REQUEST OR RELEVANT PLAN EXCERPT]

What was implemented:
[WORKER SUMMARY]

Working directory:
[PATH]

Changed files:
[EXACT PATHS]

Status inventory:
[`git status --short`, including in-scope untracked files]

Review target:
[BASE_SHA..HEAD_SHA AND residual staged/unstaged/untracked work, OR "CURRENT WORKING DIFF"]

Verification evidence:
[COMMANDS, RESULTS, BASELINE FAILURES, AND LIMITATIONS]

Read-only review: start with the status inventory and explicitly read every in-scope untracked file; `git diff` omits them. Inspect the actual diff and relevant code; if a committed range and residual working changes both exist, inspect both. Do not modify files or run builds. Do not rely on the implementer report alone.

Compare the implementation to the original requirements. Check missing or unintended behavior, compatibility, architecture, security, maintainability, and whether verification supports the claims. Categorize findings by actual severity, include file:line references and evidence, and distinguish required fixes from non-blocking suggestions or out-of-scope ideas.

State whether the inspected state is ready for the next authorized step. This assessment never authorizes merge, deployment, push, or any external action.
`,
})
```

If findings lead to fixes, have the assigned worker make them and rerun affected checks. Re-review the changed area when the fix materially affects the finding; do not restart unrelated review work.
