import { describe, it, expect } from "vitest";
import { classifyError, shouldRetry, backoffMs, withRetry } from "../../resilience/retry.js";

describe("classifyError", () => {
  it("classifies turnstile as blocked", () => {
    expect(classifyError("cf_clearance required")).toBe("blocked");
    expect(classifyError("turnstile challenge")).toBe("blocked");
  });

  it("classifies 404 as not_found", () => {
    expect(classifyError("HTTP 404")).toBe("not_found");
    expect(classifyError("page not found")).toBe("not_found");
  });

  it("classifies 429 as rate_limit", () => {
    expect(classifyError("HTTP 429")).toBe("rate_limit");
    expect(classifyError("rate limit exceeded")).toBe("rate_limit");
    expect(classifyError("too many requests")).toBe("rate_limit");
  });

  it("classifies network errors as transient", () => {
    expect(classifyError("timeout")).toBe("transient");
    expect(classifyError("ECONNRESET")).toBe("transient");
    expect(classifyError("ENOTFOUND")).toBe("transient");
    expect(classifyError("network error")).toBe("transient");
    expect(classifyError("socket hang up")).toBe("transient");
  });

  it("defaults to transient for unknown errors", () => {
    expect(classifyError("something went wrong")).toBe("transient");
  });

  it("accepts Error objects", () => {
    expect(classifyError(new Error("timeout occurred"))).toBe("transient");
    expect(classifyError(new Error("404 page not found"))).toBe("not_found");
  });
});

describe("shouldRetry", () => {
  it("returns true for transient and rate_limit", () => {
    expect(shouldRetry("transient")).toBe(true);
    expect(shouldRetry("rate_limit")).toBe(true);
  });

  it("returns false for blocked, not_found, permanent", () => {
    expect(shouldRetry("blocked")).toBe(false);
    expect(shouldRetry("not_found")).toBe(false);
    expect(shouldRetry("permanent")).toBe(false);
  });
});

describe("backoffMs", () => {
  it("increases with attempt number", () => {
    const b1 = backoffMs(1, "transient");
    const b2 = backoffMs(2, "transient");
    const b3 = backoffMs(3, "transient");
    expect(b2).toBeGreaterThan(b1);
    expect(b3).toBeGreaterThan(b2);
  });

  it("uses 3x base for rate_limit", () => {
    const transientBackoff = backoffMs(1, "transient");
    const rateLimitBackoff = backoffMs(1, "rate_limit");
    // rate_limit base is 3x, so first attempt should be roughly 3x
    // (not exact due to jitter)
    expect(rateLimitBackoff).toBeGreaterThan(transientBackoff * 2);
  });

  it("caps at BACKOFF_MAX_MS", () => {
    const b = backoffMs(20, "transient");
    expect(b).toBeLessThanOrEqual(30_000);
  });

  it("always returns positive value", () => {
    for (let i = 1; i <= 10; i++) {
      expect(backoffMs(i, "transient")).toBeGreaterThan(0);
    }
  });
});

describe("withRetry", () => {
  it("returns result on first success", async () => {
    const result = await withRetry(() => Promise.resolve(42));
    expect(result).toBe(42);
  });

  it("retries transient errors", async () => {
    let attempts = 0;
    const result = await withRetry(async () => {
      attempts++;
      if (attempts < 3) throw new Error("timeout");
      return "ok";
    }, 3);
    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  it("throws immediately on non-retryable errors", async () => {
    await expect(
      withRetry(async () => {
        throw new Error("404 not found");
      }, 3)
    ).rejects.toThrow("404 not found");
  });

  it("throws after exhausting retries", async () => {
    await expect(
      withRetry(async () => {
        throw new Error("timeout");
      }, 2)
    ).rejects.toThrow("timeout");
  });

  it("calls onRetry callback on each retry", async () => {
    const retries: number[] = [];
    let attempts = 0;
    await withRetry(
      async () => {
        attempts++;
        if (attempts < 3) throw new Error("timeout");
        return "ok";
      },
      3,
      (attempt) => retries.push(attempt),
    );
    expect(retries).toEqual([1, 2]);
  });
});
