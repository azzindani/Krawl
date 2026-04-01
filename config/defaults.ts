// config/defaults.ts
// All engine-wide defaults in one place
// Change here, affects everything

export const DEFAULTS = {
  // Worker pool sizes
  HTTP_CONCURRENCY    : 5,
  BROWSER_CONTEXTS    : 3,
  CRAWL_CONCURRENCY   : 2,

  // Timeouts (ms)
  HTTP_TIMEOUT        : 15_000,
  BROWSER_TIMEOUT     : 30_000,
  CRAWL_TIMEOUT       : 20_000,
  WAIT_FOR_DATA_TIMEOUT: 25_000,

  // Retry
  MAX_RETRIES         : 3,
  BACKOFF_BASE_MS     : 2_000,
  BACKOFF_MAX_MS      : 30_000,

  // Circuit breaker
  CIRCUIT_THRESHOLD   : 5,      // failures before opening
  CIRCUIT_RESET_MS    : 300_000, // 5 min before half-open

  // Rate limiting (requests per second per domain)
  DEFAULT_RPS         : 0.5,
  KNOWN_SAFE_RPS      : 2.0,

  // Crawl
  MAX_CRAWL_DEPTH     : 3,
  MAX_CRAWL_PAGES     : 500,

  // Checkpoint
  CHECKPOINT_EVERY    : 10,     // tasks between saves

  // Database
  DB_PATH             : "krawl.db",
  JSONL_PATH          : "krawl_output.jsonl",
  FILES_DIR           : "krawl_files",

  // Browser
  VIEWPORT            : { width: 1280, height: 800 },
  USER_AGENT          : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  LOCALE              : "id-ID",
  TIMEZONE            : "Asia/Jakarta",

  // Chromium launch args (Colab + VPS compatible)
  CHROMIUM_ARGS: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--no-zygote",
    "--disable-extensions",
    "--disable-blink-features=AutomationControlled",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-features=TranslateUI",
  ],

  // File types to collect during crawl
  COLLECTIBLE_EXTENSIONS: [
    ".pdf", ".xls", ".xlsx", ".csv",
    ".zip", ".docx", ".ppt", ".pptx",
  ],

  // Cloudflare challenge indicators
  CHALLENGE_TITLES: [
    "just a moment",
    "tunggu sebentar",
    "attention required",
    "verifikasi keamanan",
    "ddos-guard",
  ],

  // SPA framework markers
  SPA_MARKERS: [
    "ng-version",
    "data-reactroot",
    "__NEXT_DATA__",
    "nuxt",
    "__vue",
  ],
} as const;

// Per-domain overrides
export const DOMAIN_CONFIG: Record<string, {
  rps?: number;
  timeout?: number;
  mode?: string;
}> = {
  "finance.yahoo.com"       : { rps: 2.0,  timeout: 15_000 },
  "query1.finance.yahoo.com": { rps: 3.0,  timeout: 10_000 },
  "www.cnbcindonesia.com"   : { rps: 1.0,  timeout: 20_000 },
  "id.investing.com"        : { rps: 1.0,  timeout: 20_000 },
  "www.ojk.go.id"           : { rps: 0.5,  timeout: 30_000 },
  "www.bi.go.id"            : { rps: 0.5,  timeout: 60_000 },
  "www.ksei.co.id"          : { rps: 1.0,  timeout: 15_000 },
  "www.idx.co.id"           : { rps: 0.3,  timeout: 30_000, mode: "blocked" },
};
