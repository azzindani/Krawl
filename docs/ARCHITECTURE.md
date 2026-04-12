# Krawl — Architecture

> **Knowledge Retrieval and Web Logic Engine**
> One engine. Any URL. Any scale. Zero LLM. Zero downtime.

---

## 1. Overview

Krawl is a TypeScript-native web scraping and data extraction engine. It accepts URLs, automatically detects the correct extraction strategy per domain, runs parallel worker pools, and persists all results into a queryable SQLite database — without any LLM involvement.

The engine is structured as a **layered pipeline**: input flows through routing and scheduling, gets processed by one of three worker types, passes through a resilience layer, and lands in persistent storage.

---

## 2. Layer Map

```
┌──────────────────────────────────────────────────────────────┐
│                     INPUT LAYER                              │
│   CLI flags · JSON task files · single URL · domain sweep   │
└───────────────────────────┬──────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────┐
│                   CORE LAYER  (krawl.ts → core/)             │
│                                                              │
│  ┌─────────────┐  ┌──────────────┐  ┌──────────────────────┐ │
│  │  TaskQueue  │  │    Router    │  │     Scheduler        │ │
│  │  (queue.ts) │  │  (router.ts) │  │  (scheduler.ts)      │ │
│  │             │  │              │  │                      │ │
│  │ Priority    │  │ Probe URLs   │  │ Phase 1: auto-resolve│ │
│  │ queue with  │  │ Cache mode   │  │ Phase 2: HTTP+Browser│ │
│  │ dead-letter │  │ per domain   │  │ Phase 3: Crawl       │ │
│  └─────────────┘  └──────────────┘  └──────────────────────┘ │
│  ┌─────────────┐  ┌──────────────┐                           │
│  │ Checkpoint  │  │    Timer     │                           │
│  │(checkpoint) │  │  (timer.ts)  │                           │
│  │             │  │              │                           │
│  │ Save/resume │  │ Perf track + │                           │
│  │ run state   │  │ live display │                           │
│  └─────────────┘  └──────────────┘                           │
└───────────────────────────┬──────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────┐
│                   WORKER LAYER  (workers/)                   │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐  │
│  │ HttpWorker   │  │BrowserWorker │  │   CrawlWorker      │  │
│  │ (http.ts)    │  │(browser.ts)  │  │   (crawl.ts)       │  │
│  │              │  │              │  │                    │  │
│  │ http_json    │  │ Playwright   │  │ BFS frontier       │  │
│  │ http_curl    │  │ Stealth pool │  │ File discovery     │  │
│  │ p-limit(5)   │  │ p-limit(3)   │  │ p-limit(2)         │  │
│  └──────────────┘  └──────────────┘  └────────────────────┘  │
└───────────────────────────┬──────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────┐
│                RESILIENCE LAYER  (resilience/)               │
│                                                              │
│  ┌──────────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │  CircuitBreaker  │  │  RateLimiter │  │ RetryManager  │  │
│  │                  │  │              │  │               │  │
│  │ Per domain       │  │ Token bucket │  │ Backoff+jitter│  │
│  │ 5 fails → open   │  │ per domain   │  │ Error classify│  │
│  │ 300s → half-open │  │ 0.5 RPS def  │  │ Dead letter   │  │
│  └──────────────────┘  └──────────────┘  └───────────────┘  │
└───────────────────────────┬──────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────┐
│                   DATA LAYER  (db/ + output/)                │
│                                                              │
│  ┌──────────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │    Indexer       │  │   SQLite DB  │  │ JSONL Stream  │  │
│  │  (indexer.ts)    │  │  (schema.ts) │  │ (stream.ts)   │  │
│  │                  │  │              │  │               │  │
│  │ Auto-route to    │  │ FTS5 tables  │  │ Append-only   │  │
│  │ correct tables   │  │ WAL mode     │  │ crash-safe    │  │
│  │ SHA256 dedup     │  │ 64 MB cache  │  │               │  │
│  └──────────────────┘  └──────────────┘  └───────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

---

## 3. Components

### 3.1 Entry Point — `krawl.ts`

Single entry point for the entire engine. Parses CLI arguments, builds the initial task list, wires together all subsystems, and invokes `Scheduler.run()`. Also handles query/search/export/stats sub-commands directly without starting the scrape pipeline.

### 3.2 Core Layer — `core/`

| File | Responsibility |
|------|----------------|
| `queue.ts` | Priority task queue. Dequeues in order, tracks done URLs, moves exhausted tasks to dead-letter queue. |
| `router.ts` | Probes each URL once per domain. Caches the detected mode (`http_json`, `http_curl`, `browser`, `crawl`, `blocked`) to `router_cache.json`. Hardcoded overrides take precedence. |
| `scheduler.ts` | Master orchestrator. Runs three sequential phases: resolve auto-modes → parallel HTTP+Browser → sequential Crawl. Collects results and routes each to the indexer, JSONL stream, and checkpoint. |
| `checkpoint.ts` | Serialises completed URL set to disk after every N tasks. Allows the engine to resume after a crash or restart. |
| `timer.ts` | Tracks wall time per phase, per-mode counters, per-domain throughput. Renders live progress bar and prints the final summary. |

### 3.3 Worker Layer — `workers/`

| File | Mode(s) | Concurrency |
|------|---------|-------------|
| `http.ts` | `http_json`, `http_curl` | p-limit(5) |
| `browser.ts` | `browser` | p-limit(3) contexts per Chromium instance |
| `crawl.ts` | `crawl` | p-limit(2) |

Each worker is independently concurrent within its pool. HTTP and Browser pools run in parallel during Phase 2; Crawl runs after.

### 3.4 Resilience Layer — `resilience/`

All three primitives operate **per domain**, so a failing domain cannot degrade extraction of other domains.

| File | Mechanism |
|------|-----------|
| `circuit_breaker.ts` | State machine: closed → open (after 5 failures) → half-open (after 300 s) → closed. Blocks calls while open. |
| `rate_limiter.ts` | Token bucket. Default 0.5 RPS; refill is O(1), never uses a polling loop. Per-domain overrides available via `config/defaults.ts`. |
| `retry.ts` | Classifies errors into `transient / rate_limit / blocked / not_found / permanent`. Only retries transient and rate_limit errors, using exponential backoff (base 2 s, max 30 s) with 30 % random jitter. |

### 3.5 Data Layer — `db/` and `output/`

| File | Responsibility |
|------|----------------|
| `schema.ts` | Defines all SQLite tables (runs, task_log, pages, stocks, news, market_indices, files, links, domains, endpoints) plus three FTS5 virtual tables. WAL mode + 64 MB page cache enabled at init. |
| `indexer.ts` | Receives a raw result object and routes it atomically into the correct tables in a single SQLite transaction. Performs SHA-256 deduplication for news and files. Updates FTS5 indexes and domain stats. |
| `query.ts` | Exposes `sql()`, `search()` (FTS), `stats()`, `toCsv()`. |
| `stream.ts` | Append-only JSONL file handle. Every result is written immediately — no batching — so a crash loses at most the in-flight task. |
| `export.ts` | Exports individual tables or all tables to CSV or JSON files. |

### 3.6 Configuration — `config/`

| File | Responsibility |
|------|----------------|
| `defaults.ts` | Single source of truth for all tunables: pool sizes, timeouts, retry limits, circuit thresholds, rate limits, crawl depth, file extensions, browser viewport, hardcoded per-domain overrides, Cloudflare indicators, SPA markers. |

---

## 4. Execution Flow

```
CLI arguments
     │
     ▼
