# Krawl — Design

> Detailed design decisions, patterns, abstractions, and interfaces.

---

## 1. Design Philosophy

The engine is built around four constraints that drive every design decision:

1. **Zero LLM** — extraction logic is deterministic code, not a model call. Reproducible, auditable, offline-capable.
2. **Five dependencies** — `playwright`, `better-sqlite3`, `zod`, `p-limit`, `pdf-parse`. Every extra dependency is a build risk, a security surface, and a maintenance burden.
3. **Single language** — TypeScript only. No Python subprocesses, no shell scripts in the hot path.
4. **Crash-safe by default** — any result written to JSONL and the database before the process exits is never lost.

---

## 2. Design Patterns

### 2.1 Strategy — Mode-Based Worker Selection

The `Router` detects the correct extraction mode per domain once, caches it, and the `Scheduler` dispatches to the matching worker. Adding a new mode requires implementing a worker and registering a detection signal in `router.ts` — the scheduler dispatch loop does not need to change.

```
TaskMode = "auto" | "http_json" | "http_curl" | "browser" | "crawl" | "blocked"
```

### 2.2 Worker Pool — p-limit Semaphore

Each worker type uses `p-limit` to bound concurrency. Limits are independent: exhausting browser slots does not block HTTP slots. This allows the engine to keep all three pools draining simultaneously without one type starving the others.

```typescript
// Each pool owns its own limiter instance
const httpLimit    = pLimit(DEFAULTS.HTTP_CONCURRENCY);   // 5
const browserLimit = pLimit(DEFAULTS.BROWSER_CONCURRENCY); // 3
const crawlLimit   = pLimit(DEFAULTS.CRAWL_CONCURRENCY);   // 2
```

### 2.3 Circuit Breaker — Per-Domain State Machine

State transitions are strict and isolated per domain. A domain that trips its circuit cannot be requested until the half-open test succeeds, but every other domain continues unaffected.

```
closed ──(5 consecutive failures)──► open
open   ──(300 s elapsed)───────────► half-open
half-open ──(success)──────────────► closed
half-open ──(failure)──────────────► open
```

The breaker count resets on any success while in `closed` state.

### 2.4 Token Bucket — O(1) Rate Limiter

The rate limiter does not use a polling loop or `setInterval`. Tokens are recalculated lazily at acquire time using the elapsed wall-clock delta. This makes it correct under load spikes and zero-cost when idle.

```typescript
refill():
  now = Date.now()
  elapsed = (now - lastRefill) / 1000          // seconds
  tokens = min(tokens + elapsed * rps, burst)   // never exceeds burst
  lastRefill = now
```

### 2.5 Exponential Backoff + Jitter

Retry delays use full-jitter to prevent thundering herd when multiple tasks hit the same domain simultaneously:

```
base_delay = BASE_BACKOFF_MS * 2^attempt        // 2s, 4s, 8s …
capped     = min(base_delay, MAX_BACKOFF_MS)    // cap at 30s
jitter     = capped * random(0, 0.3)            // up to 30% extra
final_delay = capped + jitter
```

Rate-limit errors (`429`) receive a 3× base multiplier before the cap is applied.

### 2.6 Priority Queue

Tasks are enqueued with an integer priority. Lower values are dequeued first (priority 1 before priority 2). Within the same priority, insertion order is preserved (stable sort).

```typescript
enqueue(task: Task):
  this.queue.push(task)
  this.queue.sort((a, b) => a.priority - b.priority)
```

The dead-letter queue is a separate flat list; tasks move there when `retries >= maxRetries`.

### 2.7 Content-Addressed Deduplication

News headlines and files are deduplicated by SHA-256 of their natural key, not by URL alone. This means the same headline republished under a different URL is not stored twice, and a file mirrored at multiple paths is only indexed once.

```typescript
crypto.createHash('sha256').update(content).digest('hex')
```

### 2.8 Atomic Multi-Table Indexing

Every result is persisted inside a single SQLite transaction. If the process is killed mid-insert, the transaction is rolled back and the JSONL entry acts as the durable record. On resume, the indexer can replay from JSONL.

```typescript
db.transaction(() => {
  _indexPage(report, runId);
  _routeExtracted(extracted, report, runId);
  _indexLinks(links, url);
  _updateDomain(domain, status, elapsedMs, mode);
})();
```

### 2.9 Streaming Output (Crash-Safe)

The JSONL writer holds an open file descriptor in append mode and calls `fs.writeSync` (synchronous) for each result. There is no write buffer and no batching. This guarantees that a result visible in the JSONL file is truly persisted even if the process crashes immediately after.

### 2.10 Checkpoint / Snapshot

