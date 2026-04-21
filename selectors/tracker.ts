// selectors/tracker.ts
// Persists CSS-selector ↔ element-fingerprint mappings in SQLite so that
// when a site redesigns its layout the engine can relocate elements
// automatically using similarity scoring instead of silently returning null.

import Database from "better-sqlite3";
import { similarity, type ElementFingerprint } from "./similarity.js";

export interface StoredSelector {
  domain    : string;
  key       : string;       // user-supplied name, e.g. "price"
  selector  : string;       // last-known working CSS selector
  tag       : string;
  textSample: string;
  classes   : string;       // space-separated class list
  id        : string;
  depth     : number;
  parentTag : string;
  attrs     : string;       // JSON-encoded key list
  successAt : string;
  hitCount  : number;
}

// Minimum similarity threshold to accept an adaptive match
const SIMILARITY_THRESHOLD = 0.40;

export class SelectorTracker {
  private db    : Database.Database;
  private getStmt   : Database.Statement;
  private upsertStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;
    this.getStmt    = db.prepare(`
      SELECT * FROM selector_store
      WHERE domain = ? AND key = ?
      LIMIT 1
    `);
    this.upsertStmt = db.prepare(`
      INSERT INTO selector_store
        (domain, key, selector, tag, text_sample, classes, id,
         depth, parent_tag, attrs, success_at, hit_count)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,1)
      ON CONFLICT(domain, key) DO UPDATE SET
        selector   = excluded.selector,
        tag        = excluded.tag,
        text_sample= excluded.text_sample,
        classes    = excluded.classes,
        id         = excluded.id,
        depth      = excluded.depth,
        parent_tag = excluded.parent_tag,
        attrs      = excluded.attrs,
        success_at = excluded.success_at,
        hit_count  = selector_store.hit_count + 1
    `);
  }

  get(domain: string, key: string): StoredSelector | null {
    return (this.getStmt.get(domain, key) as StoredSelector | undefined) ?? null;
  }

  store(
    domain     : string,
    key        : string,
    selector   : string,
    fingerprint: ElementFingerprint,
  ): void {
    this.upsertStmt.run(
      domain,
      key,
      selector,
      fingerprint.tag,
      fingerprint.textSample.slice(0, 100),
      fingerprint.classes.join(" "),
      fingerprint.id,
      fingerprint.depth,
      fingerprint.parentTag,
      JSON.stringify(Object.keys(fingerprint.attributes)),
      new Date().toISOString(),
    );
  }

  // Given a list of candidate fingerprints from the page, return the index
  // of the best match for the stored fingerprint (or -1 if below threshold).
  bestMatch(
    stored    : StoredSelector,
    candidates: ElementFingerprint[],
  ): { index: number; score: number } {
    const storedFp: ElementFingerprint = {
      tag       : stored.tag,
      textSample: stored.textSample,
      classes   : stored.classes.split(" ").filter(Boolean),
      id        : stored.id,
      depth     : stored.depth,
      parentTag : stored.parentTag,
      attributes: {},
    };

    let bestIdx   = -1;
    let bestScore = SIMILARITY_THRESHOLD;

    for (let i = 0; i < candidates.length; i++) {
      const score = similarity(storedFp, candidates[i]);
      if (score > bestScore) {
        bestScore = score;
        bestIdx   = i;
      }
    }

    return { index: bestIdx, score: bestScore };
  }
}