loadTasks() → Task[]
     │
     ▼
Scheduler.addTasks()           enqueue all tasks (status = pending)
     │
     ▼
Phase 1 — resolveAutoModes()   10 concurrent domain probes
     │  Router.resolve(url)
     │    ├── hardcoded override? → return
     │    ├── cached? → return
     │    └── probe → inspect headers/body → detect mode
     │
     ▼
Phase 2 — runAllPools()        split tasks by mode
     ├── HTTP pool (http_json / http_curl)     ─┐
     │     withRetry → breaker.allow           │ concurrent
     │     → limiter.acquire → fetch            │ (Promise.all)
     │     → parse → HttpResult                │
     ├── Browser pool                          ─┘
     │     applyStealthPatches → goto
     │     → waitForContent → extract
     │     → collect links + XHR endpoints
     │     → BrowserResult
     │
     ▼
Phase 3 — Crawl pool           after HTTP+Browser complete
     BFS queue → fetch page → extract links
     → filter by path prefix → discover files
     → CrawlResult[]
     │
     ▼  (all phases)
processResult(result)
     ├── stream.write()          JSONL (immediate)
     ├── indexer.index()         SQLite (atomic transaction)
     │     ├── pages + fts_pages
     │     ├── stocks / news / market_indices / files / endpoints
     │     ├── links
     │     └── domains (upsert stats)
     ├── indexer.logTask()       task_log audit row
     ├── queue.markDone()
     └── checkpoint.save()       every 10 tasks
     │
     ▼
