// src/mcp/tools.ts
// MCP tool definitions for Krawl. Each tool wraps an existing module
// (core/scheduler, db/query, output/export) — this file holds only the
// JSON-RPC contract and the thin glue.

import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { Scheduler } from "../../core/scheduler.js";
import { QueryEngine } from "../../db/query.js";
import { Exporter } from "../../output/export.js";
import { initSchema } from "../../db/schema.js";

const DB_PATH      = process.env["KRAWL_DB_PATH"]      ?? "/data/krawl.db";
const JSONL_PATH   = process.env["KRAWL_JSONL_PATH"]   ?? "/data/krawl_output.jsonl";
const EXPORTS_DIR  = process.env["KRAWL_EXPORTS_DIR"]  ?? "/exports";
const ROUTER_CACHE = process.env["KRAWL_ROUTER_CACHE"] ?? "/data/router_cache.json";

// ── JSON-RPC tool contract ───────────────────────────────────────────────────

export interface ToolDef {
  name        : string;
  description : string;
  inputSchema : Record<string, unknown>;
  handler     : (args: Record<string, unknown>) => Promise<unknown>;
}

// Open + initialize a DB handle. Caller closes.
function openDb(): Database.Database {
  const dir = path.dirname(DB_PATH);
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(DB_PATH);
  initSchema(db);
  return db;
}

// ── krawl_url ────────────────────────────────────────────────────────────────
// Submit a single URL, wait for the scheduler to finish, return what landed
// in the JSONL stream for this run. Heavy: spins up the full worker pool
// for one URL. Good enough for ad-hoc MCP calls; do not call in a loop.

// Serialize krawl_url calls. The Scheduler instantiates a full worker pool
// (Chromium + http + crawl + DB) per call; running N in parallel would N×
// the RAM footprint and dwarf the container's mem_limit. Cheap tools
// (query/search/stats/export) stay unserialized.
function createLock(): <T>(fn: () => Promise<T>) => Promise<T> {
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);   // run regardless of prev outcome
    chain      = next.catch(() => {}); // strip error from the chain head
    return next;
  };
}
const krawlUrlLock = createLock();

const krawl_url: ToolDef = {
  name        : "krawl_url",
  description :
    "Fetch and parse a single URL through Krawl's auto-routed worker pool " +
    "(http/browser/crawl). Results are persisted to the SQLite DB and " +
    "streamed to the JSONL log. Returns the rows extracted for this URL. " +
    "Serialized: concurrent calls queue behind one another.",
  inputSchema : {
    type      : "object",
    properties: {
      url : { type: "string", description: "Full URL to fetch (https://…)" },
      mode: {
        type: "string",
        enum: ["auto", "http_json", "http_curl", "browser", "crawl"],
        description: "Override the auto-router. Defaults to 'auto'.",
      },
      crawl_depth: {
        type: "integer",
        minimum: 0,
        maximum: 5,
        description: "Only used when mode='crawl'. Defaults to 1.",
      },
    },
    required: ["url"],
  },
  handler: async (args) => {
    const url        = String(args["url"] ?? "");
    const mode       = (args["mode"] as string) ?? "auto";
    const crawlDepth = Number(args["crawl_depth"] ?? 1);

    if (!url.startsWith("http")) {
      throw new Error(`krawl_url: url must start with http(s), got '${url}'`);
    }

    return krawlUrlLock(async () => {
      // Record byte offset so we return only what THIS call produced
      // without a per-call output file.
      const startBytes = fs.existsSync(JSONL_PATH)
        ? fs.statSync(JSONL_PATH).size
        : 0;

      const scheduler = new Scheduler({
        dbPath         : DB_PATH,
        jsonlPath      : JSONL_PATH,
        checkpointPath : `/data/krawl_checkpoint_mcp.json`,
        routerCachePath: ROUTER_CACHE,
        httpConcurrency: 2,
        browserContexts: 1,
        instanceId     : "mcp",
        resume         : false,
      });

      try {
        scheduler.addTasks([{
          url,
          mode       : mode as "auto" | "http_json" | "http_curl" | "browser" | "crawl",
          crawl_depth: crawlDepth,
        }]);
        await scheduler.run();

        const fd       = fs.openSync(JSONL_PATH, "r");
        const endBytes = fs.statSync(JSONL_PATH).size;
        const newBuf   = Buffer.alloc(Math.max(0, endBytes - startBytes));
        if (newBuf.length > 0) {
          fs.readSync(fd, newBuf, 0, newBuf.length, startBytes);
        }
        fs.closeSync(fd);

        const lines = newBuf.toString("utf8")
          .split("\n")
          .filter((l: string) => l.trim().length > 0)
          .map((l: string) => {
            try { return JSON.parse(l); } catch { return { raw: l }; }
          });

        return { url, rows: lines.length, results: lines };
      } finally {
        // Scheduler.finalize() closes the JSONL stream and the browser
        // pool per phase, but leaves the SQLite handle (and its cached
        // prepared statements) open. Force-close so N MCP calls don't
        // leak N DB fds + their statement caches.
        try { scheduler.getDb().close(); } catch { /* already closed */ }
      }
    });
  },
};

