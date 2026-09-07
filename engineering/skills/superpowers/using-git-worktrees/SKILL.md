---
name: using-git-worktrees
description: Use when isolation is needed for authorized work; create and verify a safe Git worktree.
---

# Using Git Worktrees

Use a worktree when isolation improves safety or parallelism. Do not require one for every change. Reuse an appropriate existing task branch/worktree when safe; preserve dirty user work and never switch branches or remove worktrees casually.

## Select a location deterministically

1. Follow `AGENTS.md` and compatible project guidance.
2. Prefer an existing project convention such as `.worktrees/` or `worktrees/`.
3. If no safe local convention exists, use an external worktree location.

Before creating a project-local worktree, verify the exact path is ignored:

```bash
git check-ignore -q .worktrees/<branch> # or the exact selected path
```

If it is not ignored, choose a safe external location unless changing `.gitignore` is within the requested scope. Do not make an unrelated ignore-file commit merely to create a worktree.

Create the worktree on the authorized branch using project conventions, for example:

```bash
git worktree add <path> -b <branch>
```

Confirm the actual path with `git worktree list` and report it when useful.

## Setup and baseline

Inspect the project’s documented setup and package scripts before running commands. Do not run arbitrary install recipes based only on detected filenames. Capture relevant baseline checks before edits when practical.

If a baseline check fails, save the command and output, determine whether the failure is relevant, and continue safely with focused work when it is demonstrably unrelated. Investigate new relevant failures. If the environment prevents meaningful verification, state what remains unverified rather than claiming readiness.

## Shared workspaces

Fresh agent contexts share the filesystem and Git index unless they use separate worktrees. Assign disjoint files to concurrent workers. In a shared worktree, one coordinator owns staging, commits, branch changes, push, PR creation, and cleanup; workers do not alter the index or another owner’s files. Serialize or reassign overlapping work.

## Safety

Do not delete a worktree, branch, or user changes without explicit authorization for that exact destructive action. A PR worktree is normally retained for review. Check the worktree list before any authorized cleanup.
