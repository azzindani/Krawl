import { describe, it, expect, beforeEach } from "vitest";
import { CircuitBreaker } from "../../resilience/circuit_breaker.js";

describe("CircuitBreaker", () => {
  let cb: CircuitBreaker;

  beforeEach(() => {
    cb = new CircuitBreaker();
  });

  it("allows requests by default (closed state)", () => {
    expect(cb.allow("example.com")).toBe(true);
    expect(cb.getState("example.com")).toBe("closed");
  });

  it("stays closed after fewer than threshold failures", () => {
    cb.failure("example.com");
    cb.failure("example.com");
    cb.failure("example.com");
    cb.failure("example.com");
    // 4 failures, threshold is 5
    expect(cb.allow("example.com")).toBe(true);
    expect(cb.getState("example.com")).toBe("closed");
  });

  it("opens circuit after reaching threshold", () => {
    for (let i = 0; i < 5; i++) {
      cb.failure("fail.com");
    }
    expect(cb.getState("fail.com")).toBe("open");
    expect(cb.allow("fail.com")).toBe(false);
  });

  it("resets to closed on success", () => {
    for (let i = 0; i < 5; i++) cb.failure("recover.com");
    expect(cb.getState("recover.com")).toBe("open");

    cb.success("recover.com");
    expect(cb.getState("recover.com")).toBe("closed");
    expect(cb.allow("recover.com")).toBe(true);
  });

  it("isolates circuits per domain", () => {
    for (let i = 0; i < 5; i++) cb.failure("bad.com");
    expect(cb.allow("bad.com")).toBe(false);
    expect(cb.allow("good.com")).toBe(true);
  });

  it("getStats returns only domains with failures or non-closed state", () => {
    cb.failure("a.com");
    cb.failure("a.com");
    const stats = cb.getStats();
    expect(stats["a.com"]).toEqual({ state: "closed", failures: 2 });
    expect(stats["b.com"]).toBeUndefined();
  });

  it("getStats includes open circuits", () => {
    for (let i = 0; i < 5; i++) cb.failure("open.com");
    const stats = cb.getStats();
    expect(stats["open.com"].state).toBe("open");
    expect(stats["open.com"].failures).toBe(5);
  });
});