// ── krawl_query ──────────────────────────────────────────────────────────────

const krawl_query: ToolDef = {
  name        : "krawl_query",
  description :
    "Run an arbitrary SQL SELECT against the Krawl SQLite database. " +
    "Tables include: pages, stocks, news, market_indices, files, links, " +
    "domains, endpoints, task_log, runs. Returns up to 'limit' rows.",
  inputSchema : {
    type      : "object",
    properties: {
      sql  : { type: "string", description: "SQL SELECT statement" },
      limit: { type: "integer", minimum: 1, maximum: 10000, description: "Row cap (default 100)" },
    },
    required: ["sql"],
  },
  handler: async (args) => {
    const sql   = String(args["sql"] ?? "");
    const limit = Number(args["limit"] ?? 100);
    if (!/^\s*select\b/i.test(sql)) {
      throw new Error("krawl_query: only SELECT statements are allowed");
    }
    const db   = openDb();
    try {
      const qe   = new QueryEngine(db);
      const rows = qe.sql(sql);
      return { rows: rows.length, results: rows.slice(0, limit) };
    } finally {
      db.close();
    }
  },
};

// ── krawl_search ─────────────────────────────────────────────────────────────

const krawl_search: ToolDef = {
  name        : "krawl_search",
  description :
    "Full-text search across collected pages/news/files using SQLite FTS5. " +
    "Returns the top matches ranked by relevance.",
  inputSchema : {
    type      : "object",
    properties: {
      query: { type: "string", description: "FTS5 search query" },
      table: {
        type: "string",
        enum: ["fts_pages", "fts_news", "fts_files"],
        description: "Which FTS index to search (default fts_pages).",
      },
      limit: { type: "integer", minimum: 1, maximum: 200, description: "Result cap (default 20)" },
    },
    required: ["query"],
  },
  handler: async (args) => {
    const query = String(args["query"] ?? "");
    const table = (args["table"] as "fts_pages" | "fts_news" | "fts_files") ?? "fts_pages";
    const limit = Number(args["limit"] ?? 20);
    const db    = openDb();
    try {
      const qe      = new QueryEngine(db);
      const results = qe.search(query, table, limit);
      return { query, table, hits: results.length, results };
    } finally {
      db.close();
    }
  },
};

// ── krawl_stats ──────────────────────────────────────────────────────────────

const krawl_stats: ToolDef = {
  name        : "krawl_stats",
  description : "Summary of row counts per table plus DB size on disk.",
  inputSchema : { type: "object", properties: {} },
  handler: async () => {
    const db = openDb();
    try {
      const qe = new QueryEngine(db);
      return qe.stats();
    } finally {
      db.close();
    }
  },
};

// ── krawl_export ─────────────────────────────────────────────────────────────

const krawl_export: ToolDef = {
  name        : "krawl_export",
  description :
    "Export one table (or all tables) to CSV under the /exports volume. " +
    "Caddy can serve these at /files/ for direct download.",
  inputSchema : {
    type      : "object",
    properties: {
      table: {
        type: "string",
        description: "Table name, or 'all' to export every table.",
      },
    },
    required: ["table"],
  },
  handler: async (args) => {
    const table = String(args["table"] ?? "all");
    const db    = openDb();
    try {
      const qe  = new QueryEngine(db);
      const exp = new Exporter(qe);
      if (table === "all") {
        const paths = exp.exportAllCsv(EXPORTS_DIR);
        return { exported: paths.length, paths };
      }
      const p = exp.exportCsv(table, EXPORTS_DIR);
      return { exported: p ? 1 : 0, paths: p ? [p] : [] };
    } finally {
      db.close();
    }
  },
};

export const TOOLS: ToolDef[] = [
  krawl_url,
  krawl_query,
  krawl_search,
  krawl_stats,
  krawl_export,
];

export const TOOL_BY_NAME: Record<string, ToolDef> = Object.fromEntries(
  TOOLS.map(t => [t.name, t]),
);
