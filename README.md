# DataSync Ingestion Solution

## How to Run

Prerequisites: Docker and Docker Compose
```bash
git clone https://github.com/ama66/datasync-test
cd datasync-test
cp .env.example .env
# Update .env with your API key
sh run-ingestion.sh
```

## Architecture Overview

### Tech Stack
- TypeScript + Node.js
- PostgreSQL for event storage and checkpointing
- Docker Compose for orchestration

### How It Works

1. On startup connects to PostgreSQL and initializes two tables — `events` for storing ingested data and `checkpoint` for tracking cursor progress
2. Loads the last saved cursor from the checkpoint table to resume from where it left off
3. Starts a single worker that fetches batches of events using cursor-based pagination
4. Each batch of events is inserted into PostgreSQL in a single bulk query
5. The cursor is checkpointed after every successful batch
6. If the cursor expires on restart, automatically clears the checkpoint and resumes from the beginning — already inserted events are skipped via `ON CONFLICT DO NOTHING`

### Key Design Decisions

**Single worker for cursor pagination** — cursor-based pagination is inherently sequential. Each request depends on the `nextCursor` returned by the previous response, meaning fetches cannot be parallelized. Worker 2 cannot start until Worker 1 has completed and returned the next cursor. Running multiple workers only causes them to queue up and hammer the rate limit simultaneously, triggering 429 responses and long pauses. One worker fetching steadily at a controlled interval is the optimal approach for this API design.

**Rate limit throttling** — a 6 second delay between requests keeps throughput within the API rate limit of 10 requests per window without triggering 429 responses. Without this throttle, requests fire too quickly, exhaust the rate limit, and stall for up to 51 seconds — actually slower than a steady throttled pace.

**Batch inserts** — all events in a batch are inserted in a single SQL query instead of row by row. Dramatically faster for large datasets and reduces database round trips.

**Idempotent inserts** — `ON CONFLICT DO NOTHING` makes inserts safe to retry. If the process crashes and restarts from the beginning, already inserted events are skipped silently without errors.

**Automatic error recovery** — handles all failure scenarios without manual intervention:
- 400 expired cursor → clears checkpoint and restarts from beginning
- 429 rate limit → reads `Retry-After` header and pauses all workers
- 502/503/504 server errors → retries after 5 seconds
- Network failures → retries after 5 seconds

**Header-based auth** — uses `X-API-Key` header instead of query param as recommended by the API for best rate limits.

**Connection pooling** — single shared PostgreSQL connection pool across all workers avoids the overhead of opening and closing connections per request.

## API Discoveries

### Pagination
- The API uses cursor-based pagination via `pagination.nextCursor`
- Cursors expire after ~116 seconds and must be used quickly
- `offset` query parameter is accepted but ignored — always returns from the beginning regardless of value. Confirmed by testing `?offset=0` and `?offset=100` which returned identical results
- No true offset-based pagination support exists on this API

### Bulk Endpoint
- `/api/v1/events/bulk` exists in the frontend JS bundle — discovered by grepping the compiled JavaScript
- GET `/api/v1/events/bulk` returns 404 — the router treats `bulk` as an event ID lookup rather than a separate endpoint
- POST `/api/v1/events/bulk` accepts an `ids` array and has a higher rate limit (20 vs 10) but returns 500 Internal Server Error — unusable in its current state
- No working bulk or offset-based endpoint found after thorough exploration

### Rate Limiting
- GET `/api/v1/events`: 10 requests per window
- POST `/api/v1/events/bulk`: 20 requests per window (endpoint broken)
- `Retry-After` header specifies how long to wait after a 429
- Header auth (`X-API-Key`) preferred over query param auth for best rate limits

### Response Shape
```json
{
  "data": [...],
  "pagination": {
    "limit": 5000,
    "hasMore": true,
    "nextCursor": "...",
    "cursorExpiresIn": 116
  },
  "meta": {
    "total": 3000000,
    "returned": 5000
  }
}
```

### Timestamps
- Inconsistent formats across events
- Some events return timestamp as a Unix milliseconds number
- Others return timestamp as an ISO string
- All normalized to TIMESTAMPTZ before storing in PostgreSQL

## Configuration

All configuration via `.env`:
```bash
# API
API_BASE_URL=http://datasync-dev-alb-101078500.us-east-1.elb.amazonaws.com/api/v1
API_KEY=YOUR_API_KEY_HERE

# Workers
WORKER_CONCURRENCY=1   # must be 1 - cursor pagination is sequential, multiple workers cause rate limit thrashing
BATCH_SIZE=5000        # max events per request - server caps at 5000

# Database
DB_HOST=assignment-postgres
DB_USER=postgres
DB_PASSWORD=postgres
DB_NAME=events
DB_PORT=5432
```

## Database Schema
```sql
CREATE TABLE events (
  id          TEXT PRIMARY KEY,
  session_id  TEXT,
  user_id     TEXT,
  type        TEXT,
  name        TEXT,
  properties  JSONB,
  timestamp   TIMESTAMPTZ,
  session     JSONB,
  ingested_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE checkpoint (
  id           INTEGER PRIMARY KEY DEFAULT 1,
  next_cursor  TEXT,
  total_events INTEGER,
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);
```

## What I Would Improve With More Time

1. **Offset-based pagination** — cursor pagination is inherently sequential and limits throughput to one request at a time. If the API supported true offset-based pagination, multiple workers could fetch different ranges simultaneously and dramatically increase throughput. This was investigated — the `offset` parameter exists but is ignored by the server.

2. **Fix bulk POST endpoint** — POST `/api/v1/events/bulk` has a higher rate limit (20 vs 10). If it worked correctly, a two-phase approach of fetching IDs via cursor then bulk fetching full event details could improve throughput significantly.

3. **Dynamic rate limit tuning** — read `X-RateLimit-Limit` and `X-RateLimit-Reset` headers dynamically and adjust the throttle delay automatically instead of hardcoding 6 seconds. This would make the solution adaptive to any API rate limit.

4. **Smarter checkpointing** — instead of saving the cursor (which expires in 116 seconds), checkpoint by event count. On restart, skip the first N already-ingested events instead of re-processing from the beginning.

5. **Unit tests** — test timestamp normalization, cursor handling, rate limit logic, and batch insert building.

6. **Integration tests** — automated end-to-end test against the fake API to verify correctness before running against the real API.

7. **Metrics dashboard** — real-time throughput and progress visualization beyond console logging.