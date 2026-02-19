#!/bin/sh
# explore.sh - run this BEFORE starting your API key timer
# Usage: sh explore.sh YOUR_API_KEY

BASE="http://datasync-dev-alb-101078500.us-east-1.elb.amazonaws.com/api/v1"
KEY=$1

echo "=============================================="
echo "DataSync API Explorer"
echo "=============================================="

echo "\n=== API Root: discover available endpoints ==="
curl -s "$BASE" | jq .

echo "\n=== Events default: understand base pagination and response shape ==="
curl -s -D - -H "X-API-Key: $KEY" "$BASE/events" | head -40

echo "\n=== Events max limit: discover the maximum page size allowed ==="
curl -s -D - -H "X-API-Key: $KEY" "$BASE/events?limit=10000" | head -40

echo "\n=== Bulk default: confirm bulk endpoint exists and see response shape ==="
curl -s -D - -H "X-API-Key: $KEY" "$BASE/events/bulk" | head -40

echo "\n=== Bulk max limit: discover the maximum bulk page size ==="
curl -s -D - -H "X-API-Key: $KEY" "$BASE/events/bulk?limit=99999" | head -40

echo "\n=== Metrics: get total event count and dataset info ==="
curl -s -H "X-API-Key: $KEY" "$BASE/metrics" | jq .

echo "\n=== Sessions: explore undocumented endpoint for hidden data ==="
curl -s -H "X-API-Key: $KEY" "$BASE/sessions" | jq .

echo "\n=== Export: check if a faster export endpoint exists ==="
curl -s -D - -H "X-API-Key: $KEY" "$BASE/events/export" | head -20

echo "\n=== Stream: check if a streaming endpoint exists ==="
curl -s -D - -H "X-API-Key: $KEY" "$BASE/events/stream" | head -20

echo "\n=== Bulk POST: check if bulk accepts POST with a body ==="
curl -s -X POST \
  -H "X-API-Key: $KEY" \
  -H "Content-Type: application/json" \
  -d '{"limit": 5000}' \
  "$BASE/events/bulk" | head -20

echo "\n=== Rate limit test: fire 5 rapid requests to discover rate limit headers ==="
for i in 1 2 3 4 5; do
  curl -s -D - -H "X-API-Key: $KEY" "$BASE/events/bulk?limit=1" | grep -E "X-RateLimit|Retry-After|HTTP"
done

echo "\n=============================================="
echo "Exploration complete. Check output above for:"
echo "  - X-RateLimit-Limit    → set WORKERS to this"
echo "  - X-RateLimit-Remaining → confirms rate limit window"
echo "  - X-Total-Count        → total events to ingest"
echo "  - pagination field names → update index.ts if different"
echo "  - max bulk page size   → set BULK_PAGE_SIZE to this"
echo "=============================================="