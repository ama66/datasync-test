#!/bin/bash
echo "=============================================="
echo "DataSync Ingestion - Running Solution"
echo "=============================================="

echo "Starting services..."
docker compose down -v
docker compose build --no-cache
docker compose up -d

echo ""
echo "Waiting for services to initialize..."
sleep 10

echo ""
echo "Monitoring ingestion progress..."
echo "(Press Ctrl+C to stop monitoring)"
echo "=============================================="

while true; do
    COUNT=$(docker exec assignment-postgres psql -U postgres -d events -t -c "SELECT COUNT(*) FROM events;" 2>/dev/null | tr -d ' ' || echo "0")
    PCT=$(awk "BEGIN {printf \"%.1f\", ($COUNT/3000000)*100}")
    THROUGHPUT=$(docker logs assignment-ingestion 2>&1 | grep "events/sec" | tail -1 2>/dev/null || echo "calculating...")
    WORKER=$(docker logs assignment-ingestion 2>&1 | grep "Worker 0 |" | tail -1 2>/dev/null || echo "starting...")
    ERRORS=$(docker logs assignment-ingestion 2>&1 | grep -c "error" 2>/dev/null || echo "0")
    RATE_LIMITS=$(docker logs assignment-ingestion 2>&1 | grep -c "rate limit" 2>/dev/null || echo "0")
    CONTAINER=$(docker inspect -f '{{.State.Status}}' assignment-ingestion 2>/dev/null || echo "unknown")

    if docker logs assignment-ingestion 2>&1 | grep -q "DONE" 2>/dev/null; then
        echo ""
        echo "=============================================="
        echo "INGESTION COMPLETE!"
        echo "Total events: $COUNT"
        echo "=============================================="
        exit 0
    fi

    echo "----------------------------------------------"
    echo "[$(date '+%H:%M:%S')] Progress"
    echo "  Events    : $COUNT / 3000000 ($PCT%)"
    echo "  Throughput: $THROUGHPUT"
    echo "  Worker    : $WORKER"
    echo "  Errors    : $ERRORS total"
    echo "  RateLimit : $RATE_LIMITS pauses total"
    echo "  Container : $CONTAINER"
    echo "----------------------------------------------"
    sleep 5
done