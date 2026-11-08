#!/usr/bin/env bash
# Create the cache-bypass rule for the public files host, idempotently (design "Capacity, cost, and public abuse
# budgets": status.json and public files must never be served stale from the edge cache).
#
#   rf-files-bypass  Bypass cache for every request to files.researchforce.org.
#
# Usage: tools/setup-cache-bypass.sh <zone-id> [host]
# Asks for a Cloudflare API token with "Zone > Cache Rules > Edit" on that zone. The token is read without echo, used
# only for these calls, and never printed or saved. Prints the ruleset and rule ids (not secrets).
set -euo pipefail

ZONE="${1:?Usage: tools/setup-cache-bypass.sh <zone-id> [host]}"
HOST="${2:-files.researchforce.org}"
API="https://api.cloudflare.com/client/v4"
PHASE="http_request_cache_settings"
DESC="rf-files-bypass"

printf 'Paste the Cloudflare API token (input hidden), then press Enter: '
IFS= read -rs TOKEN
echo
[ -n "$TOKEN" ] || { echo "No token entered." >&2; exit 1; }

call() { # method path [json-body]
  if [ $# -ge 3 ]; then
    curl -sS -X "$1" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data "$3" "$API$2"
  else
    curl -sS -X "$1" -H "Authorization: Bearer $TOKEN" "$API$2"
  fi
}

RULE=$(python3 -c 'import json,sys; print(json.dumps({"description":sys.argv[1],"expression":"(http.host eq \"%s\")" % sys.argv[2],"action":"set_cache_settings","action_parameters":{"cache":False},"enabled":True}))' "$DESC" "$HOST")

ENTRY=$(call GET "/zones/$ZONE/rulesets/phases/$PHASE/entrypoint")
if echo "$ENTRY" | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("success") else 1)'; then
  RULESET=$(echo "$ENTRY" | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["id"])')
  EXISTING=$(echo "$ENTRY" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(next((r["id"] for r in d["result"].get("rules",[]) if r.get("description")==sys.argv[1]),""))' "$DESC")
  if [ -n "$EXISTING" ]; then
    RULE_ID=$EXISTING
  else
    ADDED=$(call POST "/zones/$ZONE/rulesets/$RULESET/rules" "$RULE")
    RULE_ID=$(echo "$ADDED" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("success"), d.get("errors"); print(next(r["id"] for r in d["result"]["rules"] if r.get("description")==sys.argv[1]))' "$DESC")
  fi
else
  # No cache-rules entrypoint yet: create it with the one rule.
  CREATED=$(call PUT "/zones/$ZONE/rulesets/phases/$PHASE/entrypoint" "{\"rules\":[$RULE]}")
  if ! echo "$CREATED" | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("success") else 1)'; then
    echo "Could not create the cache rule. Check the token has Zone > Cache Rules > Edit on this zone." >&2
    echo "$CREATED" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("errors"))' >&2
    exit 1
  fi
  RULESET=$(echo "$CREATED" | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["id"])')
  RULE_ID=$(echo "$CREATED" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(next(r["id"] for r in d["result"]["rules"] if r.get("description")==sys.argv[1]))' "$DESC")
fi
unset TOKEN

echo
echo "Done. $HOST now bypasses the edge cache."
echo "CACHE_RULESET_ID=$RULESET"
echo "CACHE_RULE_ID=$RULE_ID"
