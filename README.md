# DataSync Ingestion Solution

## How to Run

Prerequisites: Docker and Docker Compose
```bash
git clone https://github.com/yourusername/datasync-test
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
The ingestion system uses a parallel worker architecture:

1. On startup, connects to PostgreSQL and initializes two tables — `events` for storing ingested data and `checkpoint` for tracking progress
2. Loads the last saved offset from the checkpoint table to resume from where it left off
3. Spawns N workers in parallel (configurable via `WORKERS` env var)
4. Each worker claims the next available offset atomically and fetches a batch of events from the bulk endpoint
5. Events are batch inserted into PostgreSQL in a single query
6. Progress is checkpointed after every successful batch
7. If the process crashes, it resumes from the last checkpoint on restart

### Key Design Decisions

**Bulk endpoint over regular endpoint** — discovered `/api/v1/events/bulk` which allows much larger page sizes and offset-based pagination instead of cursor-based. This eliminates cursor expiry issues and enables true parallel fetching.

**Offset claiming pattern** — workers atomically claim offsets from a shared counter. JavaScript's single-threaded event loop makes this race-condition-free without locks.

**Batch inserts** — all events in a batch are inserted in a single SQL query instead of row by row. Dramatically faster for large datasets.

**Shared rate limit backoff** — when any worker hits a 429, a shared `rateLimitedUntil` timestamp signals all workers to pause together instead of hammering the API simultaneously.

**Idempotent inserts** — `ON CONFLICT DO NOTHING` makes inserts safe to retry. If the process crashes after inserting but before checkpointing, the next run safely skips already-inserted events.

## API Discoveries

- `/api/v1/events/bulk` — undocumented bulk endpoint discovered by inspecting the frontend JavaScript bundle. Allows up to N events per request with simple offset-based pagination
- Timestamp formats are inconsistent across events — normalized all formats (ISO, Unix seconds, Unix milliseconds, space-separated ISO) before storing
- Rate limit headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `Retry-After`
- Total event count available via `X-Total-Count` response header
- Header-based auth (`X-API-Key`) preferred over query param auth for best rate limits

## Configuration

All configuration via `.env`:
```bash
API_BASE_URL=   # API base URL
API_KEY=        # Your API key
WORKERS=        # Number of parallel workers (set to rate limit)
BULK_PAGE_SIZE= # Events per request (set to API maximum)
DB_HOST=        # PostgreSQL host
DB_NAME=        # Database name
```

## What I Would Improve With More Time

1. **Dynamic rate limit tuning** — read `X-RateLimit-Limit` from first response and automatically spawn the optimal number of workers
2. **Pipelined fetch/insert** — fetch next batch while inserting current batch to keep both network and database busy simultaneously
3. **Gap detection** — track completed batches individually to detect and fill gaps left by crashed workers
4. **Unit tests** — test timestamp normalization, offset claiming, and rate limit handling
5. **Integration tests** — automated test against the fake API to verify end-to-end correctness
6. **Metrics dashboard** — real-time throughput and progress visualization