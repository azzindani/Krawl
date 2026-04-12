import { describe, it, expect } from "vitest";

describe("Smoke: module imports", () => {
  it("imports config/defaults", async () => {
    const mod = await import("../../config/defaults.js");
    expect(mod.DEFAULTS).toBeDefined();
    expect(mod.DOMAIN_CONFIG).toBeDefined();
  });

  it("imports core/queue", async () => {
    const mod = await import("../../core/queue.js");
    expect(mod.TaskQueue).toBeDefined();
    expect(mod.makeTask).toBeDefined();
  });

  it("imports core/timer", async () => {
    const mod = await import("../../core/timer.js");
    expect(mod.Timer).toBeDefined();
  });

  it("imports core/checkpoint", async () => {
    const mod = await import("../../core/checkpoint.js");
    expect(mod.Checkpoint).toBeDefined();
  });

  it("imports core/router", async () => {
    const mod = await import("../../core/router.js");
    expect(mod.Router).toBeDefined();
  });

  it("imports resilience/circuit_breaker", async () => {
    const mod = await import("../../resilience/circuit_breaker.js");
    expect(mod.CircuitBreaker).toBeDefined();
  });

  it("imports resilience/rate_limiter", async () => {
    const mod = await import("../../resilience/rate_limiter.js");
    expect(mod.RateLimiter).toBeDefined();
  });

  it("imports resilience/retry", async () => {
    const mod = await import("../../resilience/retry.js");
    expect(mod.classifyError).toBeDefined();
    expect(mod.shouldRetry).toBeDefined();
    expect(mod.backoffMs).toBeDefined();
    expect(mod.withRetry).toBeDefined();
  });

  it("imports db/schema", async () => {
    const mod = await import("../../db/schema.js");
    expect(mod.initSchema).toBeDefined();
  });

  it("imports db/indexer", async () => {
    const mod = await import("../../db/indexer.js");
    expect(mod.Indexer).toBeDefined();
  });

  it("imports db/query", async () => {
    const mod = await import("../../db/query.js");
    expect(mod.QueryEngine).toBeDefined();
  });

  it("imports output/stream", async () => {
    const mod = await import("../../output/stream.js");
    expect(mod.StreamWriter).toBeDefined();
  });

  it("imports output/export", async () => {
    const mod = await import("../../output/export.js");
    expect(mod.Exporter).toBeDefined();
  });
});
