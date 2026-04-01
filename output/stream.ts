// output/stream.ts
// JSONL writer — every result written immediately
// Never batches — crash-safe

import fs from "fs";
import path from "path";

export class StreamWriter {
  private handle: fs.WriteStream;
  private count : number = 0;
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.handle   = fs.createWriteStream(filePath, { flags: "a" });
  }

  write(record: Record<string, unknown>): void {
    this.handle.write(JSON.stringify(record, null, 0) + "\n");
    this.count++;
  }

  close(): Promise<void> {
    return new Promise(resolve => this.handle.end(resolve));
  }

  getCount(): number { return this.count; }
  getPath() : string { return this.filePath; }

  readAll(): Record<string, unknown>[] {
    if (!fs.existsSync(this.filePath)) return [];
    return fs.readFileSync(this.filePath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(line => JSON.parse(line) as Record<string, unknown>);
  }
}
