import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { Checkpoint } from "../../core/checkpoint.js";

function tmpFile(): string {
  return path.join(os.tmpdir(), `krawl_test_ckpt_${Date.now()}_${Math.random()}.json`);
}

describe("Checkpoint", () => {
  const files: string[] = [];

  afterEach(() => {
    for (const f of files) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
    files.length = 0;
  });

  it("creates fresh checkpoint when file does not exist", () => {
    const f = tmpFile();
    files.push(f);
    const cp = new Checkpoint(f, "run1");
    expect(cp.getRunId()).toBe("run1");
    expect(cp.getDoneUrls().size).toBe(0);
  });

  it("saves and loads checkpoint data", () => {
    const f = tmpFile();
    files.push(f);
    const cp = new Checkpoint(f, "run1");
    const urls = new Set(["https://a.com", "https://b.com"]);
    cp.save(urls, 10);

    // Load in a new instance
    const cp2 = new Checkpoint(f, "run2");
    expect(cp2.getDoneUrls()).toEqual(urls);
    // Loaded run ID is from persisted data (run1)
    expect(cp2.getRunId()).toBe("run1");
  });

  it("clears checkpoint", () => {
    const f = tmpFile();
    files.push(f);
    const cp = new Checkpoint(f, "run1");
    cp.save(new Set(["https://a.com"]), 5);
    expect(fs.existsSync(f)).toBe(true);

    cp.clear();
    expect(fs.existsSync(f)).toBe(false);
    expect(cp.getDoneUrls().size).toBe(0);
  });

  it("handles corrupt checkpoint file gracefully", () => {
    const f = tmpFile();
    files.push(f);
    fs.writeFileSync(f, "not json!!!");
    const cp = new Checkpoint(f, "recovery");
    expect(cp.getRunId()).toBe("recovery");
    expect(cp.getDoneUrls().size).toBe(0);
  });
});
