// db/indexer.ts
// Auto-routes every engine result to correct table(s)
// FTS5 indexed simultaneously
// Deduplication via content hash

import Database from "better-sqlite3";
import crypto from "crypto";
import path from "path";
import { URL } from "url";

export interface IndexReport {
  indexed : string[];
  skipped : string[];
  errors  : string[];
}

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function safeFloat(v: unknown): number | null {
  if (v == null || v === "") return null;
  const s = String(v).replace(/,/g, "").trim();
  const multipliers: Record<string, number> = {
    T: 1e12, B: 1e9, M: 1e6, K: 1e3,
  };
  const last = s.slice(-1).toUpperCase();
  if (multipliers[last]) {
    const base = parseFloat(s.slice(0, -1));
    return isNaN(base) ? null : base * multipliers[last];
  }
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

export class Indexer {
  private db: Database.Database;

  // Pre-compiled statements for performance
  private stmts: Record<string, Database.Statement>;

  constructor(db: Database.Database) {
    this.db    = db;
    this.stmts = this.prepareStatements();
  }

  private prepareStatements(): Record<string, Database.Statement> {
    return {
      upsertPage: this.db.prepare(`
        INSERT INTO pages
          (url, domain, title, status, mode, content_hash,
           first_seen, last_seen, elapsed_ms, source_group, run_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(url) DO UPDATE SET
          last_seen    = excluded.last_seen,
          content_hash = excluded.content_hash,
          elapsed_ms   = excluded.elapsed_ms,
          title        = COALESCE(excluded.title, title)
      `),

      deleteFtsPage: this.db.prepare(
        `DELETE FROM fts_pages WHERE url = ?`
      ),

      insertFtsPage: this.db.prepare(`
        INSERT INTO fts_pages (url, title, content, source)
        VALUES (?, ?, ?, ?)
      `),

      insertStock: this.db.prepare(`
        INSERT INTO stocks
          (ticker, company_name, price, change_val, change_pct,
           volume, market_cap, day_high, day_low, prev_close,
           week52_high, week52_low, currency, exchange,
           source_url, extracted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),

      insertNews: this.db.prepare(`
        INSERT OR IGNORE INTO news
          (source, headline, url, content, extracted_at, content_hash)
        VALUES (?, ?, ?, ?, ?, ?)
      `),

      insertFtsNews: this.db.prepare(`
        INSERT INTO fts_news (headline, source, url, content)
        VALUES (?, ?, ?, ?)
      `),

      insertIndex: this.db.prepare(`
        INSERT INTO market_indices
          (index_name, price, change_val, change_pct, source_url, extracted_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `),

      insertFile: this.db.prepare(`
        INSERT OR IGNORE INTO files
          (source_url, discovered_from, filename, ext,
           content_hash, extracted_at, status)
        VALUES (?, ?, ?, ?, ?, ?, 'discovered')
      `),

      insertFtsFile: this.db.prepare(`
        INSERT INTO fts_files (filename, source_url, ext, content_text)
        VALUES (?, ?, ?, ?)
      `),

      insertLink: this.db.prepare(`
        INSERT INTO links (from_url, to_url, anchor_text, discovered_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(from_url, to_url) DO NOTHING
      `),

      insertEndpoint: this.db.prepare(`
        INSERT INTO endpoints
          (url, method, discovered_from, params,
           response_schema, first_seen, last_seen)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(url) DO UPDATE SET last_seen = excluded.last_seen
      `),

      upsertDomain: this.db.prepare(`
        INSERT INTO domains
          (domain, mode, last_seen, total_pages, total_errors,
           avg_ms, circuit_state, updated_at)
        VALUES (?, ?, ?, 1, ?, ?, 'closed', ?)
        ON CONFLICT(domain) DO UPDATE SET
          mode         = COALESCE(excluded.mode, mode),
          last_seen    = excluded.last_seen,
          total_pages  = total_pages + 1,
          total_errors = total_errors + excluded.total_errors,
          avg_ms       = (COALESCE(avg_ms, 0) * total_pages +
                         excluded.avg_ms) / (total_pages + 1),
          updated_at   = excluded.updated_at
      `),

      logTask: this.db.prepare(`
        INSERT INTO task_log
          (run_id, task_id, task_name, url, mode, status,
           elapsed_ms, error, ts)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
    };
  }

  // ── Main entry point ────────────────────────────────────────────

  // Uses a transaction for atomic multi-table inserts
  index(result: Record<string, unknown>, runId: string): IndexReport {
    const report: IndexReport = { indexed: [], skipped: [], errors: [] };

    const indexFn = this.db.transaction(() => {
      try {
        this._indexPage(result, runId, report);
        this._routeExtracted(result, report);
        this._indexLinks(result, report);
        this._updateDomain(result);
      } catch (e) {
        report.errors.push(String(e).slice(0, 100));
      }
    });

    indexFn();
    return report;
  }

  logTask(
    runId: string, taskId: string, taskName: string,
    url: string, mode: string, status: string,
    elapsedMs: number, error?: string
  ): void {
    this.stmts.logTask.run(
      runId, taskId, taskName, url, mode, status,
      elapsedMs, error ?? null, new Date().toISOString()
    );
  }

  // ── Private indexers ────────────────────────────────────────────

  private _indexPage(
    result: Record<string, unknown>,
    runId : string,
    report: IndexReport
  ): void {
    const url = result["url"] as string;
    if (!url) return;

    const domain  = this._domain(url);
    const now     = new Date().toISOString();
    const content = this._extractContent(result);

    this.stmts.upsertPage.run(
      url, domain,
      (result["title"] as string) ?? "",
      (result["status"] as string) ?? "",
      (result["mode"] as string) ?? "",
      content ? sha256(content) : null,
      now, now,
      (result["elapsedMs"] as number) ?? (result["elapsed_ms"] as number) ?? null,
      (result["group"] as string) ?? (result["source"] as string) ?? "",
      runId
    );

    // FTS update
    this.stmts.deleteFtsPage.run(url);
    this.stmts.insertFtsPage.run(
      url,
      (result["title"] as string) ?? "",
      content.slice(0, 50_000),
      (result["group"] as string) ?? "",
    );

    report.indexed.push("page");
  }

  private _routeExtracted(
    result: Record<string, unknown>,
    report: IndexReport
  ): void {
    const group      = (result["group"] as string) ?? "";
    const source     = (result["source"] as string) ?? "";
    const extractType = (result["extractType"] as string) ?? "";
    const extracted  = (result["extracted"] as Record<string, unknown>) ?? {};
    const now        = new Date().toISOString();
    const url        = (result["url"] as string) ?? "";

    // ── Stocks ──
    if (group === "Yahoo" || source === "yahoo_http" ||
        extractType === "stock_price" || extracted["price"] != null) {
      const ticker = (
        (result["ticker"] as string) ??
        (result["name"] as string ?? "").replace(/ Stock.*/, "")
      );
      if (ticker) {
        this.stmts.insertStock.run(
          ticker,
          (extracted["companyName"] as string) ??
            (extracted["company_name"] as string) ??
            (result["company"] as string) ?? "",
          safeFloat(extracted["price"] ?? result["price"]),
          safeFloat(extracted["change"] ?? extracted["change_val"]),
          safeFloat(extracted["changePct"] ?? extracted["change_pct"]),
          safeFloat(extracted["volume"]),
          safeFloat(extracted["marketCap"] ?? extracted["market_cap"]),
          safeFloat(extracted["dayHigh"]   ?? extracted["day_high"]),
          safeFloat(extracted["dayLow"]    ?? extracted["day_low"]),
          safeFloat(extracted["prevClose"] ?? result["prev_close"]),
          safeFloat(extracted["week52High"]),
          safeFloat(extracted["week52Low"]),
          (result["currency"] as string) ?? "IDR",
          (result["exchange"] as string) ?? "",
          url,
          (result["extractedAt"] as string) ?? now,
        );
        report.indexed.push("stock");
      }
    }

    // ── News ──
    const headlines = extracted["headlines"] as string[] | undefined;
    if (headlines?.length) {
      let count = 0;
      for (const h of headlines) {
        if (!h || h.length < 5) continue;
        const hash = sha256(h);
        const changes = this.stmts.insertNews.run(
          group || source || "unknown",
          h, url, "",
          (result["extractedAt"] as string) ?? now,
          hash,
        );
        if (changes.changes > 0) {
          this.stmts.insertFtsNews.run(h, group, url, "");
          count++;
        }
      }
      if (count) report.indexed.push(`news:${count}`);
    }

    // ── Market index ──
    if (group === "INVESTING" || extractType === "index_price") {
      if (extracted["price"] != null) {
        this.stmts.insertIndex.run(
          (result["name"] as string) ?? "",
          safeFloat(extracted["price"]),
          (extracted["change"] as string) ?? null,
          (extracted["changePct"] as string) ?? null,
          url,
          (result["extractedAt"] as string) ?? now,
        );
        report.indexed.push("index");
      }
    }

    // ── Files ──
    const files = extracted["files"] as Array<{
      url: string; text?: string; ext?: string
    }> | undefined;
    if (files?.length) {
      let count = 0;
      for (const f of files) {
        if (!f.url) continue;
        const filename = path.basename(new URL(f.url).pathname);
        const ext      = f.ext ?? path.extname(filename).toLowerCase();
        const hash     = sha256(f.url);
        const changes  = this.stmts.insertFile.run(
          f.url, url, filename, ext, hash, now
        );
        if (changes.changes > 0) {
          this.stmts.insertFtsFile.run(filename, f.url, ext, "");
          count++;
        }
      }
      if (count) report.indexed.push(`files:${count}`);
    }

    // ── API endpoints from XHR interception ──
    const endpoints = extracted["endpoints"] as Array<{
      url: string; method?: string; response_keys?: string[]
    }> | undefined;
    if (endpoints?.length) {
      let count = 0;
      for (const ep of endpoints) {
        if (!ep.url) continue;
        this.stmts.insertEndpoint.run(
          ep.url,
          ep.method ?? "GET",
          url,
          null,
          JSON.stringify(ep.response_keys ?? []),
          now, now,
        );
        count++;
      }
      if (count) report.indexed.push(`endpoints:${count}`);
    }
  }

  private _indexLinks(
    result: Record<string, unknown>,
    report: IndexReport
  ): void {
    const fromUrl = (result["url"] as string) ?? "";
    const links   = (result["links"] as string[]) ?? [];
    if (!links.length) return;

    const now = new Date().toISOString();
    let count = 0;
    for (const link of links) {
      if (typeof link !== "string") continue;
      this.stmts.insertLink.run(fromUrl, link, null, now);
      count++;
    }
    if (count) report.indexed.push(`links:${count}`);
  }

  private _updateDomain(result: Record<string, unknown>): void {
    const url = (result["url"] as string) ?? "";
    if (!url) return;
    const domain  = this._domain(url);
    const now     = new Date().toISOString();
    const isError = ["error","blocked","timeout"].includes(
      (result["status"] as string) ?? ""
    );

    this.stmts.upsertDomain.run(
      domain,
      (result["mode"] as string) ?? null,
      now,
      isError ? 1 : 0,
      (result["elapsedMs"] as number) ?? 0,
      now,
    );
  }

  private _extractContent(result: Record<string, unknown>): string {
    const ext = result["extracted"] as Record<string, unknown> | null ?? {};
    // headlines is an array — join with newlines so FTS tokenises each headline
    const headlines = ext["headlines"] as string[] | undefined;
    return (
      (ext["text_preview"] as string) ??
      (ext["preview"]      as string) ??
      headlines?.join("\n") ??
      ""
    ).slice(0, 50_000);
  }

  private _domain(url: string): string {
    try { return new URL(url).hostname; }
    catch { return url; }
  }
}
