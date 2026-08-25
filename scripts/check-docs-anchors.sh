#!/usr/bin/env bash
# Every /docs#anchor the API hands back in an error must exist on the docs page.
# A docs link in an error message that scrolls nowhere is worse than no link: it
# tells the reader there is an answer and then does not give it to them.
set -euo pipefail
cd "$(dirname "$0")/.."
fail=0
for a in $(grep -rhoE "'/docs#[a-z-]+'" src/ | tr -d "'" | sed 's|/docs#||' | sort -u); do
  if grep -qE "id=\"$a\"|id='$a'" public/docs.html 2>/dev/null; then
    printf '  ok   #%s\n' "$a"
  else
    printf '  MISS #%s  (referenced by the API, absent from public/docs.html)\n' "$a"
    fail=1
  fi
done
[ "$fail" = 0 ] && echo "all docs anchors resolve" || { echo "some anchors do not resolve"; exit 1; }
