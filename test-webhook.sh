#!/bin/bash

# Load env vars
set -a
source .env
set +a

# Build the payload (Facebook wraps it in entry/changes)
PAYLOAD='{
  "object": "page",
  "entry": [{
    "id": "'"$META_PAGE_ID"'",
    "time": 1769925235,
    "changes": [{
      "field": "feed",
      "value": {
        "item": "status",
        "post_id": "'"$META_PAGE_ID"'_444444444",
        "verb": "add",
        "published": 1,
        "created_time": 1769925235,
        "message": "Example post content. #discord",
        "from": {
          "name": "Test Page",
          "id": "'"$META_PAGE_ID"'"
        }
      }
    }]
  }]
}'

# Generate signature
SIGNATURE=$(echo -n "$PAYLOAD" | openssl dgst -sha256 -hmac "$META_APP_SECRET" | awk '{print $2}')

echo "Payload:"
echo "$PAYLOAD" | jq .
echo ""
echo "Signature: sha256=$SIGNATURE"
echo ""
echo "Sending to http://localhost:3000/meta/webhook ..."
echo ""

# Send it
curl -s -X POST http://localhost:3000/meta/webhook \
  -H "Content-Type: application/json" \
  -H "X-Hub-Signature-256: sha256=$SIGNATURE" \
  -d "$PAYLOAD" | jq . 2>/dev/null || cat

echo ""
