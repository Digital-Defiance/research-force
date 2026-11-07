#!/usr/bin/env bash
# Create the two PRECREATED, DISABLED WAF custom rules rf-ops toggles (tasks 34.2 and 59.2), idempotently.
#
#   rf-containment-deny  blocks every public research host (apex, www, files, dl, submit) but never the app host.
#                        rf-ops Containment enables it during a confidentiality incident (R24.16, R60.4).
#   rf-submit-block      blocks the public submit host. rf-ops enables it when the Public_Traffic_Budget is
#                        reached (R28.5, R28.6).
#
# Usage: tools/setup-waf-rules.sh <zone-id>
# Asks for a Cloudflare API token with "Zone > Zone WAF > Edit" on that zone. The token is read without echo, used
# only for these calls, and never printed or saved. Prints the ruleset id and both rule ids (not secrets).
set -euo pipefail

ZONE="${1:?Usage: tools/setup-waf-rules.sh <zone-id>}"
API="https://api.cloudflare.com/client/v4"
PHASE="http_request_firewall_custom"

DENY_DESC="rf-containment-deny"
DENY_EXPR='(http.host in {"researchforce.org" "www.researchforce.org" "files.researchforce.org" "dl.researchforce.org" "submit.researchforce.org"})'
SUBMIT_DESC="rf-submit-block"
SUBMIT_EXPR='(http.host eq "submit.researchforce.org")'

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

rule_json() { # description expression
  python3 -c 'import json,sys; print(json.dumps({"description":sys.argv[1],"expression":sys.argv[2],"action":"block","enabled":False}))' "$1" "$2"
}

ENTRY=$(call GET "/zones/$ZONE/rulesets/phases/$PHASE/entrypoint")
if echo "$ENTRY" | python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get("success") else 1)'; then
  RULESET=$(echo "$ENTRY" | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"]["id"])')
else
  CODE=$(echo "$ENTRY" | python3 -c 'import json,sys; e=json.load(sys.stdin).get("errors") or [{}]; print(e[0].get("code",""))')
  if [ "$CODE" = "10003" ] || echo "$ENTRY" | grep -q '"not found"\|could not find'; then
    BODY=$(python3 -c 'import json,sys; print(json.dumps({"rules":[]}))')
    CREATED=$(call PUT "/zones/$ZONE/rulesets/phases/$PHASE/entrypoint" "$BODY")
    RULESET=$(echo "$CREATED" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("success"), d.get("errors"); print(d["result"]["id"])')
    ENTRY=$CREATED
  else
    echo "Could not read the zone's custom rules. Check the token has Zone WAF Edit on this zone." >&2
    echo "$ENTRY" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("errors"))' >&2
    exit 1
  fi
fi

ensure_rule() { # description expression -> prints rule id
  local existing
  existing=$(echo "$ENTRY" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(next((r["id"] for r in d["result"].get("rules",[]) if r.get("description")==sys.argv[1]),""))' "$1")
  if [ -n "$existing" ]; then echo "$existing"; return; fi
  local added
  added=$(call POST "/zones/$ZONE/rulesets/$RULESET/rules" "$(rule_json "$1" "$2")")
  ENTRY=$added
  echo "$added" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d.get("success"), d.get("errors"); print(next(r["id"] for r in d["result"]["rules"] if r.get("description")==sys.argv[1]))' "$1"
}

DENY_ID=$(ensure_rule "$DENY_DESC" "$DENY_EXPR")
SUBMIT_ID=$(ensure_rule "$SUBMIT_DESC" "$SUBMIT_EXPR")
unset TOKEN

echo
echo "Done. Both rules exist and are switched OFF. Paste these lines back (they are not secret):"
echo "RULESET_ID=$RULESET"
echo "DENY_RULE_ID=$DENY_ID"
echo "SUBMIT_RULE_ID=$SUBMIT_ID"
