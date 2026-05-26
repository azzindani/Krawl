// src/maintenance.ts
// Idempotent maintenance pass — safe to call every loop iteration.
//   1. Rotate krawl_output.jsonl → krawl_output.jsonl.<ts>.gz when it
//      crosses KRAWL_JSONL_ROTATE_BYTES (default 100 MB). Truncates in
//      place so any open StreamWriter fd survives.
//   2. VACUUM the SQLite DB at most once per KRAWL_VACUUM_INTERVAL_SECONDS
//      (default 24 h), tracked via .last_vacuum in the data dir.
//
// Run via: npx tsx src/maintenance.ts (or KRAWL_MODE=maintenance).

import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";

const DATA_DIR        = process.env["KRAWL_DATA_DIR"]                 ?? "/data";
const DB_PATH         = process.env["KRAWL_DB_PATH"]                  ?? path.join(DATA_DIR, "krawl.db");
const JSONL_PATH      = process.env["KRAWL_JSONL_PATH"]               ?? path.join(DATA_DIR, "krawl_output.jsonl");
const ROTATE_BYTES    = parseInt(process.env["KRAWL_JSONL_ROTATE_BYTES"]     ?? String(100 * 1024 * 1024), 10);
const VACUUM_INTERVAL = parseInt(process.env["KRAWL_VACUUM_INTERVAL_SECONDS"] ?? String(24 * 60 * 60),     10);
const MARKER          = path.join(DATA_DIR, ".last_vacuum");

function rotateJsonl(): void {
  if (!fs.existsSync(JSONL_PATH)) {
    console.log(`[maintenance] JSONL ${JSONL_PATH} missing, nothing to rotate`);
    return;
  }
  const size = fs.statSync(JSONL_PATH).size;
  if (size <= ROTATE_BYTES) {
    console.log(`[maintenance] JSONL ${size} bytes ≤ ${ROTATE_BYTES} threshold, skip rotate`);
    return;
  }
  const ts     = new Date().toISOString().replace(/[:.]/g, "-");
  const target = `${JSONL_PATH}.${ts}.gz`;
  console.log(`[maintenance] rotating ${size}-byte JSONL → ${target}`);
  // gzip -c keeps source intact; we truncate in-place afterward so any
  // fd held by a long-running StreamWriter (loop mode) keeps writing
  // to the same inode rather than the rotated file.
  execSync(`gzip -c "${JSONL_PATH}" > "${target}"`);
  fs.truncateSync(JSONL_PATH, 0);
  console.log(`[maintenance] rotation complete`);
}

function vacuumDb(): void {
  if (!fs.existsSync(DB_PATH)) {
    console.log(`[maintenance] DB ${DB_PATH} missing, nothing to vacuum`);
    return;
  }
  let lastVacuum = 0;
  if (fs.existsSync(MARKER)) {
    const raw  = fs.readFileSync(MARKER, "utf8").trim();
    lastVacuum = Number.isFinite(Number(raw)) ? parseInt(raw, 10) : 0;
  }
  const now     = Math.floor(Date.now() / 1000);
  const elapsed = now - lastVacuum;
  if (elapsed < VACUUM_INTERVAL) {
    console.log(`[maintenance] VACUUM skipped (${elapsed}s since last; interval ${VACUUM_INTERVAL}s)`);
    return;
  }
  console.log(`[maintenance] running VACUUM (${elapsed}s since last)`);
  const sizeBefore = fs.statSync(DB_PATH).size;
  const db = new Database(DB_PATH);
  try {
    db.exec("VACUUM");
  } finally {
    db.close();
  }
  const sizeAfter = fs.statSync(DB_PATH).size;
  fs.writeFileSync(MARKER, String(now));
  console.log(`[maintenance] VACUUM done: ${sizeBefore} → ${sizeAfter} bytes`);
}

rotateJsonl();
vacuumDb();
console.log(`[maintenance] complete`);
