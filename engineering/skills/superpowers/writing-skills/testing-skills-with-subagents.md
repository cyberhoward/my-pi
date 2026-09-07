# Evaluating Skills With Subagents

Use this reference when a skill changes decisions or workflow behavior. Evaluation asks whether agents achieve the intended user outcome with appropriate safeguards; it does not reward unquestioning compliance with a document.

## Proportionate protocol

| Edit | Evidence |
| --- | --- |
| Frontmatter, references, or prose only | Parse metadata, resolve links, inspect the diff |
| Workflow guidance | Representative read-only decision scenarios |
| Executable examples | Focused run/type check when tooling exists |
| High-impact policy | Scenarios plus independent review where available |

A scenario trial may be unavailable because a model, fixture, or tool is unavailable. Record it as **blocked**, with the reason. Do not manufacture failures, describe a dry reading as live execution, or require a deployment for every edited skill.

## Scenario record

For each trial, record:

```text
Loaded guidance: paths and relevant version/state
Model/role: requested model and observed availability
Prompt and fixture: exact task, disposable/read-only fixture details
Expected decision: outcome and safeguard being tested
Observed actions: questions, proposed edits/checks, and result
Limitations: stubs, unavailable tools, or unexecuted steps
```

Use disposable fixtures for action trials. Stub remote Git, personal APIs, and destructive commands. A shared filesystem is not isolated merely because a subagent has a fresh context.

## Representative decisions

Include only scenarios relevant to the change. Useful cases include:

- A small authorized typo fix: focused edit/check, no approval parade or commit when forbidden.
- Tests added after existing code: preserve the code, add characterization or regression evidence, and disclose the missing historical red step.
- An unrelated baseline failure: retain evidence, verify the requested area, and do not repair unrelated code.
- A destructive suggestion with dirty work: avoid it unless the exact action is authorized.
- An explicit “plan only,” “stop,” or read-only constraint: honor it despite workflow guidance.
- A material unresolved scope choice: investigate precedent and ask only the question that changes the outcome.

## Reviewing results

Check that the agent used the instruction hierarchy, chose evidence proportionate to risk, preserved user work, and reported limitations accurately. A correct result can use a different safe sequence than the author expected. Improve ambiguous wording or examples that led to a poor outcome; do not add coercive language merely to force a preferred answer.

## Historical note

Older pressure-test campaigns sometimes used time, authority, and sunk-cost prompts to measure rule compliance. Those observations are historical test material, not a directive to resist an explicit user request or delete valid work.
