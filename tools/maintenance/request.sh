#!/bin/bash
# Submit a sanitized Markdown proposal on stdin; never send chat transcripts.
set -euo pipefail
umask 077
root="$HOME/.local/state/my-pi-maintainer/inbox"
mkdir -p "$root/pending" "$root/closed"
tmp="$(mktemp "$root/pending/.request.XXXXXXXX")"
trap 'rm -f "$tmp"' EXIT
/bin/cat > "$tmp"
if ! /usr/bin/grep -q '[^[:space:]]' "$tmp" || [[ "$(wc -c < "$tmp")" -gt 16384 ]]; then
  echo 'Provide a nonempty Markdown request of at most 16 KiB on stdin.' >&2
  exit 2
fi
id="$(date -u +%Y%m%dT%H%M%SZ)-${tmp##*.}"
mv "$tmp" "$root/pending/$id.md"
printf '%s\n' "$id"
