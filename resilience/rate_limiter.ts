// resilience/rate_limiter.ts
// Token bucket rate limiter per domain
// Prevents bans from request flooding

import { DEFAULTS, DOMAIN_CONFIG } from "../config/defaults.js";

interface TokenBucket {
  tokens        : number;
  maxTokens     : number;
  refillRate    : number;   // tokens per ms
  lastRefill    : number;
}

export class RateLimiter {
  private buckets: Map<string, TokenBucket> = new Map();

  private getBucket(domain: string): TokenBucket {
    if (!this.buckets.has(domain)) {
      const rps       = DOMAIN_CONFIG[domain]?.rps ?? DEFAULTS.DEFAULT_RPS;
      const maxTokens = Math.max(rps * 2, 1);  // burst = 2 seconds worth
      this.buckets.set(domain, {
        tokens    : maxTokens,
        maxTokens,
        refillRate: rps / 1000,       // tokens per ms
        lastRefill: Date.now(),
      });
    }
    return this.buckets.get(domain)!;
  }

  private refill(bucket: TokenBucket): void {
    const now    = Date.now();
    const deltaMs = now - bucket.lastRefill;
    bucket.tokens     = Math.min(
      bucket.maxTokens,
      bucket.tokens + deltaMs * bucket.refillRate
    );
    bucket.lastRefill = now;
  }

  // Wait until a token is available, then consume it
  async acquire(domain: string): Promise<void> {
    const bucket = this.getBucket(domain);

    while (true) {
      this.refill(bucket);

      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return;
      }

      // Wait for next token
      const waitMs = Math.ceil((1 - bucket.tokens) / bucket.refillRate);
      await new Promise(r => setTimeout(r, Math.min(waitMs, 5_000)));
    }
  }

  getStats(): Record<string, { rps: number; tokens: number }> {
    const result: Record<string, { rps: number; tokens: number }> = {};
    for (const [domain, b] of this.buckets) {
      result[domain] = {
        rps   : b.refillRate * 1000,
        tokens: Math.round(b.tokens * 100) / 100,
      };
    }
    return result;
  }
}
