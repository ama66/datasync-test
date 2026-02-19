#!/bin/bash
set -e
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
    COUNT=$(docker exec datasync-ts-postgres-1 psql -U postgres -d events -t -c "SELECT COUNT(*) FROM events;" 2>/dev/null | tr -d ' ' || echo "0")

    if docker logs datasync-ts-ingestor-1 2>&1 | grep -q "DONE" 2>/dev/null; then
        echo ""
        echo "=============================================="
        echo "INGESTION COMPLETE!"
        echo "Total events: $COUNT"
        echo "=============================================="
        exit 0
    fi

    echo "[$(date '+%H:%M:%S')] Events ingested: $COUNT"
    sleep 5
done