import { Pool } from "pg";

const API_BASE = process.env.API_BASE_URL || "http://assignment-fake-api:3000/api/v1";
const EVENTS_ENDPOINT = `${API_BASE}/events`;
const API_KEY = process.env.API_KEY || "dev-key-123";
const WORKERS = parseInt(process.env.WORKER_CONCURRENCY || "5");
const PAGE_SIZE = parseInt(process.env.BATCH_SIZE || "5000");

// Shared state
let finished = false;
let totalEvents = 0;
let rateLimitedUntil = 0;

// Cursor queue - workers pick cursors from here
const cursorQueue: (string | null)[] = [null]; // null = first page
let queueIndex = 0;

const pool = new Pool({
  host: process.env.DB_HOST || "assignment-postgres",
  user: process.env.DB_USER || "postgres",
  password: process.env.DB_PASSWORD || "postgres",
  database: process.env.DB_NAME || "events",
  port: parseInt(process.env.DB_PORT || "5432"),
  max: WORKERS
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// -------------------------------------------------------
// DB CONNECTION WITH RETRY
// -------------------------------------------------------
async function connectWithRetry(retries = 10, delayMs = 2000): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      await pool.query("SELECT 1");
      console.log("✓ Database connected");
      return;
    } catch (err) {
      console.log(`Database not ready, retrying in ${delayMs}ms... (${i + 1}/${retries})`);
      await sleep(delayMs);
    }
  }
  throw new Error("Could not connect to database after retries");
}

// -------------------------------------------------------
// TIMESTAMP NORMALIZATION
// Real API returns mixed formats
// -------------------------------------------------------
function normalizeTimestamp(raw: string | number): Date {
  if (typeof raw === "number") {
    // Unix milliseconds
    return raw > 1e12 ? new Date(raw) : new Date(raw * 1000);
  }

  const str = String(raw);

  // Unix seconds (10 digits)
  if (/^\d{10}$/.test(str)) return new Date(parseInt(str) * 1000);

  // Unix milliseconds (13 digits)
  if (/^\d{13}$/.test(str)) return new Date(parseInt(str));

  // ISO with space instead of T
  if (str.includes(" ") && !str.includes("T")) return new Date(str.replace(" ", "T"));

  // Standard ISO
  return new Date(str);
}

// -------------------------------------------------------
// DATABASE INIT
// -------------------------------------------------------
async function initDatabase(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS events (
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
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS checkpoint (
      id          INTEGER PRIMARY KEY DEFAULT 1,
      next_cursor TEXT,
      total_events INTEGER,
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    INSERT INTO checkpoint (id, next_cursor)
    VALUES (1, NULL)
    ON CONFLICT DO NOTHING;
  `);

  console.log("✓ Database initialized");
}

// -------------------------------------------------------
// CHECKPOINT
// -------------------------------------------------------
async function loadCheckpoint(): Promise<void> {
  const result = await pool.query(
    "SELECT next_cursor, total_events FROM checkpoint WHERE id = 1"
  );

  const row = result.rows[0];
  totalEvents = row.total_events || 0;

  if (row.next_cursor) {
    cursorQueue[0] = row.next_cursor;
    console.log(`Resuming from saved cursor`);
  } else {
    console.log("Starting fresh ingestion");
  }
}

async function saveCheckpoint(cursor: string | null, total: number): Promise<void> {
  await pool.query(
    `UPDATE checkpoint
     SET next_cursor = $1, total_events = $2, updated_at = NOW()
     WHERE id = 1`,
    [cursor, total]
  );
}

// -------------------------------------------------------
// FETCH PAGE WITH CURSOR
// -------------------------------------------------------
async function fetchPage(cursor: string | null): Promise<any> {
  const waitMs = rateLimitedUntil - Date.now();
  if (waitMs > 0) await sleep(waitMs);
 // Throttle to stay within rate limit
  await sleep(6000);
  
  const url = cursor
    ? `${EVENTS_ENDPOINT}?limit=${PAGE_SIZE}&cursor=${cursor}`
    : `${EVENTS_ENDPOINT}?limit=${PAGE_SIZE}`;

  const batchStart = Date.now();

  let response: Response;

  try {
    response = await fetch(url, {
      headers: { "X-API-Key": API_KEY }
    });
  } catch (err) {
    // Network error - retry after delay
    console.warn(`Network error, retrying in 5s...`, err);
    await sleep(5000);
    return fetchPage(cursor);
  }

  // Rate limited
  if (response.status === 429) {
    const retryAfter = parseInt(response.headers.get("Retry-After") || "52");
    console.warn(`[rate limit] pausing all workers for ${retryAfter}s`);
    rateLimitedUntil = Date.now() + retryAfter * 1000 + 500;
    await sleep(retryAfter * 1000 + 500);
    return fetchPage(cursor);
  }

  // Cursor expired or invalid
 if (response.status === 400) {
  console.warn(`Cursor expired, clearing checkpoint and restarting from beginning...`);
  await pool.query("UPDATE checkpoint SET next_cursor = NULL WHERE id = 1");
  // Reset cursor queue to start fresh
  cursorQueue.length = 0;
  cursorQueue.push(null);
  queueIndex = 0;
  return fetchPage(null); // restart from beginning
}

  // Temporary server errors - retry
  if (response.status === 502 || response.status === 503 || response.status === 504) {
    console.warn(`Server error ${response.status}, retrying in 5s...`);
    await sleep(5000);
    return fetchPage(cursor);
  }

  // Any other error
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching cursor ${cursor}`);
  }

  const json = await response.json();

  // Learn total from meta
  if (json.meta?.total && !totalEvents) {
    totalEvents = json.meta.total;
    console.log(`Total events discovered: ${totalEvents}`);
  }

  const duration = (Date.now() - batchStart) / 1000;
  const eventsPerSec = Math.round((json.data?.length || 0) / duration);
  console.log(`Fetched ${json.data?.length} events | ${eventsPerSec} events/sec`);

  return json;
}
  

