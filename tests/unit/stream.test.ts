import { describe, it, expect, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { StreamWriter } from "../../output/stream.js";

function tmpFile(): string {
  return path.join(os.tmpdir(), `krawl_test_stream_${Date.now()}_${Math.random()}.jsonl`);
}

describe("StreamWriter", () => {
  const files: string[] = [];

  afterEach(async () => {
    for (const f of files) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
    files.length = 0;
  });

  it("writes JSONL records", async () => {
    const f = tmpFile();
    files.push(f);
    const sw = new StreamWriter(f);
    sw.write({ url: "https://a.com", status: "ok" });
    sw.write({ url: "https://b.com", status: "ok" });
    await sw.close();

    const lines = fs.readFileSync(f, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ url: "https://a.com", status: "ok" });
    expect(JSON.parse(lines[1])).toEqual({ url: "https://b.com", status: "ok" });
  });

  it("tracks count", async () => {
    const f = tmpFile();
    files.push(f);
    const sw = new StreamWriter(f);
    expect(sw.getCount()).toBe(0);
    sw.write({ test: true });
    expect(sw.getCount()).toBe(1);
    sw.write({ test: true });
    expect(sw.getCount()).toBe(2);
    await sw.close();
  });

  it("returns file path", () => {
    const f = tmpFile();
    files.push(f);
    const sw = new StreamWriter(f);
    expect(sw.getPath()).toBe(f);
  });

  it("readAll returns parsed records", async () => {
    const f = tmpFile();
    files.push(f);
    const sw = new StreamWriter(f);
    sw.write({ a: 1 });
    sw.write({ b: 2 });
    await sw.close();

    const records = sw.readAll();
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual({ a: 1 });
    expect(records[1]).toEqual({ b: 2 });
  });

  it("readAll returns empty array when file does not exist", () => {
    const writer = new StreamWriter(path.join(os.tmpdir(), "does_not_exist_ever_" + Date.now() + ".jsonl"));
    // Read from a path that doesn't exist yet (no writes)
    expect(writer.readAll()).toEqual([]);
  });

  it("appends to existing file", async () => {
    const f = tmpFile();
    files.push(f);
    const sw1 = new StreamWriter(f);
    sw1.write({ first: true });
    await sw1.close();

    const sw2 = new StreamWriter(f);
    sw2.write({ second: true });
    await sw2.close();

    const lines = fs.readFileSync(f, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
  });
});
