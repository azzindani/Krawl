import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "child_process";
import http from "http";
import fs from "fs";
import path from "path";
import os from "os";

const ROOT = path.resolve(import.meta.dirname, "../..");
const TEST_DIR = path.join(os.tmpdir(), `krawl_e2e_${Date.now()}`);
const TEST_DB = path.join(TEST_DIR, "test.db");
const TEST_JSONL = path.join(TEST_DIR, "test.jsonl");
const TEST_EXPORT_DIR = path.join(TEST_DIR, "exports");

let server: http.Server;
let port: number;

function run(args: string, timeout = 30_000): string {
  return execSync(
    `npx tsx krawl.ts ${args}`,
    {
      cwd: ROOT,
      encoding: "utf8",
      timeout,
      env: { ...process.env, NODE_ENV: "test" },
    },
  );
}

beforeAll(async () => {
  fs.mkdirSync(TEST_DIR, { recursive: true });

  // Start a local HTTP server that serves test pages
  server = http.createServer((req, res) => {
    const url = req.url ?? "/";

    if (url === "/json-api") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        data: [
          { ticker: "TEST", price: 1234.56, company: "Test Corp" },
        ],
      }));
      return;
    }

    if (url === "/html-page") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`
        <html>
          <head><title>Test HTML Page</title></head>
          <body>
            <h1>Hello Krawl</h1>
            <p>This is a test page for e2e testing.</p>
            <a href="/linked-page">Link</a>
          </body>
        </html>
      `);
      return;
    }

    if (url === "/linked-page") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`
        <html>
          <head><title>Linked Page</title></head>
          <body><p>Linked content</p></body>
        </html>
      `);
      return;
    }

    if (url === "/error-500") {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
      return;
    }

    if (url === "/slow") {
      setTimeout(() => {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("slow response");
      }, 3000);
      return;
    }

    // Default: 404
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        port = addr.port;
      }
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  try { fs.rmSync(TEST_DIR, { recursive: true }); } catch { /* ignore */ }
});

describe("E2E: CLI pipeline", () => {
  it("fetches a single URL and stores in database", () => {
    const output = run(
      `--url http://127.0.0.1:${port}/json-api --db ${TEST_DB} --output ${TEST_JSONL}`,
    );
    // Should complete without crashing
    expect(output).toBeDefined();
  });

  it("--stats shows database statistics", () => {
    const output = run(`--stats --db ${TEST_DB}`);
    expect(output).toContain("DATABASE STATISTICS");
    expect(output).toContain("pages");
  });

  it("--query runs SQL query", () => {
    const output = run(`--query "SELECT COUNT(*) as cnt FROM pages" --db ${TEST_DB}`);
    const parsed = JSON.parse(output);
    expect(parsed).toBeInstanceOf(Array);
    expect(parsed[0].cnt).toBeGreaterThanOrEqual(0);
  });

  it("--export exports a table to CSV", () => {
    const output = run(`--export pages --db ${TEST_DB} --out ${TEST_EXPORT_DIR}`);
    expect(output).toContain("Exported");
  });

  it("--export all exports multiple tables", () => {
    const output = run(`--export all --db ${TEST_DB} --out ${TEST_EXPORT_DIR}`);
    expect(output).toContain("Exporting all tables");
  });

  it("--tasks with a JSON file runs multiple tasks", () => {
    const tasksFile = path.join(TEST_DIR, "tasks.json");
    fs.writeFileSync(tasksFile, JSON.stringify([
      { url: `http://127.0.0.1:${port}/json-api`, mode: "auto" },
      { url: `http://127.0.0.1:${port}/html-page`, mode: "auto" },
    ]));

    const output = run(
      `--tasks ${tasksFile} --db ${TEST_DB} --output ${TEST_JSONL}`,
    );
    expect(output).toBeDefined();
  });

  it("--tasks with a TXT file (one URL per line)", () => {
    const urlsFile = path.join(TEST_DIR, "urls.txt");
    fs.writeFileSync(urlsFile, `http://127.0.0.1:${port}/json-api\nhttp://127.0.0.1:${port}/html-page\n`);

    const output = run(
      `--tasks ${urlsFile} --db ${TEST_DB} --output ${TEST_JSONL}`,
    );
    expect(output).toBeDefined();
  });

  it("--search performs full-text search", () => {
    const output = run(`--search "test" --db ${TEST_DB}`);
    expect(output).toContain("Search:");
  });
});
