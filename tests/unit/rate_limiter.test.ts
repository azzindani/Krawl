import { describe, it, expect, beforeEach } from "vitest";
import { RateLimiter } from "../../resilience/rate_limiter.js";

describe("RateLimiter", () => {
  let rl: RateLimiter;

  beforeEach(() => {
    rl = new RateLimiter();
  });

  it("acquires immediately when tokens are available", async () => {
    const start = Date.now();
    await rl.acquire("example.com");
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100);
  });

  it("creates bucket with burst capacity (2x RPS)", async () => {
    // Default RPS is 0.5, so maxTokens = max(0.5*2, 1) = 1
    // First acquire should be instant
    await rl.acquire("slow.com");
    const stats = rl.getStats();
    expect(stats["slow.com"]).toBeDefined();
    expect(stats["slow.com"].rps).toBeCloseTo(0.5, 1);
  });

  it("uses domain-specific RPS for known domains", async () => {
    await rl.acquire("finance.yahoo.com");
    const stats = rl.getStats();
    expect(stats["finance.yahoo.com"].rps).toBeCloseTo(2.0, 1);
  });

  it("handles multiple domains independently", async () => {
    await rl.acquire("a.com");
    await rl.acquire("b.com");
    const stats = rl.getStats();
    expect(Object.keys(stats)).toContain("a.com");
    expect(Object.keys(stats)).toContain("b.com");
  });

  it("getStats returns rps and token info", async () => {
    await rl.acquire("test.com");
    const stats = rl.getStats();
    expect(stats["test.com"]).toHaveProperty("rps");
    expect(stats["test.com"]).toHaveProperty("tokens");
    expect(typeof stats["test.com"].tokens).toBe("number");
  });
});
