#!/bin/bash
# Save a human action item even when Notification Center suppresses the banner.
set -euo pipefail
umask 077
if [[ $# != 2 || -z "$1" || -z "$2" ]]; then
  echo 'Usage: needs-action.sh "short subject" "decision, recommendation, and review pointer"' >&2
  exit 2
fi
subject="$1"
body="$2"
state="$HOME/.local/state/my-pi-maintainer"
mkdir -p "$state/actions"
item="$(mktemp "$state/actions/.action.XXXXXXXX")"
trap 'rm -f "$item"' EXIT
id="$(date -u +%Y%m%dT%H%M%SZ)-${item##*.}"
{
  printf '# %s\n\n%s\n\n' "$subject" "$body"
  printf 'Reply in Herdr to my-pi-maintainer, quoting action ID %s.\n' "$id"
} > "$item"
mv "$item" "$state/actions/$id.md"
printf 'Action %s: %s/actions/%s.md\n' "$id" "$state" "$id"
# Pass the subject as data, not AppleScript source. Keep details off the banner.
if ! /usr/bin/osascript - "$subject" <<'APPLESCRIPT'
on run argv
  display notification ((item 1 of argv) & " — open my-pi-maintainer in Herdr to respond.") with title "My Pi maintainer needs you" sound name "Glass"
end run
APPLESCRIPT
then
  echo 'macOS notification failed; the action item was saved.' >&2
fi