// -------------------------------------------------------
// BATCH INSERT
// -------------------------------------------------------
async function insertEvents(events: any[]): Promise<void> {
  if (events.length === 0) return;

  const values: any[] = [];
  const placeholders = events.map((e, i) => {
    const base = i * 8;
    const ts = normalizeTimestamp(e.timestamp);

    values.push(
      e.id,
      e.sessionId,
      e.userId,
      e.type,
      e.name,
      JSON.stringify(e.properties),
      ts.toISOString(),
      JSON.stringify(e.session)
    );

    return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8})`;
  });

  await pool.query(
    `INSERT INTO events (id, session_id, user_id, type, name, properties, timestamp, session)
     VALUES ${placeholders.join(",")}
     ON CONFLICT (id) DO NOTHING`,
    values
  );
}

// -------------------------------------------------------
// WORKER
// Cursor-based pagination is sequential - only 1 worker
// fetches at a time, but we pipeline fetch+insert
// -------------------------------------------------------
async function worker(id: number): Promise<void> {
  console.log(`Worker ${id} started`);

  while (true) {
    if (finished) return;

    // Claim next cursor from queue
    const myIndex = queueIndex;
    queueIndex++;

    // Wait for cursor to be available
    while (cursorQueue[myIndex] === undefined) {
      await sleep(100);
    }

    const cursor = cursorQueue[myIndex];

    if (cursor === null && myIndex > 0) {
      // null after first page means we're done
      finished = true;
      return;
    }

    try {
      const json = await fetchPage(cursor === null && myIndex === 0 ? null : cursor as string);
      const { data, pagination, meta } = json;

      if (!data || data.length === 0) {
        finished = true;
        return;
      }

      // Queue next cursor for next worker
      const nextCursor = pagination?.nextCursor || null;
      cursorQueue[myIndex + 1] = nextCursor;

      if (!nextCursor) {
        finished = true;
      }

      await insertEvents(data);
      await saveCheckpoint(nextCursor, totalEvents);

      const inserted = await pool.query("SELECT COUNT(*) FROM events");
      const count = parseInt(inserted.rows[0].count);
      const pct = totalEvents ? ((count / totalEvents) * 100).toFixed(1) : "?";

      console.log(`Worker ${id} | +${data.length} events | ${count} total | ${pct}% complete`);

    } catch (err) {
      console.error(`Worker ${id} error:`, err);
      // Put cursor back
      queueIndex = myIndex;
      cursorQueue.splice(myIndex);
      await sleep(2000);
    }
  }
}

// -------------------------------------------------------
// MAIN
// -------------------------------------------------------
async function start(): Promise<void> {
  console.log("=== DataSync Ingestion Starting ===");

  await connectWithRetry();
  await initDatabase();
  await loadCheckpoint();

  // With cursor pagination, workers must be sequential
  // but we use multiple workers to pipeline fetch+insert
  const workers = Array.from({ length: WORKERS }, (_, i) => worker(i));
  await Promise.all(workers);

  const result = await pool.query("SELECT COUNT(*) FROM events");
  console.log(`=== DONE: ${result.rows[0].count} events stored ===`);

  await pool.end();
}

start().catch(console.error);