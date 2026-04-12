import { describe, it, expect } from "vitest";
import { execSync } from "child_process";
import path from "path";

const ROOT = path.resolve(import.meta.dirname, "../..");

describe("Smoke: CLI", () => {
  it("--help prints usage without error", () => {
    const result = execSync("npx tsx krawl.ts --help", {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(result).toContain("KRAWL");
    expect(result).toContain("Knowledge Retrieval and Web Logic Engine");
    expect(result).toContain("--url");
    expect(result).toContain("--tasks");
    expect(result).toContain("--query");
    expect(result).toContain("--export");
    expect(result).toContain("--stats");
  });

  it("no arguments prints usage", () => {
    const result = execSync("npx tsx krawl.ts", {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 15_000,
    });
    expect(result).toContain("KRAWL");
    expect(result).toContain("USAGE");
  });

  it("typecheck passes", () => {
    const result = execSync("npx tsc --noEmit", {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 30_000,
    });
    // tsc --noEmit produces no output on success
    expect(result).toBe("");
  });
});
