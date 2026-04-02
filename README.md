# 🦎 **KRAWL**
*Knowledge Retrieval and Web Logic Engine*

---

## Philosophy

```
One engine. Any URL. Any scale. Zero LLM. Zero downtime.
Give it URLs. It figures out the rest.
Results land in a queryable database automatically.
Run one instance or a hundred. Same command.
```

---

## Full Capability Map

```
INPUT LAYER
  ├── CLI flags          npx tsx krawl.ts --urls urls.txt
  ├── JSON task file     npx tsx krawl.ts --tasks tasks.json
  ├── Single URL         npx tsx krawl.ts --url https://...
  ├── Domain sweep       npx tsx krawl.ts --domain ojk.go.id
  └── Scheduled run      npx tsx krawl.ts --schedule "0 */6 * * *"

INTELLIGENCE LAYER
  ├── URL Router         probe → detect → route (cached per domain)
  ├── Mode selector      http_json / http_curl / browser / crawl / blocked
  ├── Schema detector    auto-detects data type from response shape
  └── Domain profiler    measures timing, sets per-domain timeout

EXECUTION LAYER
  ├── HTTP Worker Pool   concurrent fetch, semaphore controlled
  │   ├── built-in fetch (Node 18+)
  │   ├── Chrome TLS impersonation for bot-protected APIs
  │   └── automatic header spoofing
  ├── Browser Worker Pool  Playwright Chromium
  │   ├── N contexts per browser (configurable)
  │   ├── Stealth patches applied automatically
  │   ├── wait_for_function for real data detection
  │   ├── XHR/API interception and capture
  │   ├── Popup and overlay dismissal
  │   ├── Screenshot capture (optional)
  │   └── Form detection (optional)
  └── Crawl Worker       BFS frontier
      ├── Politeness rules (robots.txt respected)
      ├── Link deduplication (URL hash)
      ├── File discovery (PDF, XLS, XLSX, CSV, ZIP, DOCX)
      └── Depth limiting

RESILIENCE LAYER
  ├── Circuit Breaker    per domain (closed/open/half-open)
  ├── Token Bucket       per domain rate limiting
  ├── Retry Manager      exponential backoff + jitter
  ├── Dead Letter Queue  exhausted retries → flagged for review
  ├── Session Manager    context rotation, cookie pools
  └── Timeout Profiler   per-domain calibrated timeouts

DATA LAYER
  ├── Auto Indexer       routes every result to correct table
  ├── FTS5 Search        full-text across all collected content
  ├── Deduplication      SHA256 content hash
  └── Delta Detection    skip if content unchanged since last run

OUTPUT LAYER
  ├── SQLite Database    single file, all tables, FTS5
  ├── JSONL Stream       every result written immediately
  ├── CSV Export         per table on demand
  ├── File Downloads     organized by domain/date/type
  └── Progress Display   live counter, ETA, throughput

AGENT INTERFACE (future, zero rebuild)
  ├── CLI tool           current
  ├── HTTP API           add express, same engine underneath
  └── MCP server         add MCP wrapper, same engine underneath
```

---

### Folder Structure

```
krawl/
│
├── krawl.ts                  ← single entry point
├── package.json              ← 5 dependencies max
├── tsconfig.json
├── .env.example              ← config template
│
├── core/
│   ├── queue.ts              ← priority task queue
│   ├── router.ts             ← URL mode detection + domain cache
│   ├── scheduler.ts          ← orchestrates all worker pools
│   ├── checkpoint.ts         ← save/resume state machine
│   └── timer.ts              ← performance tracking + ETA
│
├── workers/
│   ├── http.ts               ← concurrent HTTP, TLS impersonation
│   ├── browser.ts            ← Playwright pool, stealth, extraction
│   └── crawl.ts              ← BFS, file discovery, politeness
│
├── resilience/
│   ├── circuit_breaker.ts    ← per-domain failure states
│   ├── rate_limiter.ts       ← token bucket per domain
│   └── retry.ts              ← backoff + dead letter
│
├── db/
│   ├── schema.ts             ← all table definitions + FTS5
│   ├── indexer.ts            ← auto-routes results to tables
│   └── query.ts              ← query helpers + FTS search
│
├── extractors/
│   ├── stock.ts              ← financial data extraction
│   ├── news.ts               ← headline + article extraction
│   ├── index.ts              ← market index extraction
│   ├── files.ts              ← file download + content extraction
│   └── generic.ts            ← fallback text + link extraction
│
├── output/
│   ├── stream.ts             ← JSONL writer
│   ├── export.ts             ← CSV/JSON export
│   └── display.ts            ← terminal progress + stats
│
├── config/
│   ├── domains.ts            ← per-domain rate limits + timeouts
│   └── defaults.ts           ← engine-wide defaults
│
└── tasks/
    ├── idx_targets.json      ← IDX-related task definitions
    ├── financial.json        ← financial data tasks
    └── example.json          ← template for custom tasks
```

