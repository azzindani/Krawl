#!/usr/bin/env tsx
// krawl.ts — main entry point
// Usage:
//   npx tsx krawl.ts --url https://example.com
//   npx tsx krawl.ts --tasks tasks/financial.json
//   npx tsx krawl.ts --tasks tasks/financial.json --resume
//   npx tsx krawl.ts --query "SELECT * FROM stocks"
//   npx tsx krawl.ts --search "suku bunga"
//   npx tsx krawl.ts --export all
//   npx tsx krawl.ts --stats

import fs from "fs";
import path from "path";
import { Scheduler } from "./core/scheduler.js";
import { QueryEngine } from "./db/query.js";
import { Exporter } from "./output/export.js";
import { initSchema } from "./db/schema.js";
import { DEFAULTS } from "./config/defaults.js";
import type { TaskInput } from "./core/queue.js";
import Database from "better-sqlite3";

// ── CLI argument parser ───────────────────────────────────────────

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

// ── Load tasks from file or URL ───────────────────────────────────

function loadTasks(source: string): TaskInput[] {
  // Single URL
  if (source.startsWith("http")) {
    return [{ url: source, mode: "auto" }];
  }

  // JSON file
  if (source.endsWith(".json")) {
    const raw = JSON.parse(fs.readFileSync(source, "utf8")) as
      TaskInput | TaskInput[];
    return Array.isArray(raw) ? raw : [raw];
  }

  // Plain text file — one URL per line
  if (source.endsWith(".txt")) {
    return fs.readFileSync(source, "utf8")
      .split("\n")
      .map(l => l.trim())
      .filter(l => l.startsWith("http"))
      .map(url => ({ url, mode: "auto" as const }));
  }

  throw new Error(`Unknown task source: ${source}`);
}

// ── Print usage ───────────────────────────────────────────────────

function printUsage(): void {
  console.log(`
KRAWL — Knowledge Retrieval and Web Logic Engine
v1.0.0

USAGE:
  npx tsx krawl.ts [command] [options]

COMMANDS:
  --url <url>           Run on single URL
  --tasks <file>        Run tasks from JSON/TXT file
  --domain <domain>     Crawl entire domain
  --query <sql>         Query the database
  --search <text>       Full-text search
  --export <table|all>  Export to CSV
  --stats               Show database statistics
  --help                Show this help

OPTIONS:
  --db <path>           Database file (default: krawl.db)
  --output <path>       JSONL output file (default: krawl_output.jsonl)
  --resume              Resume from checkpoint
  --instance <id>       Instance ID for parallel runs
  --depth <n>           Crawl depth (default: 0)
  --concurrency <n>     HTTP concurrency (default: 5)
  --browsers <n>        Browser contexts (default: 3)

EXAMPLES:
  # Single URL
  npx tsx krawl.ts --url https://finance.yahoo.com/quote/BBCA.JK/

  # Run task file
  npx tsx krawl.ts --tasks tasks/financial.json

  # Resume interrupted run
  npx tsx krawl.ts --tasks tasks/financial.json --resume

  # Parallel instances
  npx tsx krawl.ts --tasks batch1.json --instance 1 --db engine1.db &
  npx tsx krawl.ts --tasks batch2.json --instance 2 --db engine2.db &

  # Query collected data
  npx tsx krawl.ts --query "SELECT * FROM stocks WHERE ticker='BBCA'"
  npx tsx krawl.ts --search "suku bunga"

  # Export
  npx tsx krawl.ts --export stocks
  npx tsx krawl.ts --export all
`);
}

// ── Main ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (args["help"]) {
    printUsage();
    return;
  }

  const dbPath = (args["db"] as string) ?? DEFAULTS.DB_PATH;

  // ── Query mode ───────────────────────────────────────────────
  if (args["query"]) {
    const db = new Database(dbPath);
    initSchema(db);
    const qe   = new QueryEngine(db);
    const rows = qe.sql(args["query"] as string);
    console.log(JSON.stringify(rows, null, 2));
    db.close();
    return;
  }

  // ── Search mode ──────────────────────────────────────────────
  if (args["search"]) {
    const db = new Database(dbPath);
    initSchema(db);
    const qe      = new QueryEngine(db);
    const results = qe.search(
      args["search"] as string,
      (args["table"] as "fts_pages" | "fts_news" | "fts_files") ?? "fts_pages"
    );
    console.log(`\nSearch: "${args["search"]}" — ${results.length} results\n`);
    for (const r of results) {
      console.log(`  URL  : ${String(r["url"] ?? "").slice(0, 80)}`);
      console.log(`  Title: ${String(r["title"] ?? "").slice(0, 60)}`);
      console.log(`  Text : ${String(r["content"] ?? "").slice(0, 100)}`);
      console.log("");
    }
    db.close();
    return;
  }

  // ── Stats mode ───────────────────────────────────────────────
  if (args["stats"]) {
    const db = new Database(dbPath);
    initSchema(db);
    const qe = new QueryEngine(db);
    qe.printStats();
    db.close();
    return;
  }

  // ── Export mode ──────────────────────────────────────────────
  if (args["export"]) {
    const db      = new Database(dbPath);
    initSchema(db);
    const qe      = new QueryEngine(db);
    const exp     = new Exporter(qe);
    const outDir  = (args["out"] as string) ?? "krawl_exports";

    if (args["export"] === "all") {
      console.log(`Exporting all tables to ${outDir}/`);
      exp.exportAllCsv(outDir);
    } else {
      const p = exp.exportCsv(args["export"] as string, outDir);
      console.log(`Exported → ${p}`);
    }
    db.close();
    return;
  }

  // ── Run mode ─────────────────────────────────────────────────
  let taskInputs: TaskInput[] = [];

  if (args["url"]) {
    taskInputs = loadTasks(args["url"] as string);
  } else if (args["tasks"]) {
    taskInputs = loadTasks(args["tasks"] as string);
  } else if (args["domain"]) {
    taskInputs = [{
      url        : `https://${args["domain"]}`,
      mode       : "crawl",
      crawl_depth: parseInt((args["depth"] as string) ?? "2"),
    }];
  } else {
    printUsage();
    return;
  }

  if (taskInputs.length === 0) {
    console.error("No tasks loaded.");
    process.exit(1);
  }

  const scheduler = new Scheduler({
    dbPath         : dbPath,
    jsonlPath      : (args["output"] as string) ?? DEFAULTS.JSONL_PATH,
    checkpointPath : `krawl_checkpoint_${(args["instance"] as string) ?? "default"}.json`,
    routerCachePath: "router_cache.json",
    httpConcurrency: parseInt((args["concurrency"] as string) ?? String(DEFAULTS.HTTP_CONCURRENCY)),
    browserContexts: parseInt((args["browsers"] as string) ?? String(DEFAULTS.BROWSER_CONTEXTS)),
    instanceId     : (args["instance"] as string) ?? "default",
    resume         : !!args["resume"],
  });

  // Apply depth to crawl tasks if specified
  if (args["depth"]) {
    const depth = parseInt(args["depth"] as string);
    taskInputs  = taskInputs.map(t => ({ ...t, crawl_depth: depth }));
  }

  scheduler.addTasks(taskInputs);
  await scheduler.run();

  process.exit(0);
}

main().catch(err => {
  console.error("\nFatal error:", err);
  process.exit(1);
});