The checkpoint is a JSON file containing the set of completed URLs and a progress counter. It is written every 10 tasks and on clean exit. On `--resume`, the engine loads the set and skips any task whose URL is already in it before enqueueing.

---

## 3. Module Interfaces

### 3.1 Task

```typescript
interface Task {
  id:           string;          // UUID
  name:         string;
  url:          string;
  mode:         TaskMode;
  priority:     number;          // 1 = highest
  status:       "pending" | "running" | "done" | "failed" | "dead";
  retries:      number;
  maxRetries:   number;          // default 3
  group?:       string;          // e.g. "stocks", "regulatory"
  tags?:        string[];
  crawl_depth?: number;
  collect_files?: string[];
  extract_type?: "stock_price" | "headlines" | "index_price";
  elapsedMs?:   number;
  error?:       string;
}
```

### 3.2 Worker Results

All three worker types return a union-compatible shape with a mandatory `task`, `status`, `mode`, `url`, `title`, `extracted`, `links`, and `elapsedMs`. Type-specific fields are additive.

```typescript
// HttpWorker
interface HttpResult {
  task:       Task;
  status:     "ok" | "error" | "blocked" | "skipped";
  mode:       "http_json" | "http_curl";
  url:        string;
  title:      string;
  extracted:  Record<string, unknown>;
  links:      string[];
  elapsedMs:  number;
  ticker?:    string;
  price?:     number;
  currency?:  string;
  exchange?:  string;
}

// BrowserWorker
interface BrowserResult {
  task:       Task;
  status:     "ok" | "error" | "blocked" | "timeout";
  mode:       "browser";
  url:        string;
  title:      string;
  extracted:  Record<string, unknown>;
  links:      string[];
  endpoints:  Array<{ url: string; method: string; response_keys: string[] }>;
  elapsedMs:  number;
}

// CrawlWorker
interface CrawlResult {
  task:       Task;
  status:     "ok" | "error";
  mode:       "crawl";
  url:        string;
  title:      string;
  links:      string[];
  files:      Array<{ url: string; text: string; ext: string }>;
  extracted:  Record<string, unknown>;
  elapsedMs:  number;
}
```

### 3.3 Extracted Data Shapes

The `extracted` field carries a domain-specific payload. Three shapes are currently defined:

```typescript
// stock_price
{
  price:      number;
  change:     number;
  changePct:  number;
  prevClose:  number;
  currency:   string;
  exchange:   string;
  company:    string;
  volume?:    number;
  marketCap?: number;
  dayHigh?:   number;
  dayLow?:    number;
}

// headlines
{
  headlines: string[];
  count:     number;
}

// index_price
{
  price:     string | number;
  change:    string | null;
  changePct: string | null;
}
```

The `Indexer._routeExtracted()` method inspects these shapes at runtime to decide which table to write to — there is no discriminated union tag.

---

## 4. Indexer Routing Logic

The indexer uses a cascade of heuristic checks to route extracted data. The checks are evaluated in order; a result can match multiple branches (e.g., a page with both stock data and links).

```
extracted present?
│
├── group === "Yahoo" OR extractType === "stock_price" OR price field exists
│     └── INSERT INTO stocks
│
├── headlines array present
│     └── for each headline:
│           sha256(headline) → skip if hash known
│           INSERT INTO news + fts_news
│
├── group === "INVESTING" OR extractType === "index_price"
│     └── INSERT INTO market_indices
│
├── files array present (from crawl)
│     └── for each file:
│           sha256(url) → skip if hash known
│           INSERT INTO files + fts_files
│
└── endpoints array present (from browser XHR)
      └── INSERT INTO endpoints

Always:
  INSERT OR REPLACE INTO pages + fts_pages
  INSERT OR IGNORE INTO links  (for each link)
  UPSERT INTO domains           (running stats)
```

Number values with SI suffixes (`12.3K`, `4.5M`, `1.2B`, `3T`) are normalised to plain floats before insertion.

---

## 5. Browser Stealth Design

The browser worker applies stealth patches via `page.addInitScript` before any navigation. The goal is to make the Playwright context indistinguishable from a normal Chrome user session.

Patches applied:
- Remove `navigator.webdriver` flag
- Spoof `navigator.plugins` with a realistic list
- Spoof `navigator.languages` to `["id-ID", "id", "en-US", "en"]`
- Override WebGL renderer and vendor strings
- Patch `window.chrome` to match a real Chrome install
- Set viewport to 1280×800 (common laptop resolution)
- Pass `--disable-blink-features=AutomationControlled` as a Chromium launch arg

