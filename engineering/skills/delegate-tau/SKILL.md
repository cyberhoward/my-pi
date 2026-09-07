---
name: delegate-tau
description: Use only when the user explicitly requests or authorizes delegation to Tau via a GitHub issue
---

# Delegate Tau

## Overview

When explicitly requested or authorized, create a GitHub issue in the current repo and assign GitHub user `mytau`. Use `gh` first. Do not invoke this skill merely because work is unresolved, deferred, or open-ended. Match issue depth to the authorized request: open-ended delegation stays lightweight; direct invocation gets categorized and structured.

## Invocation Modes

| Mode | Trigger | Issue style |
| --- | --- | --- |
| Delegation | “delegate this to Tau”, “Tau should look at this”, or another explicit authorization | Open-ended investigation issue. Include available context, avoid deep research, avoid over-scoping. |
| Direct | `/skill:delegate-tau ...`, “create a Tau issue for ...” | Categorized issue with the best standard label and useful fields for that category. Infer category; ask only if essential info is missing. |

## Required Workflow

The user’s explicit request to delegate authorizes this issue and its necessary label setup, but not unrelated external mutations.

1. Confirm you are in a git repo with a GitHub remote: `git remote -v`.
2. Draft the body in a temp file. Do not put multiline bodies directly in shell args.
3. Ensure required labels exist before use. Create missing standard labels with `gh label create`.
4. Create the issue with `gh issue create --title ... --body-file ... --assignee mytau --label ...`.
5. Verify the issue exists and `mytau` is assigned, then report the issue URL.

If `gh` is unavailable or unauthenticated, stop and tell the user the exact blocker and command to fix it. Do not silently fall back to another tracker.

## Standard Labels

Use existing repo labels when equivalent labels already exist. Otherwise create these as needed:

| Label | Description | Color |
| --- | --- | --- |
| `bug` | Unexpected problem or unintended behavior | `d73a4a` |
| `feature` | New product capability or user-facing behavior | `a2eeef` |
| `enhancement` | Improvement to existing behavior | `84b6eb` |
| `documentation` | Docs, guides, comments, or contributor instructions | `0075ca` |
| `security` | Vulnerability, authz/authn risk, privacy, abuse, secrets | `b60205` |
| `ci/cd` | Build, test, deploy, pipeline, release automation | `5319e7` |
| `performance` | Latency, throughput, memory, bundle size, scaling | `fbca04` |
| `ux` | User experience, flows, copy, accessibility, visual behavior | `c5def5` |
| `tech debt` | Maintainability, refactor, cleanup, architectural debt | `fef2c0` |
| `discovery` | Unknown scope; investigation or product/technical research needed | `d4c5f9` |
| `question` | Needs clarification before action | `d876e3` |
| `help wanted` | External help or owner input requested | `008672` |

GitHub defaults include `bug`, `documentation`, `enhancement`, `question`, and `help wanted`; do not duplicate them with synonyms if present.

## Body Templates

### Delegation Mode: Open-Ended Investigation

Use this when scope is unclear. Do not dig for root cause. Do not prescribe the solution.

```md
## Summary

[One or two sentences describing the unresolved task or concern.]

## Available context

- [Facts already known]
- [Relevant files/routes/log snippets only if already available]
- [Why this is worth delegating]

## What Tau should investigate

- [Open question 1]
- [Open question 2]
- [Risk/impact area]

## Expected output

Please comment with findings, likely scope, recommended next steps, and any follow-up issues or PR plan.
```

Recommended labels: `discovery` plus one domain label (`bug`, `feature`, `security`, `ci/cd`, etc.).

### Direct Mode: Categorized Issue

Infer the most relevant category and include the matching fields. Ask the user only when an essential field is impossible to infer, such as “which repo?”—but this skill uses the current git repo, so that should be rare.

| Category | Include useful information |
| --- | --- |
| `bug` | Expected vs actual behavior, reproduction steps if known, environment, frequency, impact, suspected area without overclaiming. |
| `feature` | User problem, desired outcome, target user, constraints, rough acceptance criteria, non-goals if known. |
| `enhancement` | Current behavior, proposed improvement, benefit, compatibility constraints, acceptance hints. |
| `security` | Affected surface, risk, evidence, safe reproduction notes, impact, confidentiality warning. Avoid publishing secrets or exploit details beyond what is safe. |
| `ci/cd` | Workflow/job/deploy target, failing step, relevant log excerpt, trigger branch/event, expected pipeline behavior, recent related changes. |
| `performance` | Slow path/resource, baseline vs observed if known, user impact, measurement method, suspected bottleneck. |
| `ux` | User journey, confusing/painful moment, expected experience, screenshots/URLs if already available, accessibility concerns. |
| `documentation` | Audience, missing/confusing doc, desired location, source-of-truth links. |
| `tech debt` | Problematic area, maintenance cost, risk of not addressing, proposed direction without forcing implementation. |

## Commands

```bash
# Inspect labels
gh label list --limit 200

# Create missing labels as needed
gh label create "ci/cd" --description "Build, test, deploy, pipeline, release automation" --color "5319e7"

# Create issue
gh issue create \
  --title "Investigate flaky staging deploy after Prisma migrations" \
  --body-file /tmp/delegate-tau-issue.md \
  --assignee mytau \
  --label "ci/cd" \
  --label "bug"
```

If assignment fails because `mytau` is not a collaborator, create the issue unassigned only after reporting the assignment failure to the user and asking how to proceed. Never substitute another username for `mytau`.

## Common Mistakes

| Mistake | Fix |
| --- | --- |
| Doing a full investigation before filing a delegation issue | For delegation mode, use only available context and stop. Tau owns investigation. |
| Creating a detailed implementation plan for unclear work | Write open questions and expected findings instead. |
| Forgetting `--assignee mytau` | Assignment is the point of the skill; verify it. |
| Using the wrong repo | Always use the current git repo and verify its GitHub remote. |
| Label sprawl | Prefer the standard labels above; reuse equivalent existing labels. |
| Publishing sensitive security details | Summarize risk safely; omit secrets, tokens, private data, and weaponized steps. |

## Final Response

Report only: issue title, URL/number, labels, and whether `mytau` was assigned.
