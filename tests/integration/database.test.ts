import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import os from "os";
import { initSchema } from "../../db/schema.js";
import { QueryEngine } from "../../db/query.js";
import { Indexer } from "../../db/indexer.js";
import { Exporter } from "../../output/export.js";

function tmpDb(): string {
  return path.join(os.tmpdir(), `krawl_test_${Date.now()}_${Math.random()}.db`);
}

describe("Database integration", () => {
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    dbPath = tmpDb();
    db = new Database(dbPath);
    initSchema(db);
  });

  afterEach(() => {
    db.close();
    for (const suffix of ["", "-shm", "-wal"]) {
      try { fs.unlinkSync(dbPath + suffix); } catch { /* ignore */ }
    }
  });

  describe("Schema initialization", () => {
    it("creates all core tables", () => {
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      ).all() as { name: string }[];
      const names = tables.map(t => t.name);

      expect(names).toContain("runs");
      expect(names).toContain("task_log");
      expect(names).toContain("pages");
      expect(names).toContain("stocks");
      expect(names).toContain("news");
      expect(names).toContain("market_indices");
      expect(names).toContain("files");
      expect(names).toContain("links");
      expect(names).toContain("domains");
      expect(names).toContain("endpoints");
    });

    it("creates FTS5 virtual tables", () => {
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'fts_%'"
      ).all() as { name: string }[];
      const names = tables.map(t => t.name);

      expect(names).toContain("fts_pages");
      expect(names).toContain("fts_news");
      expect(names).toContain("fts_files");
    });

    it("sets WAL journal mode", () => {
      const row = db.pragma("journal_mode") as { journal_mode: string }[];
      expect(row[0].journal_mode).toBe("wal");
    });

    it("is idempotent (can run twice)", () => {
      expect(() => initSchema(db)).not.toThrow();
    });
  });

  describe("Indexer", () => {
    let indexer: Indexer;

    beforeEach(() => {
      indexer = new Indexer(db);
    });

    it("indexes a page result", () => {
      const report = indexer.index({
        url: "https://example.com/page1",
        title: "Example Page",
        status: "ok",
        mode: "http_json",
        group: "test",
        elapsedMs: 150,
      }, "run_1");

      expect(report.indexed).toContain("page");
      expect(report.errors).toHaveLength(0);

      const pages = db.prepare("SELECT * FROM pages").all() as Record<string, unknown>[];
      expect(pages).toHaveLength(1);
      expect(pages[0].url).toBe("https://example.com/page1");
      expect(pages[0].title).toBe("Example Page");
    });

    it("indexes stock data", () => {
      indexer.index({
        url: "https://finance.yahoo.com/quote/BBCA.JK",
        name: "BBCA",
        group: "Yahoo",
        extracted: {
          price: 9500,
          companyName: "Bank Central Asia",
          volume: "10M",
          change: -50,
          changePct: "-0.52%",
        },
      }, "run_1");

      const stocks = db.prepare("SELECT * FROM stocks").all() as Record<string, unknown>[];
      expect(stocks).toHaveLength(1);
      expect(stocks[0].ticker).toBe("BBCA");
      expect(stocks[0].price).toBe(9500);
      expect(stocks[0].company_name).toBe("Bank Central Asia");
    });

    it("indexes news headlines", () => {
      indexer.index({
        url: "https://news.com/feed",
        group: "NEWS",
        extracted: {
          headlines: [
            "BI Raises Interest Rate to 6.25%",
            "Stock Market Drops 2% on Global Concerns",
          ],
        },
      }, "run_1");

      const news = db.prepare("SELECT * FROM news").all() as Record<string, unknown>[];
      expect(news).toHaveLength(2);
    });

    it("deduplicates news by content hash", () => {
      const result = {
        url: "https://news.com/feed",
        group: "NEWS",
        extracted: {
          headlines: ["Same Headline Twice"],
        },
      };

      indexer.index(result, "run_1");
      indexer.index(result, "run_1");

      const news = db.prepare("SELECT * FROM news").all() as Record<string, unknown>[];
      expect(news).toHaveLength(1);
    });

    it("indexes links", () => {
      indexer.index({
        url: "https://example.com",
        links: ["https://example.com/page1", "https://example.com/page2"],
      }, "run_1");

      const links = db.prepare("SELECT * FROM links").all() as Record<string, unknown>[];
      expect(links).toHaveLength(2);
    });

    it("updates domain stats", () => {
      indexer.index({
        url: "https://example.com/page1",
        mode: "http_json",
        elapsedMs: 200,
      }, "run_1");

      const domains = db.prepare("SELECT * FROM domains").all() as Record<string, unknown>[];
      expect(domains).toHaveLength(1);
      expect(domains[0].domain).toBe("example.com");
    });

    it("logs tasks", () => {
      // Need to create a run first
      db.prepare("INSERT INTO runs (run_id, started_at) VALUES (?, ?)").run("run_1", new Date().toISOString());
      indexer.logTask("run_1", "task_1", "Test Task", "https://example.com", "http_json", "done", 150);

      const logs = db.prepare("SELECT * FROM task_log").all() as Record<string, unknown>[];
      expect(logs).toHaveLength(1);
      expect(logs[0].task_name).toBe("Test Task");
      expect(logs[0].status).toBe("done");
    });

    it("handles errors gracefully", () => {
      const report = indexer.index({}, "run_1");
      // Should not crash; may skip or log errors
      expect(report).toBeDefined();
    });
  });

  describe("QueryEngine", () => {
    let qe: QueryEngine;
    let indexer: Indexer;

    beforeEach(() => {
      qe = new QueryEngine(db);
      indexer = new Indexer(db);
    });

    it("runs arbitrary SQL queries", () => {
      indexer.index({ url: "https://test.com", title: "Test" }, "run_1");
      const rows = qe.sql("SELECT * FROM pages WHERE url = ?", ["https://test.com"]);
      expect(rows).toHaveLength(1);
    });

    it("returns database statistics", () => {
      const stats = qe.stats();
      expect(stats).toHaveProperty("pages");
      expect(stats).toHaveProperty("stocks");
      expect(stats).toHaveProperty("news");
      expect(stats).toHaveProperty("db_bytes");
      expect(typeof stats.pages).toBe("number");
    });

    it("searches FTS pages", () => {
      indexer.index({
        url: "https://example.com",
        title: "Financial Report Indonesia",
        group: "finance",
        extracted: { text_preview: "Indonesia financial markets Q4 report" },
      }, "run_1");

      const results = qe.search("financial", "fts_pages");
      expect(results.length).toBeGreaterThan(0);
    });

    it("exports to CSV", () => {
      indexer.index({ url: "https://csv.com", title: "CSV Test" }, "run_1");
      const csv = qe.toCsv("pages");
      expect(csv).toContain("url");
      expect(csv).toContain("https://csv.com");
    });

    it("toCsv returns empty string for empty table", () => {
      const csv = qe.toCsv("stocks");
      expect(csv).toBe("");
    });

    it("printStats does not throw", () => {
      expect(() => qe.printStats()).not.toThrow();
    });
  });

  describe("Exporter", () => {
    let qe: QueryEngine;
    let indexer: Indexer;
    let exporter: Exporter;
    let exportDir: string;

    beforeEach(() => {
      qe = new QueryEngine(db);
      indexer = new Indexer(db);
      exporter = new Exporter(qe);
      exportDir = path.join(os.tmpdir(), `krawl_export_${Date.now()}`);
    });

    afterEach(() => {
      try { fs.rmSync(exportDir, { recursive: true }); } catch { /* ignore */ }
    });

    it("exports table to CSV file", () => {
      indexer.index({ url: "https://export.com", title: "Export Test" }, "run_1");
      const outPath = exporter.exportCsv("pages", exportDir);
      expect(outPath).toBeTruthy();
      expect(fs.existsSync(outPath)).toBe(true);
      const content = fs.readFileSync(outPath, "utf8");
      expect(content).toContain("url");
      expect(content).toContain("https://export.com");
    });

    it("exports table to JSON file", () => {
      indexer.index({ url: "https://json.com", title: "JSON Test" }, "run_1");
      const outPath = exporter.exportJson("pages", exportDir);
      expect(fs.existsSync(outPath)).toBe(true);
      const data = JSON.parse(fs.readFileSync(outPath, "utf8"));
      expect(data).toHaveLength(1);
      expect(data[0].url).toBe("https://json.com");
    });

    it("exportAllCsv exports multiple tables", () => {
      indexer.index({ url: "https://all.com", title: "All Test" }, "run_1");
      const paths = exporter.exportAllCsv(exportDir);
      expect(paths.length).toBeGreaterThan(0);
    });

    it("returns empty string for empty table CSV export", () => {
      const outPath = exporter.exportCsv("stocks", exportDir);
      expect(outPath).toBe("");
    });
  });
});
