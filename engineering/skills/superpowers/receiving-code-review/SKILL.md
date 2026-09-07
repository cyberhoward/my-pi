---
name: receiving-code-review
description: Use when evaluating review feedback and applying relevant fixes with technical evidence
---

# Receiving Code Review

Review feedback is technical input, not an order and not a reason to stop all work. Read it fully, verify it against the requirements and codebase, then act on the findings that are correct and within scope.

## Evaluate and act

For each finding:

1. Locate the cited code and understand the proposed failure mode.
2. Compare it with the original requirements, established patterns, compatibility constraints, and test evidence.
3. Classify it as valid and in scope, invalid, non-blocking, out of scope, or blocked by a material decision.
4. Fix valid, understood critical and serious findings autonomously. Run focused checks for each affected behavior, then re-review changed areas if the fix changes the reviewer’s concerns.
5. Record concise technical reasoning for findings not fixed.

Do not accept claims without checking, nor require total agreement before applying independent fixes. If one comment is unclear, progress on other understood items. Ask a focused question only when the unclear point materially changes scope, correctness, compatibility, cost, or authorization and repository evidence cannot resolve it.

## Priority

Address security, data loss, broken behavior, and requirement gaps first. Then address relevant reliability, maintainability, and test gaps. Suggestions that add unused features or alter an explicit user decision require technical justification and may be recorded rather than implemented.

A reviewer may assess the current diff as ready for a next authorized step. That assessment never authorizes merging, deployment, pushing, or external mutations.

## Response and evidence

When reporting back, state the finding, the evidence, the exact fix or disposition, and checks run. Keep communication factual; performative agreement is unnecessary. Preserve user work and do not broaden testing beyond what the changed behavior or project policy requires without a reason.

For inline GitHub review comments, reply in the comment thread when an authorized delivery workflow calls for a reply:

```bash
gh api repos/{owner}/{repo}/pulls/{pr}/comments/{id}/replies
```

Do not use a review comment as authorization for Git or external actions not otherwise delegated.