---

## Dependencies — Maximum 5

```json
{
  "dependencies": {
    "playwright"      : "latest",
    "better-sqlite3"  : "latest",
    "zod"             : "latest",
    "p-limit"         : "latest",
    "pdf-parse"       : "latest"
  },
  "devDependencies": {
    "tsx"             : "latest",
    "typescript"      : "latest",
    "@types/node"     : "latest",
    "@types/better-sqlite3": "latest"
  }
}
```

```
playwright       → browser engine (replaces Selenium)
better-sqlite3   → database (synchronous, fast)
zod              → schema validation (replaces pydantic)
p-limit          → concurrency (replaces asyncio.Semaphore)
pdf-parse        → PDF text extraction (replaces pdfplumber)

Built-in Node.js (no install needed):
  fetch           → HTTP requests (Node 18+)
  fs              → file system
  path            → path handling
  crypto          → SHA256 hashing
  child_process   → CLI subprocess if needed
  readline        → CLI input
```

---

## CLI Interface

```bash
# Single URL
npx tsx krawl.ts --url https://www.ojk.go.id/id/Default.aspx

# List of URLs from file
npx tsx krawl.ts --urls tasks/financial.json

# Domain sweep (crawl everything on a domain)
npx tsx krawl.ts --domain ojk.go.id --depth 3

# Resume interrupted run
npx tsx krawl.ts --urls tasks/financial.json --resume

# Multiple parallel instances (robotic agent mode)
npx tsx krawl.ts --urls batch_1.json --instance 1 --db engine_1.db &
npx tsx krawl.ts --urls batch_2.json --instance 2 --db engine_2.db &
npx tsx krawl.ts --urls batch_3.json --instance 3 --db engine_3.db &

# Query the database
npx tsx krawl.ts --query "SELECT * FROM stocks WHERE ticker='BBCA'"
npx tsx krawl.ts --search "suku bunga"

# Export collected data
npx tsx krawl.ts --export stocks --format csv
npx tsx krawl.ts --export all --format json

# Scheduled run every 6 hours
npx tsx krawl.ts --urls tasks/financial.json --schedule "0 */6 * * *"

# Show live stats
npx tsx krawl.ts --stats
```

---

## Task File Format

```json
[
  {
    "name"       : "BBCA Stock",
    "url"        : "https://query1.finance.yahoo.com/v8/finance/chart/BBCA.JK?interval=1d&range=1d",
    "mode"       : "auto",
    "priority"   : 1,
    "group"      : "stocks",
    "tags"       : ["yahoo", "banking", "idx"]
  },
  {
    "name"       : "OJK Reports",
    "url"        : "https://www.ojk.go.id/id/data-dan-statistik",
    "mode"       : "auto",
    "priority"   : 2,
    "group"      : "regulatory",
    "crawl_depth": 3,
    "collect_files": [".pdf", ".xlsx"]
  }
]
```

`mode: "auto"` means the router decides. You never need to specify mode manually unless you want to override.

---

### Parallel Execution Model (Robotic Agent)

```
Single instance:
  krawl.ts → scheduler → [HTTP pool | Browser pool | Crawl worker]
  one database: engine.db

Multiple instances (parallel agents):
  instance 1 → engine_1.db → batch_1 tasks
  instance 2 → engine_2.db → batch_2 tasks
  instance 3 → engine_3.db → batch_3 tasks

Merge databases after:
  krawl.ts --merge engine_1.db engine_2.db engine_3.db → merged.db

Each instance is fully independent.
No shared state between instances.
No coordination needed.
This is the scrape1..N pattern, but automated and intelligent.
```

---

## Time Counter Design

```
Every result carries:
  elapsed_ms     → how long this specific task took
  
Every phase carries:
  phase_start    → timestamp
  phase_end      → timestamp
  phase_duration → seconds

Live display (terminal):
  [14:32:05] ████████████░░░░░░░░ 62%  124/200 tasks
  Throughput : 2.3 tasks/sec
  ETA        : 33 seconds
  HTTP   ✓47  Browser ✓61  Crawl ✓16  Errors ✗3
  DB size: 2.4 MB  Records: 1,847

Per-run summary:
  Total time     : 4m 32s
  Tasks/second   : 0.73 avg
  Fastest domain : finance.yahoo.com (0.3s avg)
  Slowest domain : www.ojk.go.id (14.2s avg)
  Total records  : 1,847
  DB size        : 2.4 MB
```

