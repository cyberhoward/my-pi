---
name: finishing-a-development-branch
description: Use to complete authorized branch delivery while preserving evidence and worktrees.
---

# Finishing a Development Branch

Finish the delivery steps already authorized by the user. Do not present a mandatory menu or ask again for an exact action that is already approved.

## Verify and assess

Run project-appropriate checks for the changed behavior and inspect the diff. Reuse still-valid evidence; rerun checks after changes that invalidate it. Record commands, results, revision/state, and limitations.

A failing baseline does not automatically block delivery. Preserve its evidence, determine whether it is unrelated, and disclose it alongside focused passing checks. Investigate new relevant failures. When the environment prevents meaningful verification, report the work as unverified or blocked; do not claim that all tests pass.

## Deliver according to authorization

- If commit, push, and PR creation are authorized, determine the existing branch/base from repository evidence, make a scoped commit, push normally, create or update one PR, verify its URL, and retain the worktree for review.
- If the user asked to keep the branch, report its name and worktree path.
- Merge only with explicit merge authorization. Verify the merged result with appropriate checks.
- Do not force-push, rewrite history, discard work, delete branches, or remove worktrees unless the user explicitly authorized that exact destructive action.

Before any destructive cleanup, show the named scope and preserve unrelated dirty work. If cleanup is necessary but unapproved, ask a focused authorization question after completing safe work.

## Report

State the changed files, verification evidence, baseline limitations, branch/PR result when applicable, and remaining blockers. A ready-for-review assessment never authorizes merge, deployment, or cleanup.
