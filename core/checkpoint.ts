// core/checkpoint.ts
// Save and restore engine state
// Survives Colab restarts, VPS crashes, manual interruptions

import fs from "fs";
import path from "path";

export interface CheckpointData {
  runId       : string;
  savedAt     : string;
  doneUrls    : string[];
  doneCount   : number;
  totalCount  : number;
  config      : Record<string, unknown>;
}

export class Checkpoint {
  private filePath: string;
  private data    : CheckpointData;

  constructor(filePath: string, runId: string, config: Record<string, unknown> = {}) {
    this.filePath = filePath;
    this.data     = this.load(runId, config);
  }

  private load(runId: string, config: Record<string, unknown>): CheckpointData {
    if (fs.existsSync(this.filePath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as CheckpointData;
        console.log(
          `✓ Checkpoint loaded: ${raw.doneCount} tasks done (run: ${raw.runId})`
        );
        return raw;
      } catch {
        console.log("⚠ Checkpoint file corrupt — starting fresh");
      }
    }
    return {
      runId,
      savedAt   : new Date().toISOString(),
      doneUrls  : [],
      doneCount : 0,
      totalCount: 0,
      config,
    };
  }

  save(doneUrls: Set<string>, totalCount: number): void {
    this.data.savedAt    = new Date().toISOString();
    this.data.doneUrls   = [...doneUrls];
    this.data.doneCount  = doneUrls.size;
    this.data.totalCount = totalCount;
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
  }

  getDoneUrls(): Set<string> {
    return new Set(this.data.doneUrls);
  }

  getRunId(): string { return this.data.runId; }

  clear(): void {
    if (fs.existsSync(this.filePath)) {
      fs.unlinkSync(this.filePath);
    }
    this.data.doneUrls   = [];
    this.data.doneCount  = 0;
  }
}
