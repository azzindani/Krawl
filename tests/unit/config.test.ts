import { describe, it, expect } from "vitest";
import { DEFAULTS, DOMAIN_CONFIG } from "../../config/defaults.js";

describe("DEFAULTS", () => {
  it("has valid worker pool sizes", () => {
    expect(DEFAULTS.HTTP_CONCURRENCY).toBeGreaterThan(0);
    expect(DEFAULTS.BROWSER_CONTEXTS).toBeGreaterThan(0);
    expect(DEFAULTS.CRAWL_CONCURRENCY).toBeGreaterThan(0);
  });

  it("has valid timeouts", () => {
    expect(DEFAULTS.HTTP_TIMEOUT).toBeGreaterThan(0);
    expect(DEFAULTS.BROWSER_TIMEOUT).toBeGreaterThan(0);
    expect(DEFAULTS.CRAWL_TIMEOUT).toBeGreaterThan(0);
  });

  it("has valid retry configuration", () => {
    expect(DEFAULTS.MAX_RETRIES).toBeGreaterThan(0);
    expect(DEFAULTS.BACKOFF_BASE_MS).toBeGreaterThan(0);
    expect(DEFAULTS.BACKOFF_MAX_MS).toBeGreaterThan(DEFAULTS.BACKOFF_BASE_MS);
  });

  it("has valid circuit breaker settings", () => {
    expect(DEFAULTS.CIRCUIT_THRESHOLD).toBeGreaterThan(0);
    expect(DEFAULTS.CIRCUIT_RESET_MS).toBeGreaterThan(0);
  });

  it("has valid rate limiting defaults", () => {
    expect(DEFAULTS.DEFAULT_RPS).toBeGreaterThan(0);
    expect(DEFAULTS.KNOWN_SAFE_RPS).toBeGreaterThan(DEFAULTS.DEFAULT_RPS);
  });

  it("has valid crawl limits", () => {
    expect(DEFAULTS.MAX_CRAWL_DEPTH).toBeGreaterThan(0);
    expect(DEFAULTS.MAX_CRAWL_PAGES).toBeGreaterThan(0);
  });

  it("has valid file paths", () => {
    expect(DEFAULTS.DB_PATH).toBeTruthy();
    expect(DEFAULTS.JSONL_PATH).toBeTruthy();
    expect(DEFAULTS.FILES_DIR).toBeTruthy();
  });

  it("has valid browser config", () => {
    expect(DEFAULTS.VIEWPORT.width).toBeGreaterThan(0);
    expect(DEFAULTS.VIEWPORT.height).toBeGreaterThan(0);
    expect(DEFAULTS.USER_AGENT).toBeTruthy();
    expect(DEFAULTS.CHROMIUM_ARGS.length).toBeGreaterThan(0);
  });

  it("has collectible file extensions", () => {
    expect(DEFAULTS.COLLECTIBLE_EXTENSIONS.length).toBeGreaterThan(0);
    for (const ext of DEFAULTS.COLLECTIBLE_EXTENSIONS) {
      expect(ext).toMatch(/^\./);
    }
  });

  it("has challenge titles for detection", () => {
    expect(DEFAULTS.CHALLENGE_TITLES.length).toBeGreaterThan(0);
  });

  it("has SPA markers", () => {
    expect(DEFAULTS.SPA_MARKERS.length).toBeGreaterThan(0);
  });
});

describe("DOMAIN_CONFIG", () => {
  it("contains known finance domains", () => {
    expect(DOMAIN_CONFIG["finance.yahoo.com"]).toBeDefined();
    expect(DOMAIN_CONFIG["www.ojk.go.id"]).toBeDefined();
    expect(DOMAIN_CONFIG["www.bi.go.id"]).toBeDefined();
  });

  it("has valid RPS values", () => {
    for (const [_domain, config] of Object.entries(DOMAIN_CONFIG)) {
      if (config.rps !== undefined) {
        expect(config.rps).toBeGreaterThan(0);
      }
    }
  });

  it("has valid timeout values", () => {
    for (const [_domain, config] of Object.entries(DOMAIN_CONFIG)) {
      if (config.timeout !== undefined) {
        expect(config.timeout).toBeGreaterThan(0);
      }
    }
  });

  it("idx.co.id is blocked", () => {
    expect(DOMAIN_CONFIG["www.idx.co.id"]?.mode).toBe("blocked");
  });
});
