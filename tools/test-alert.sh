#!/usr/bin/env bash
# Send one test message to the independent alert channel exactly as rf-ops does: a POST with a Bearer token and a
# JSON body (apps/ops/src/independent-channel.ts). The token is read without echo and never printed or saved.
#
# Usage: tools/test-alert.sh [webhook-url]
set -euo pipefail
URL="${1:-https://ntfy.sh/rf-alerts-6505c35861a585092a45314d}"

printf 'Paste the ntfy token (input hidden), then press Enter: '
IFS= read -rs TOKEN
echo
[ -n "$TOKEN" ] || { echo "No token entered." >&2; exit 1; }

BODY='{"kind":"test","message":"Research Force alert channel test"}'
RESPONSE=$(curl -sS -X POST \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "content-type: application/json" \
  --data "$BODY" \
  -w $'\n%{http_code}' \
  "$URL")
unset TOKEN

STATUS="${RESPONSE##*$'\n'}"
DETAIL="${RESPONSE%$'\n'*}"
echo "result $STATUS"
if [ "$STATUS" != "200" ]; then
  echo "The channel refused the test. Its reply was:"
  echo "$DETAIL"
  exit 1
fi
echo "Sent. Check your phone."