---

## Database Schema (Single File = Total Knowledge)

```sql
-- All tables as designed in ENGINE-0
-- Plus these additions for production:

CREATE TABLE runs (
    id           INTEGER PRIMARY KEY,
    started_at   TEXT,
    finished_at  TEXT,
    total_tasks  INTEGER,
    completed    INTEGER,
    errors       INTEGER,
    instance_id  TEXT,
    config       TEXT         -- JSON snapshot of run config
);

CREATE TABLE task_log (
    id           INTEGER PRIMARY KEY,
    run_id       INTEGER,
    task_name    TEXT,
    url          TEXT,
    mode         TEXT,
    status       TEXT,
    elapsed_ms   INTEGER,
    error        TEXT,
    ts           TEXT,
    FOREIGN KEY (run_id) REFERENCES runs(id)
);
-- Full audit trail of every task ever executed
```

---

## VPS Minimum Specification

```
ABSOLUTE MINIMUM (budget, light loads):
  CPU    : 2 vCPU
  RAM    : 2 GB
  Disk   : 20 GB SSD
  OS     : Ubuntu 22.04 LTS
  Network: 1 Gbps port
  Cost   : ~$6/month (Hetzner CX22, DigitalOcean Basic)

  Handles:
    Up to 3 concurrent browser contexts
    ~500 URLs per hour
    ~50 GB collected data before disk full

RECOMMENDED (comfortable, production):
  CPU    : 4 vCPU
  RAM    : 8 GB
  Disk   : 80 GB SSD
  OS     : Ubuntu 22.04 LTS
  Network: 1 Gbps port
  Cost   : ~$20-30/month

  Handles:
    Up to 10 concurrent browser contexts
    ~2,000 URLs per hour
    Multiple parallel instances
    ~800 GB collected data

HEAVY (high throughput, many instances):
  CPU    : 8 vCPU
  RAM    : 16 GB
  Disk   : 200 GB SSD (or attach block storage)
  OS     : Ubuntu 22.04 LTS
  Network: 1 Gbps port
  Cost   : ~$60-80/month

  Handles:
    Up to 30 concurrent browser contexts
    ~10,000 URLs per hour
    10+ parallel instances
    Residential proxy integration

CRITICAL NOTE on RAM:
  Each Chromium browser process = ~150-300 MB RAM
  3 browser workers = ~600 MB just for Chromium
  2 GB total RAM = only 3 browser contexts safely
  8 GB total RAM = up to 15-20 browser contexts safely
  RAM is the real bottleneck, not CPU

CRITICAL NOTE on IP:
  All VPS providers = datacenter IPs
  Cloudflare Turnstile (idx.co.id) = blocked from any VPS
  Solution = residential proxy service routed through VPS
  Cost = $50-200/month additional for residential proxies
  Without proxy = all non-Turnstile sites work fine from VPS
```

---

## VPS Deployment Setup

```bash
# One-time setup on Ubuntu 22.04

# Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# System deps for Playwright Chromium
sudo apt-get install -y \
  libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
  libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 \
  libxrandr2 libgbm1 libasound2 libpango-1.0-0 \
  libnspr4 libnss3

# Clone and install
git clone https://github.com/you/krawl.git
cd krawl
npm install
npx playwright install chromium

# Run as background process
nohup npx tsx krawl.ts --urls tasks/financial.json > krawl.log 2>&1 &

# Or with PM2 (process manager, auto-restart on crash)
npm install -g pm2
pm2 start "npx tsx krawl.ts --urls tasks/financial.json" --name krawl
pm2 startup    # survive server reboots
pm2 save
```

---

## Summary

```
Language         : TypeScript only. Zero Python.
Runtime          : Node.js 20 LTS
Dependencies     : 5 (playwright, better-sqlite3, zod, p-limit, pdf-parse)
Entry point      : single krawl.ts
LLM              : zero, none, not needed
Total code       : ~1,750 lines
VPS minimum      : 2 vCPU / 2 GB RAM / 20 GB SSD / Ubuntu 22.04
VPS recommended  : 4 vCPU / 8 GB RAM / 80 GB SSD
CLI              : yes, trigger multiple instances in parallel
Robotic agent    : yes, each instance fully independent
MCP-ready        : yes, add thin wrapper when needed, zero engine rebuild
Future LLM use   : LLM calls engine as tool, engine stays LLM-free

One engine. One language. One file as the database.
Give it URLs. It figures everything else out.
```