Additional runtime behaviour:
- Auto-dismiss alert/confirm/prompt dialogs
- Remove sticky overlays and cookie banners after load
- Intercept XHR/fetch responses to capture API endpoints
- Wait for content-specific DOM signals before extraction (configurable per `extract_type`)

Limitations: Cloudflare Turnstile (interactive challenge, requires solving) is not bypassed by stealth patches alone. Residential proxy IP is required.

---

## 6. Crawl Boundary Enforcement

The `CrawlWorker` restricts discovered links to URLs that share the **path prefix directory** of the seed URL. This prevents accidental full-site crawls when given a deep URL.

```
Seed URL:     https://www.ojk.go.id/id/data-dan-statistik/
Path prefix:  /id/data-dan-statistik/

Allowed:      /id/data-dan-statistik/laporan-tahunan
              /id/data-dan-statistik/publikasi/
Blocked:      /id/berita/
              /en/data/
```

File URLs (`.pdf`, `.xlsx`, etc.) are collected regardless of path prefix — they are the primary goal of regulatory-site crawls.

---

## 7. Error Taxonomy

```
Error type    Condition                              Action
──────────────────────────────────────────────────────────────────
transient     ECONNRESET, ETIMEDOUT, ENOTFOUND,      Retry with backoff
              5xx server errors, fetch failures
rate_limit    HTTP 429, body contains "too many"     Retry with 3× backoff
blocked       Cloudflare Turnstile, cf_clearance,    Do not retry
              HTTP 403 with challenge page
not_found     HTTP 404                               Do not retry
permanent     All other errors                       Treat as transient
                                                     (safe default)
```

Result status codes written to `task_log`:

| Status | Meaning |
|--------|---------|
| `ok` | Data extracted successfully |
| `error` | HTTP error, timeout, or parse failure |
| `blocked` | Cloudflare/Turnstile challenge detected |
| `skipped` | Circuit open or rate limit token unavailable |
| `timeout` | Exceeded wait timeout (browser mode) |

---

## 8. Configuration Design

All defaults live in a single exported `DEFAULTS` object in `config/defaults.ts`. There are no environment variables and no external config files for runtime tuning — all overrides are passed via CLI flags or the `DOMAIN_CONFIG` map.

`DOMAIN_CONFIG` is a hardcoded map of domain → `{ rps, timeout, mode }`. It takes the highest precedence in the router, before the probe cache. This allows known-difficult domains to be pre-classified without wasting a probe request.

```typescript
DOMAIN_CONFIG = {
  "finance.yahoo.com":   { rps: 2.0,  timeout: 15_000 },
  "www.idx.co.id":       { rps: 0.3,  timeout: 30_000, mode: "blocked" },
  "api.coingecko.com":   { rps: 0.3,  timeout: 30_000 },
  ...
}
```

---

## 9. Testing Strategy

Tests are organised into four levels of scope, each in its own directory:

| Level | Directory | What it tests |
|-------|-----------|---------------|
| Unit | `tests/unit/` | Individual classes in isolation (queue, circuit breaker, rate limiter, retry, router, checkpoint, timer, config, stream) |
| Smoke | `tests/smoke/` | All modules can be imported; CLI entry point responds to `--help` |
| Integration | `tests/integration/` | Schema creation, full-cycle indexing, FTS search |
| E2E | `tests/e2e/` | Full pipeline: queue → workers → index → export |

**Framework:** Vitest with v8 coverage provider.

**CI matrix:** Linux × macOS × Windows × Node 20 × Node 22. Jobs run in dependency order: lint → unit → smoke → integration → e2e → coverage report.

Unit tests use no network and no filesystem (in-memory SQLite where needed). Integration and E2E tests create temp directories and clean up after themselves.

---

## 10. Output Format Decisions

### JSONL vs JSON array

JSONL (newline-delimited JSON) is used instead of a JSON array so that:
- Each result is written atomically without buffering the full array.
- The file is readable and parseable even if the process is killed mid-run (no unterminated array).
- Streaming consumers (e.g., `jq`, `grep`, line-count) work on partial output.

### SQLite vs PostgreSQL

`better-sqlite3` (synchronous API) was chosen over an async database client because:
- No connection pool, no async/await propagation through the indexer.
- Transactions are synchronous — simpler to reason about atomicity.
- The single-file database is trivially portable and backed up with `cp`.
- SQLite FTS5 with porter stemmer is sufficient for the search use case.
- At ~10 GB the database remains performant; above that, the parallel-instances pattern (multiple DBs) is the scaling path rather than a server database.

### WAL Mode

Write-Ahead Logging is enabled so that reads (queries, stats) do not block concurrent writes (indexing). This is important during live scrape runs where the user may want to query intermediate results.
