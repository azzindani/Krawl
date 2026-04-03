// core/scheduler.ts
// Orchestrates all three worker pools simultaneously
// Routes tasks to correct worker by mode
// Collects results, indexes them, checkpoints

import Database from "better-sqlite3";
import pLimit from "p-limit";
import { TaskQueue, Task, makeTask, TaskInput } from "./queue.js";
import { Router } from "./router.js";
import { Checkpoint } from "./checkpoint.js";
import { Timer } from "./timer.js";
import { HttpWorker } from "../workers/http.js";
import { BrowserWorker } from "../workers/browser.js";
import { CrawlWorker } from "../workers/crawl.js";
import { CircuitBreaker } from "../resilience/circuit_breaker.js";
import { RateLimiter } from "../resilience/rate_limiter.js";
import { Indexer } from "../db/indexer.js";
import { StreamWriter } from "../output/stream.js";
import { initSchema } from "../db/schema.js";
import { QueryEngine } from "../db/query.js";
import { DEFAULTS } from "../config/defaults.js";

export interface SchedulerConfig {
  dbPath         ?: string;
  jsonlPath      ?: string;
  checkpointPath ?: string;
  routerCachePath?: string;
  httpConcurrency?: number;
  browserContexts?: number;
  instanceId     ?: string;
  resume         ?: boolean;
}

export class Scheduler {
  private db        : Database.Database;
  private queue     : TaskQueue;
  private router    : Router;
  private checkpoint: Checkpoint;
  private timer     : Timer;
  private indexer   : Indexer;
  private stream    : StreamWriter;
  private breaker   : CircuitBreaker;
  private limiter   : RateLimiter;
  private httpWorker   : HttpWorker;
  private browserWorker: BrowserWorker;
  private crawlWorker  : CrawlWorker;
  private runId     : string;
  private config    : Required<SchedulerConfig>;

  constructor(cfg: SchedulerConfig = {}) {
    this.config = {
      dbPath         : cfg.dbPath          ?? DEFAULTS.DB_PATH,
      jsonlPath      : cfg.jsonlPath        ?? DEFAULTS.JSONL_PATH,
      checkpointPath : cfg.checkpointPath   ?? "krawl_checkpoint.json",
      routerCachePath: cfg.routerCachePath  ?? "router_cache.json",
      httpConcurrency: cfg.httpConcurrency  ?? DEFAULTS.HTTP_CONCURRENCY,
      browserContexts: cfg.browserContexts  ?? DEFAULTS.BROWSER_CONTEXTS,
      instanceId     : cfg.instanceId       ?? "default",
      resume         : cfg.resume           ?? false,
    };

    this.runId = `run_${Date.now()}_${this.config.instanceId}`;

    // Open DB and initialize schema FIRST — Indexer.prepareStatements()
    // calls db.prepare() which validates table existence immediately.
    this.db = new Database(this.config.dbPath);
    initSchema(this.db);

    // Initialize all other components
    this.breaker  = new CircuitBreaker();
    this.limiter  = new RateLimiter();
    this.queue    = new TaskQueue();
    this.router   = new Router(this.config.routerCachePath);
    this.timer    = new Timer(this.runId);
    this.indexer  = new Indexer(this.db);
    this.stream   = new StreamWriter(this.config.jsonlPath);

    this.checkpoint = new Checkpoint(
      this.config.checkpointPath,
      this.runId,
      this.config as Record<string, unknown>
    );

    this.httpWorker = new HttpWorker(
      this.config.httpConcurrency,
      this.breaker,
      this.limiter,
    );

    this.browserWorker = new BrowserWorker(
      this.config.browserContexts,
      this.breaker,
      this.limiter,
    );

    this.crawlWorker = new CrawlWorker(this.breaker, this.limiter);
  }

  addTasks(inputs: TaskInput[]): void {
    const doneUrls = this.config.resume
      ? this.checkpoint.getDoneUrls()
      : new Set<string>();

    for (const input of inputs) {
      if (doneUrls.has(input.url)) continue;
      this.queue.enqueue(makeTask(input));
    }

    console.log(
      `Tasks: ${this.queue.pendingCount} pending` +
      (doneUrls.size > 0 ? ` (${doneUrls.size} skipped from checkpoint)` : "")
    );
  }

