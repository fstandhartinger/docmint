#!/usr/bin/env bash
# Tears down everything DocMint created. See ops/INFRASTRUCTURE.md.
#
#   ops/reap.sh --list      show it all and what it costs, change nothing
#   ops/reap.sh --suspend   stop the Render service billing, keep the data
#   ops/reap.sh --destroy   delete the Render service and the Neon project
#
# Needs RENDER_API_KEY. --destroy also needs NEON_API_KEY, and says so if it is
# missing rather than silently leaving the database behind.
set -euo pipefail

SERVICE_ID="srv-da6l2s61egvs7394d030"
NEON_PROJECT="fragrant-credit-25886270"
R="https://api.render.com/v1"

die() { echo "$*" >&2; exit 1; }
[ -n "${RENDER_API_KEY:-}" ] || die "RENDER_API_KEY is not set."

render() { curl -sf -H "Authorization: Bearer $RENDER_API_KEY" "$@"; }

list() {
  echo "== Render: every service on this account, not just ours =="
  render "$R/services?limit=100" | SERVICE_ID="$SERVICE_ID" python3 -c '
import sys, json, os
rows = json.load(sys.stdin)
price = {"free": 0.0, "starter": 7.0, "standard": 25.0, "pro": 85.0}
mine_id = os.environ["SERVICE_ID"]
total = 0.0
for row in rows:
    s = row["service"]
    plan = s.get("serviceDetails", {}).get("plan", "?")
    susp = s.get("suspended", "")
    cost = 0.0 if susp == "suspended" else price.get(plan, 0.0)
    total += cost
    mine = " <-- DocMint" if s["id"] == mine_id else ""
    print("  %-28s %-26s %-10s %-12s $%6.2f%s" % (s["name"], s["id"], plan, susp, cost, mine))
print("  %-66s $%6.2f/month" % ("TOTAL RUNNING", total))
'
  echo
  echo "== Neon: project $NEON_PROJECT (free tier, \$0.00) =="
  if [ -n "${NEON_API_KEY:-}" ]; then
    curl -sf -H "Authorization: Bearer $NEON_API_KEY" \
      "https://console.neon.tech/api/v2/projects/$NEON_PROJECT" \
      | python3 -c 'import sys,json;p=json.load(sys.stdin)["project"];print("  %s  %s  %s" % (p["name"], p["id"], p["region_id"]))' \
      || echo "  (could not read it; the id above is what to delete)"
  else
    echo "  NEON_API_KEY not set - cannot query. Project id: $NEON_PROJECT"
  fi
  echo
  echo "== npm: n8n-nodes-docmint - deliberately NOT reaped =="
  echo "  Unpublishing breaks everyone who installed it, and npm refuses after 72h."
}

case "${1:---list}" in
  --list) list ;;
  --suspend)
    list; echo
    read -r -p "Suspend the Render service $SERVICE_ID? Billing stops, data is kept. [y/N] " a
    [ "$a" = "y" ] || die "Nothing changed."
    render -X POST "$R/services/$SERVICE_ID/suspend" >/dev/null && echo "Suspended."
    ;;
  --destroy)
    list; echo
    echo "This will PERMANENTLY delete:"
    echo "  - Render web service $SERVICE_ID (docmint)"
    echo "  - Neon project $NEON_PROJECT, and every template and account in it"
    echo "It will NOT unpublish the npm package."
    read -r -p "Type DESTROY to confirm: " a
    [ "$a" = "DESTROY" ] || die "Nothing changed."
    render -X DELETE "$R/services/$SERVICE_ID" >/dev/null && echo "Render service deleted."
    if [ -n "${NEON_API_KEY:-}" ]; then
      curl -sf -X DELETE -H "Authorization: Bearer $NEON_API_KEY" \
        "https://console.neon.tech/api/v2/projects/$NEON_PROJECT" >/dev/null \
        && echo "Neon project deleted."
    else
      echo "NEON_API_KEY not set: the Neon project is STILL THERE."
      echo "Delete it at https://console.neon.tech/app/projects/$NEON_PROJECT"
    fi
    ;;
  *) die "Usage: ops/reap.sh [--list|--suspend|--destroy]" ;;
esac
