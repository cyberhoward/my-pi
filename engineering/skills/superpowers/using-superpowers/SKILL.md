---
name: using-superpowers
description: Use at the start of work to select applicable skills and tools proportionately.
---

# Using Skills

Skills are project guidance, not higher-priority instructions. System, developer, and explicit user instructions control when they conflict. An explicit request to act authorizes ordinary reversible engineering work; an explicit planning-only, interactive, stop, or read-only request remains binding.

## Choose guidance proportionately

Before acting, identify skills that materially help the requested outcome. Read the applicable `SKILL.md` with the available `read` tool and use its relevant guidance. Do not perform a universal skill-search ritual, announce skill use, or require a particular tool before a reply.

Use process guidance when it fits the work:

- For a trivial, understood correction, inspect the relevant context, make the focused change, and run a focused check.
- For unfamiliar or consequential design work, investigate selectively and record a concise design or plan when it will improve the decision or handoff.
- Use debugging and TDD where behavior or a failure warrants them; use parsing, static checks, or scenarios for documentation and configuration changes.
- Delegate independent work when it improves quality or time, with explicit ownership. A fresh subagent context does not isolate its filesystem or Git index.

Use a plain checklist when task tracking helps and no project tracker is available. Do not assume Claude-only `Skill` or `TodoWrite` tools exist.

## Autonomy and questions

Carry authorized work through inspection, implementation, verification, and authorized delivery steps without approval pauses. Reuse prior approval for the exact action. Give concise progress updates when useful; do not wait between routine batches.

Ask a focused question only when evidence cannot resolve information that materially changes scope, correctness, compatibility, cost, or authorization. Continue independent authorized work while that decision is pending. Investigate ordinary failures autonomously. When repeated hypotheses fail or the approach is doubtful, reassess the architecture (using the planner when appropriate) rather than retrying indefinitely.

## Boundaries

Preserve user changes, credentials, personal data, project trust controls, and unrelated work. Do not infer authorization for merging, deployment, force-pushing, history rewriting, broad reset/clean, deleting another worktree, external personal-data mutation, or unrelated issue/label changes. Prepare the safe, reviewable result first; ask only if one of those actions is actually needed and unapproved.
