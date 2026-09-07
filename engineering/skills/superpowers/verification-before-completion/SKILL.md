---
name: verification-before-completion
description: Use before claiming a change is complete, fixed, passing, or ready for delivery
---

# Verification Before Completion

## Principle

Make claims that match evidence. Choose checks that exercise the changed behavior, read their output, and report both results and limitations. Verification is proportional: a reference-only edit may need a parser or link check, while a behavior change usually needs focused tests.

## Evidence loop

1. Identify the claim: for example, “the retry behavior works” or “these Markdown links resolve.”
2. Select the smallest meaningful check and run it after the relevant edit.
3. Read the exit status and relevant output.
4. Investigate new failures that are related to the change.
5. Report what the evidence proves, what it does not prove, and known baseline/environment limits.

Do not infer a build result from a linter, a full suite result from one test, or correctness from an agent report. Reuse recent evidence only while relevant files and dependencies are unchanged; broaden or repeat checks when a new change, failure, or risk justifies it.

## Claim-to-evidence guide

| Claim | Suitable evidence | Honest limitation |
| --- | --- | --- |
| Focused behavior works | Relevant test or reproducible scenario | Does not imply all tests pass |
| Build succeeds | Actual build command exits successfully | Does not prove runtime behavior |
| Documentation/reference links are valid | Markdown/link parser or targeted static check | Does not run application fixtures |
| Requirements are covered | Diff and concise requirement checklist | Does not replace behavior checks |
| Delegated work is usable | Inspect diff and run relevant checks | Agent report alone is insufficient |

## Baselines and blockers

Capture relevant failures before edits where practical. Continue safely past demonstrably unrelated baseline failures, preserving their output. Do not launch an unrelated repair campaign. If a required check cannot run because of the environment, report it as unverified or blocked; do not say “all tests pass.”

## Reporting examples

```text
Verified: `npm test -- retry.test.ts` exited 0 (3 tests).
Also checked: `markdown-link-check docs/guide.md` exited 0.
Limitation: the repository integration suite was not run; the focused test does not establish it.
```

```text
Baseline: `npm test -- legacy/auth.test.ts` failed before this change with its recorded timeout.
After change: `npm test -- export.test.ts` exited 0.
The baseline failure remains unrelated and was not repaired.
```

Avoid vague claims such as “should work” or “everything is clean.” State the command and result instead.
