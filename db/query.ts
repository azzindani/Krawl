// db/query.ts
// Query helpers + full-text search interface

import Database from "better-sqlite3";

export class QueryEngine {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  // Run any SQL query
  sql<T = Record<string, unknown>>(
    query : string,
    params: unknown[] = []
  ): T[] {
    return this.db.prepare(query).all(...params) as T[];
  }

  // Full-text search
  search(
    query     : string,
    table     : "fts_pages" | "fts_news" | "fts_files" = "fts_pages",
    limit     : number = 20
  ): Record<string, unknown>[] {
    return this.db.prepare(`
      SELECT * FROM ${table}
      WHERE ${table} MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(query, limit) as Record<string, unknown>[];
  }

  // Database statistics
  stats(): Record<string, number> {
    const tables = [
      "pages", "stocks", "news", "market_indices",
      "files", "links", "domains", "endpoints",
      "task_log", "runs",
    ];
    const result: Record<string, number> = {};
    for (const t of tables) {
      try {
        const row = this.db.prepare(
          `SELECT COUNT(*) as n FROM ${t}`
        ).get() as { n: number };
        result[t] = row.n;
      } catch {
        result[t] = 0;
      }
    }
    const size = this.db.prepare(
      `SELECT page_count * page_size as s FROM pragma_page_count(), pragma_page_size()`
    ).get() as { s: number };
    result["db_bytes"] = size?.s ?? 0;
    return result;
  }

  // Export table to CSV string
  toCsv(table: string, limit: number = 100_000): string {
    const rows = this.db.prepare(
      `SELECT * FROM ${table} LIMIT ?`
    ).all(limit) as Record<string, unknown>[];
    if (!rows.length) return "";

    const headers = Object.keys(rows[0]);
    const lines   = [headers.join(",")];
    for (const row of rows) {
      lines.push(
        headers.map(h => {
          const v = String(row[h] ?? "");
          return v.includes(",") || v.includes('"') || v.includes("\n")
            ? `"${v.replace(/"/g, '""')}"`
            : v;
        }).join(",")
      );
    }
    return lines.join("\n");
  }

  printStats(): void {
    const s = this.stats();
    console.log("\n=== DATABASE STATISTICS ===");
    const tableRows = Object.entries(s).filter(([k]) => k !== "db_bytes");
    for (const [table, count] of tableRows) {
      console.log(`  ${table.padEnd(18)} ${count.toLocaleString().padStart(10)} rows`);
    }
    const mb = ((s["db_bytes"] ?? 0) / 1024 / 1024).toFixed(2);
    console.log(`\n  Database size : ${mb} MB`);
  }
}
