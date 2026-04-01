// output/export.ts
// Export database tables to CSV or JSON files

import fs from "fs";
import path from "path";
import { QueryEngine } from "../db/query.js";

export class Exporter {
  constructor(private query: QueryEngine) {}

  exportCsv(
    table    : string,
    outDir   : string,
    limit    : number = 100_000
  ): string {
    fs.mkdirSync(outDir, { recursive: true });
    const csv      = this.query.toCsv(table, limit);
    if (!csv) return "";
    const outPath  = path.join(outDir, `${table}.csv`);
    fs.writeFileSync(outPath, csv);
    return outPath;
  }

  exportAllCsv(outDir: string): string[] {
    const tables = [
      "pages", "stocks", "news", "market_indices",
      "files", "links", "domains", "endpoints",
    ];
    const paths: string[] = [];
    for (const t of tables) {
      try {
        const p = this.exportCsv(t, outDir);
        if (p) {
          paths.push(p);
          console.log(`  ✓ Exported ${t} → ${p}`);
        }
      } catch (e) {
        console.log(`  ✗ Failed to export ${t}: ${(e as Error).message}`);
      }
    }
    return paths;
  }

  exportJson(
    table  : string,
    outDir : string
  ): string {
    fs.mkdirSync(outDir, { recursive: true });
    const rows    = this.query.sql(`SELECT * FROM ${table}`);
    const outPath = path.join(outDir, `${table}.json`);
    fs.writeFileSync(outPath, JSON.stringify(rows, null, 2));
    return outPath;
  }
}
