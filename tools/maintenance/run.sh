#!/bin/bash
# Local macOS scheduler entry point. The primary checkout is never edited.
set -euo pipefail
export PATH="$HOME/.local/bin:$HOME/.pi/agent/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
export PI_PROGRAM_STATUS=1
umask 077

repo="$(cd "$(dirname "$0")/../.." && pwd -P)"
state="$HOME/.local/state/my-pi-maintainer"
worktree="$state/worktree"
name=my-pi-maintainer
branch=maintenance/my-pi
hc="$HOME/.local/bin/hc"
pi="$HOME/.local/bin/pi"
prompt="Run the scheduled maintenance pass. Read $repo/docs/maintenance.md and follow its maintainer runbook. Use $worktree for repo changes and $state/inbox for skill requests. Leave a concise summary in this Herdr session."

case "${1:-}" in
  '') ;;
  --smoke)
    prompt='Scheduler smoke test only. Do not inspect inbox contents, change files, or perform maintenance. Reply with exactly MAINTAINER_READY.'
    ;;
  *) echo 'Usage: run.sh [--smoke]' >&2; exit 2 ;;
esac

mkdir -p "$state"
# launchd serializes its own invocations; also serialize direct local invocations.
lock="$state/launch.lock"
if ! mkdir "$lock" 2>/dev/null; then
  echo "Launch lock exists: $lock. If no launcher is running, remove the empty lock directory." >&2
  exit 1
fi
trap 'rmdir "$lock"' EXIT

# A lookup failure other than not_found must not launch a second writer.
if info="$("$hc" get "$name" 2>&1)"; then
  status="$(jq -r '.status.state // ""' <<<"$info")"
  if [[ "$(jq -r '.cwd' <<<"$info")" != "$worktree" ]]; then
    echo "Refusing to message $name: unexpected launch directory." >&2
    exit 1
  fi
  if [[ "$(jq -r '.state' <<<"$info")" == live ]]; then
    address="$(jq -er '.address' <<<"$info")"
    case "$status" in
      idle) "$hc" send --if idle "$address" "$prompt" ;;
      # hc 0.1.21 has no --if done; it still refuses blocked input.
      done) "$hc" send "$address" "$prompt" ;;
      *) echo "Skipping $name: state is ${status:-unknown}; inspect it in Herdr." ;;
    esac
    exit
  fi
elif ! jq -e '.error.kind == "not_found"' <<<"$info" >/dev/null; then
  printf '%s\n' "$info" >&2
  exit 1
fi

if [[ ! -e "$worktree/.git" ]]; then
  if git -C "$repo" show-ref --verify --quiet "refs/heads/$branch"; then
    git -C "$repo" worktree add "$worktree" "$branch"
  else
    git -C "$repo" worktree add -b "$branch" "$worktree" main
  fi
fi
if [[ "$(git -C "$worktree" symbolic-ref --short HEAD)" != "$branch" ||
      "$(git -C "$worktree" rev-parse --path-format=absolute --git-common-dir)" != "$(git -C "$repo" rev-parse --path-format=absolute --git-common-dir)" ]]; then
  echo "Refusing to use unexpected worktree: $worktree" >&2
  exit 1
fi

# Follow the reviewed planner pin on main on each fresh launch, not an
# unreviewed proposal in the maintenance branch.
model="$(git -C "$repo" show main:engineering/agents/planner.md | awk '/^model: / {print $2}')"
[[ -n "$model" ]] || { echo 'Planner model pin not found.' >&2; exit 1; }
# Use the reviewed skill and its installed dependencies from the primary
# checkout. A login shell supplies Robin's existing environment to Pi without
# putting API keys into argv, launchd config, or Herdr terminal metadata.
"$hc" run --bg --json --no-parent --name "$name" --cwd "$worktree" -- \
  /bin/zsh -lc 'export PI_PROGRAM_STATUS=1; exec "$@"' my-pi-maintainer \
  "$pi" --model "$model" --skill "$repo/general/skills/brave-search" "$prompt"