finalize()
     ├── final checkpoint
     ├── close JSONL stream
     ├── update runs table
     ├── print summary + dead-letter list
     └── exit 0
```

---

## 5. Mode Detection Logic

The Router probes each unknown domain once and caches the result permanently.

```
fetch(url, { method: HEAD / GET })
     │
     ├── Content-Type: application/json?       → http_json
     ├── URL path matches /v1/ /api/ /chart/    → http_json
     ├── 403/429/blocked + CF-Ray header        → blocked
     ├── Response body contains SPA marker      → browser
     │     (__NEXT_DATA__, ng-version, nuxt…)
     ├── Status 200, static HTML, no SPA        → http_curl
     └── Timeout or ECONNRESET                  → crawl
```

If all `http_curl` attempts fail at runtime, the Scheduler upgrades those tasks to `browser` for a second pass (Phase 3 upgrade path).

---

## 6. Data Model (Storage)

### Run management
```
runs          id, started_at, finished_at, total_tasks, completed, errors, instance_id, config
task_log      run_id, task_id, task_name, url, mode, status, elapsed_ms, error, ts
```

### Content storage
```
pages         url, domain, title, status, mode, content_hash, first_seen, last_seen, elapsed_ms, source_group, run_id
stocks        ticker, company_name, price, change_val, change_pct, volume, market_cap, day_high, day_low, prev_close, week52_*, currency, exchange, source_url, extracted_at
news          source, headline, url, content, extracted_at, content_hash
market_indices index_name, price, change_val, change_pct, source_url, extracted_at
files         source_url, discovered_from, filename, ext, size_bytes, content_hash, local_path, content_text, extracted_at, status
links         from_url, to_url, anchor_text, discovered_at
domains       domain, mode, last_seen, total_pages, total_errors, avg_ms, circuit_state, notes, updated_at
endpoints     url, method, discovered_from, params, response_schema, first_seen, last_seen
```

### Full-text search (FTS5)
```
fts_pages     url, title, content, source           — porter + unicode61 tokenizer
fts_news      headline, source, url, content        — porter + unicode61 tokenizer
fts_files     filename, source_url, ext, content_text — unicode61 tokenizer
```

### Deduplication keys
| Table | Dedup strategy |
|-------|---------------|
| `pages` | UNIQUE on `url` |
| `news` | UNIQUE on `content_hash` (SHA-256 of headline) |
| `files` | UNIQUE on `content_hash` (SHA-256 of URL) |
| `links` | UNIQUE on `(from_url, to_url)` |
| `endpoints` | UNIQUE on `url` |

---

## 7. Parallel Instance Topology

Krawl is designed to scale horizontally without any shared state:

```
┌─────────────────────────────────────────────┐
│              URL Batch (N tasks)             │
└──────┬──────────────┬──────────────┬─────────┘
       │              │              │
       ▼              ▼              ▼
  instance 1     instance 2     instance 3
  engine_1.db    engine_2.db    engine_3.db
  batch_1.json   batch_2.json   batch_3.json

Each instance: fully independent
No coordination, no shared queue, no lock contention

Post-run: merge engine_*.db → merged.db
```

Each instance has its own SQLite file, its own checkpoint file, and its own JSONL stream. Merging is handled offline after all instances complete.

---

## 8. Deployment Sizing

| Tier | vCPU | RAM | Disk | Browser contexts | URLs/hour |
|------|------|-----|------|-----------------|-----------|
| Minimum | 2 | 2 GB | 20 GB | 3 | ~500 |
| Recommended | 4 | 8 GB | 80 GB | 10 | ~2,000 |
| Heavy | 8 | 16 GB | 200 GB | 30 | ~10,000 |

RAM is the primary bottleneck: each Chromium process consumes 150–300 MB. For Cloudflare Turnstile-protected sites, a residential proxy service is required regardless of VPS tier.

---

## 9. Future Extension Points

The architecture was intentionally designed with three zero-rebuild extension paths:

| Interface | What to add | Engine change |
|-----------|-------------|---------------|
| HTTP API | Express wrapper | None |
| MCP Server | MCP protocol adapter | None |
| LLM tool | Agent calls engine as a tool | None |

The core engine remains LLM-free regardless of the interface layer added on top.