  // Main execution loop
  async run(): Promise<void> {
    const total = this.queue.pendingCount;
    if (total === 0) {
      console.log("No tasks to run.");
      return;
    }

    console.log("\n" + "=".repeat(60));
    console.log(`KRAWL ENGINE — run ${this.runId}`);
    console.log("=".repeat(60));
    console.log(`Total tasks : ${total}`);
    console.log(`Instance    : ${this.config.instanceId}`);
    console.log(`Database    : ${this.config.dbPath}`);
    console.log(`Output      : ${this.config.jsonlPath}`);
    console.log("");

    // Record run in DB
    this.db.prepare(`
      INSERT INTO runs (run_id, started_at, total_tasks, instance_id, config)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      this.runId,
      new Date().toISOString(),
      total,
      this.config.instanceId,
      JSON.stringify(this.config),
    );

    this.timer.startPhase("total", total);

    // Phase 1: resolve all auto modes
    await this.resolveAutoModes();

    // Phase 2: split by mode and run all three pools
    await this.runAllPools();

    // Finalize
    await this.finalize(total);
  }

  private async resolveAutoModes(): Promise<void> {
    if (this.queue.pendingCount === 0) return;

    // Drain all pending tasks without touching running/done maps
    const allTasks  = this.queue.drainPending();
    const autoTasks = allTasks.filter(t => t.mode === "auto");
    const rest      = allTasks.filter(t => t.mode !== "auto");

    if (autoTasks.length > 0) {
      console.log(`Resolving mode for ${autoTasks.length} auto tasks...`);

      // Resolve concurrently but cap at 10
      const limit   = pLimit(10);
      const resolved = await Promise.all(
        autoTasks.map(task => limit(async () => {
          task.mode = await this.router.resolve(task.url);
          return task;
        }))
      );

      rest.push(...resolved);
    }

    // Re-enqueue all tasks with their resolved modes
    for (const task of rest) {
      task.status = "pending";
      this.queue.enqueue(task);
    }
  }

  private async runAllPools(): Promise<void> {
    // Collect all pending tasks
    const allTasks: Task[] = [];
    while (this.queue.pendingCount > 0) {
      const t = this.queue.dequeue();
      if (t) allTasks.push(t);
    }

    // Split by mode
    const httpTasks    = allTasks.filter(t =>
      t.mode === "http_json" || t.mode === "http_curl"
    );
    const browserTasks = allTasks.filter(t => t.mode === "browser");
    const crawlTasks   = allTasks.filter(t => t.mode === "crawl");
    const blocked      = allTasks.filter(t => t.mode === "blocked");

    if (blocked.length > 0) {
      console.log(`\n⚡ ${blocked.length} tasks blocked (Cloudflare Turnstile):`);
      for (const t of blocked) console.log(`   - ${t.name} (${t.url})`);
    }

    console.log(`\nRouting:`);
    console.log(`  HTTP    : ${httpTasks.length}`);
    console.log(`  Browser : ${browserTasks.length}`);
    console.log(`  Crawl   : ${crawlTasks.length}`);
    console.log(`  Blocked : ${blocked.length}`);
    console.log("");

    // Run HTTP and Browser concurrently, Crawl sequentially.
    // Each phase catches its own errors so a browser launch failure
    // doesn't discard already-computed HTTP results.
    const [httpResults, browserResults] = await Promise.all([
      httpTasks.length > 0
        ? this.runHttpPhase(httpTasks).catch((e: Error) => {
            console.error(`\n[HTTP phase error] ${e.message}`);
            return [] as unknown[];
          })
        : Promise.resolve([] as unknown[]),
      browserTasks.length > 0
        ? this.runBrowserPhase(browserTasks).catch((e: Error) => {
            console.error(`\n[Browser phase error] ${e.message}`);
            return [] as unknown[];
          })
        : Promise.resolve([] as unknown[]),
    ]);

    // Crawl runs after HTTP/Browser to avoid saturating bandwidth
    const crawlResults = crawlTasks.length > 0
      ? await this.runCrawlPhase(crawlTasks).catch((e: Error) => {
          console.error(`\n[Crawl phase error] ${e.message}\n${e.stack}`);
          return [] as unknown[];
        })
      : [];

    // Process all results
    const allResults = [...httpResults, ...browserResults, ...crawlResults];
    for (const result of allResults) {
      this.processResult(result as Record<string, unknown>);
    }
  }

  private async runHttpPhase(tasks: Task[]): Promise<unknown[]> {
    console.log(`─── HTTP PHASE (${tasks.length} tasks) ───`);
    this.timer.startPhase("http", tasks.length);

    const results = await this.httpWorker.run(tasks);

    for (const r of results) {
      const ok = r.status === "ok";
      const s  = (r.elapsedMs / 1000).toFixed(2);
      console.log(
        `  ${ok ? "✓" : "✗"} [HTTP] ${r.task.name.padEnd(20)} ${s}s` +
        (r.price != null ? `  price=${r.price}` : "") +
        (r.error ? `  ERR: ${r.error.slice(0, 40)}` : "")
      );
      this.timer.tick("http", r.mode, new URL(r.url).hostname, r.elapsedMs, !ok);
      this.timer.display();
    }

    this.timer.endPhase("http");
    return results;
  }

  private async runBrowserPhase(tasks: Task[]): Promise<unknown[]> {
    console.log(`\n─── BROWSER PHASE (${tasks.length} tasks) ───`);
    this.timer.startPhase("browser", tasks.length);

    await this.browserWorker.launch();
    const results = await this.browserWorker.run(tasks);

    for (const r of results) {
      const ok = r.status === "ok";
      const s  = (r.elapsedMs / 1000).toFixed(2);
      const ext = r.extracted;
      const info = (ext["count"] != null)
        ? `${ext["count"]} headlines`
        : (ext["price"] != null)
          ? `price=${ext["price"]}`
          : r.title.slice(0, 40);

      console.log(
        `  ${ok ? "✓" : "✗"} [BRWS] ${r.task.name.padEnd(20)} ${s}s  ${info}` +
        (r.error ? `  ERR: ${r.error.slice(0, 40)}` : "")
      );
      this.timer.tick("browser", "browser",
        new URL(r.url).hostname, r.elapsedMs, !ok);
      this.timer.display();
    }

    await this.browserWorker.close();
    this.timer.endPhase("browser");
    return results;
  }

  private async runCrawlPhase(tasks: Task[]): Promise<unknown[]> {
    console.log(`\n─── CRAWL PHASE (${tasks.length} tasks) ───`);
    this.timer.startPhase("crawl", tasks.length);

    const allResults: unknown[] = [];

    for (const task of tasks) {
      const results = await this.crawlWorker.run(task);

      for (const r of results) {
        const ok = r.status === "ok";
        const s  = (r.elapsedMs / 1000).toFixed(2);
        console.log(
          `  ${ok ? "✓" : "✗"} [CRAWL] ${r.url.slice(0, 50).padEnd(52)} ${s}s` +
          `  links=${r.links.length} files=${r.files.length}`
        );
        this.timer.tick("crawl", "crawl",
          new URL(r.url).hostname, r.elapsedMs, !ok);
        this.timer.display();
        allResults.push(r);
      }

      // Spawn crawl-discovered tasks back into queue
      try {
        if (task.crawlDepth && task.crawlDepth > 0) {
          const newUrls = results.flatMap(r => r.links);
          this.queue.spawnFromCrawl(task, newUrls);
        }
      } catch (spawnErr) {
        const e = spawnErr as Error;
        console.error(`\n[Spawn error for ${task.name}] ${e.message}\n${e.stack}`);
      }
    }

    this.timer.endPhase("crawl");
    return allResults;
  }

  private processResult(result: Record<string, unknown>): void {
    // Stream to JSONL immediately
    this.stream.write(result);

    // Index to database
    const report = this.indexer.index(result, this.runId);

    // Log task
    const task = result["task"] as Task | undefined;
    if (task) {
      this.indexer.logTask(
        this.runId, task.id, task.name,
        result["url"] as string,
        result["mode"] as string,
        result["status"] as string,
        result["elapsedMs"] as number,
        result["error"] as string | undefined,
      );
      this.queue.markDone(task.id);
    }

    // Checkpoint periodically
    if (this.queue.doneCount % DEFAULTS.CHECKPOINT_EVERY === 0) {
      this.checkpoint.save(this.queue.getDoneUrls(), this.queue.totalCount);
    }
  }

  private async finalize(total: number): Promise<void> {
    this.timer.endPhase("total");

    // Final checkpoint
    this.checkpoint.save(this.queue.getDoneUrls(), total);

    // Close stream
    await this.stream.close();

    // Update run record
    this.db.prepare(`
      UPDATE runs SET
        finished_at = ?,
        completed   = ?,
        errors      = ?
      WHERE run_id = ?
    `).run(
      new Date().toISOString(),
      this.queue.doneCount,
      this.queue.deadCount,
      this.runId,
    );

    // Print summary
    this.timer.summary();
    this.printFinalStats();

    // Print dead letter queue
    const dead = this.queue.getDeadLetter();
    if (dead.length > 0) {
      console.log(`\n⚡ Dead letter queue (${dead.length} tasks):`);
      for (const t of dead) {
        console.log(`  - ${t.name}: ${t.error}`);
      }
    }
  }

  private printFinalStats(): void {
    const qe = new QueryEngine(this.db);
    qe.printStats();
    console.log(`\nOutput files:`);
    console.log(`  JSONL    : ${this.config.jsonlPath}`);
    console.log(`  Database : ${this.config.dbPath}`);
    console.log(`  Checkpoint: ${this.config.checkpointPath}`);
  }

  getDb()    : Database.Database { return this.db; }
  getIndexer(): Indexer           { return this.indexer; }
  getQuery()  : QueryEngine       { return new QueryEngine(this.db); }
}
