// db/schema.ts
// All SQLite table definitions + FTS5 virtual tables
// Run once on engine startup

import Database from "better-sqlite3";

export function initSchema(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("cache_size = -64000");   // 64 MB cache

  db.exec(`
    -- ── Core tables ──────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS runs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id       TEXT UNIQUE NOT NULL,
      started_at   TEXT NOT NULL,
      finished_at  TEXT,
      total_tasks  INTEGER DEFAULT 0,
      completed    INTEGER DEFAULT 0,
      errors       INTEGER DEFAULT 0,
      instance_id  TEXT,
      config       TEXT
    );

    CREATE TABLE IF NOT EXISTS task_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id       TEXT NOT NULL,
      task_id      TEXT NOT NULL,
      task_name    TEXT,
      url          TEXT NOT NULL,
      mode         TEXT,
      status       TEXT,
      elapsed_ms   INTEGER,
      error        TEXT,
      ts           TEXT NOT NULL,
      FOREIGN KEY (run_id) REFERENCES runs(run_id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_log_run ON task_log(run_id);
    CREATE INDEX IF NOT EXISTS idx_task_log_url ON task_log(url);

    CREATE TABLE IF NOT EXISTS pages (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      url          TEXT NOT NULL,
      domain       TEXT NOT NULL,
      title        TEXT,
      status       TEXT,
      mode         TEXT,
      content_hash TEXT,
      first_seen   TEXT NOT NULL,
      last_seen    TEXT NOT NULL,
      elapsed_ms   INTEGER,
      source_group TEXT,
      run_id       TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pages_url ON pages(url);
    CREATE INDEX IF NOT EXISTS idx_pages_domain ON pages(domain);
    CREATE INDEX IF NOT EXISTS idx_pages_last_seen ON pages(last_seen);

    CREATE TABLE IF NOT EXISTS stocks (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker       TEXT NOT NULL,
      company_name TEXT,
      price        REAL,
      change_val   REAL,
      change_pct   REAL,
      volume       REAL,
      market_cap   REAL,
      day_high     REAL,
      day_low      REAL,
      prev_close   REAL,
      week52_high  REAL,
      week52_low   REAL,
      currency     TEXT DEFAULT 'IDR',
      exchange     TEXT,
      source_url   TEXT,
      extracted_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_stocks_ticker ON stocks(ticker);
    CREATE INDEX IF NOT EXISTS idx_stocks_date   ON stocks(extracted_at);

    CREATE TABLE IF NOT EXISTS news (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      source       TEXT NOT NULL,
      headline     TEXT NOT NULL,
      url          TEXT,
      content      TEXT,
      published_at TEXT,
      extracted_at TEXT NOT NULL,
      content_hash TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_news_hash
      ON news(content_hash) WHERE content_hash IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_news_source ON news(source);
    CREATE INDEX IF NOT EXISTS idx_news_date   ON news(extracted_at);

    CREATE TABLE IF NOT EXISTS market_indices (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      index_name   TEXT NOT NULL,
      price        REAL,
      change_val   TEXT,
      change_pct   TEXT,
      source_url   TEXT,
      extracted_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mindices_name ON market_indices(index_name);

    CREATE TABLE IF NOT EXISTS files (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      source_url     TEXT NOT NULL,
      discovered_from TEXT,
      filename       TEXT,
      ext            TEXT,
      size_bytes     INTEGER,
      content_hash   TEXT,
      local_path     TEXT,
      content_text   TEXT,
      extracted_at   TEXT NOT NULL,
      status         TEXT DEFAULT 'discovered'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_files_hash
      ON files(content_hash) WHERE content_hash IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_files_ext ON files(ext);

    CREATE TABLE IF NOT EXISTS links (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      from_url      TEXT NOT NULL,
      to_url        TEXT NOT NULL,
      anchor_text   TEXT,
      discovered_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_links_pair ON links(from_url, to_url);

    CREATE TABLE IF NOT EXISTS domains (
      domain         TEXT PRIMARY KEY,
      mode           TEXT,
      last_seen      TEXT,
      total_pages    INTEGER DEFAULT 0,
      total_errors   INTEGER DEFAULT 0,
      avg_ms         REAL,
      circuit_state  TEXT DEFAULT 'closed',
      notes          TEXT,
      updated_at     TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS endpoints (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      url             TEXT NOT NULL,
      method          TEXT DEFAULT 'GET',
      discovered_from TEXT,
      params          TEXT,
      response_schema TEXT,
      first_seen      TEXT NOT NULL,
      last_seen       TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_endpoints_url ON endpoints(url);

    -- ── FTS5 virtual tables ───────────────────────────────────────

    CREATE VIRTUAL TABLE IF NOT EXISTS fts_pages
    USING fts5(
      url, title, content, source,
      tokenize = 'porter unicode61'
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS fts_news
    USING fts5(
      headline, source, url, content,
      tokenize = 'porter unicode61'
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS fts_files
    USING fts5(
      filename, source_url, ext, content_text,
      tokenize = 'unicode61'
    );
  `);
}
