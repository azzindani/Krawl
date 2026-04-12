// core/router.ts
// URL mode detection — the brain of the engine
// Probes URL once, caches decision per domain forever

import fs from "fs";
import { DEFAULTS, DOMAIN_CONFIG } from "../config/defaults.js";
import type { TaskMode } from "./queue.js";

interface ProbeSignals {
  statusCode      : number;
  httpWorks       : boolean;
  isJson          : boolean;
  isSpa           : boolean;
  isStaticHtml    : boolean;
  cloudflareBlock : boolean;
  turnstile       : boolean;
  contentType     : string;
  responseTimeMs  : number;
}

interface CachedEntry {
  mode        : TaskMode;
  signals     : Partial<ProbeSignals>;
  cachedAt    : string;
  sampleUrl   : string;
  hitCount    : number;
}

export class Router {
  private cache    : Map<string, CachedEntry>;
  private cacheFile: string;

  constructor(cacheFile: string = "router_cache.json") {
    this.cacheFile = cacheFile;
    this.cache     = this.loadCache();
  }

  private loadCache(): Map<string, CachedEntry> {
    if (fs.existsSync(this.cacheFile)) {
      try {
        const raw = JSON.parse(
          fs.readFileSync(this.cacheFile, "utf8")
        ) as Record<string, CachedEntry>;
        console.log(`✓ Router cache: ${Object.keys(raw).length} domains known`);
        return new Map(Object.entries(raw));
      } catch {
        return new Map();
      }
    }
    return new Map();
  }

  private saveCache(): void {
    const obj = Object.fromEntries(this.cache);
    fs.writeFileSync(this.cacheFile, JSON.stringify(obj, null, 2));
  }

  domain(url: string): string {
    try { return new URL(url).hostname; }
    catch { return url; }
  }

  // Check hardcoded domain config first
  private hardcodedMode(url: string): TaskMode | null {
    const d = this.domain(url);
    return (DOMAIN_CONFIG[d]?.mode as TaskMode) ?? null;
  }

  async probe(url: string): Promise<ProbeSignals> {
    const t0 = Date.now();
    try {
      const resp = await fetch(url, {
        headers: {
          "User-Agent"     : DEFAULTS.USER_AGENT,
          "Accept"         : "text/html,application/json,*/*",
          "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8",
        },
        signal: AbortSignal.timeout(10_000),
        redirect: "follow",
      });

      const contentType = resp.headers.get("content-type") ?? "";
      const body        = await resp.text();
      const bodyLower   = body.toLowerCase();
      const responseTimeMs = Date.now() - t0;

      const cloudflareBlock =
        [403, 503].includes(resp.status) &&
        (bodyLower.includes("cloudflare") ||
         DEFAULTS.CHALLENGE_TITLES.some(t => bodyLower.includes(t)));

      const turnstile =
        cloudflareBlock && (
          bodyLower.includes("cf-turnstile") ||
          bodyLower.includes("challenges.cloudflare.com/turnstile")
        );

      const isJson =
        contentType.includes("json") ||
        body.trim().startsWith("{") ||
        body.trim().startsWith("[");

      const isSpa =
        contentType.includes("html") &&
        !cloudflareBlock &&
        DEFAULTS.SPA_MARKERS.some(m => bodyLower.includes(m));

      const isStaticHtml =
        contentType.includes("html") &&
        !cloudflareBlock &&
        !isSpa &&
        resp.status === 200 &&
        body.length > 5_000;

      return {
        statusCode     : resp.status,
        httpWorks      : resp.status === 200 && !cloudflareBlock,
        isJson,
        isSpa,
        isStaticHtml,
        cloudflareBlock,
        turnstile,
        contentType,
        responseTimeMs,
      };
    } catch {
      return {
        statusCode: 0, httpWorks: false,
        isJson: false, isSpa: false, isStaticHtml: false,
        cloudflareBlock: false, turnstile: false,
        contentType: "", responseTimeMs: Date.now() - t0,
      };
    }
  }

  private decide(signals: ProbeSignals): TaskMode {
    if (signals.turnstile)                              return "blocked";
    if (signals.cloudflareBlock && !signals.turnstile)  return "http_curl";
    if (signals.isJson && signals.httpWorks)            return "http_json";
    if (signals.isSpa)                                  return "browser";
    if (signals.isStaticHtml && signals.httpWorks)      return "crawl";
    if (!signals.httpWorks)                             return "browser";
    return "browser";
  }

  async resolve(url: string, forceProbe: boolean = false): Promise<TaskMode> {
    // 1. Check hardcoded domain config
    const hardcoded = this.hardcodedMode(url);
    if (hardcoded) return hardcoded;

    const d = this.domain(url);

    // 2. Check cache
    if (!forceProbe && this.cache.has(d)) {
      const entry = this.cache.get(d)!;
      entry.hitCount++;
      return entry.mode;
    }

    // 3. Probe
    const signals = await this.probe(url);
    const mode    = this.decide(signals);

    // 4. Cache result
    this.cache.set(d, {
      mode,
      signals,
      cachedAt : new Date().toISOString(),
      sampleUrl: url,
      hitCount : 0,
    });
    this.saveCache();

    return mode;
  }

  getCachedMode(url: string): TaskMode | undefined {
    return this.cache.get(this.domain(url))?.mode;
  }

  /** Upgrade cached mode for a domain (e.g. http_curl → browser after failures). */
  upgradeMode(url: string, newMode: TaskMode): void {
    const d = this.domain(url);
    const existing = this.cache.get(d);
    if (existing && existing.mode !== newMode) {
      console.log(`  ↑ Router cache: ${d} upgraded ${existing.mode} → ${newMode}`);
      existing.mode = newMode;
      this.saveCache();
    }
  }

  dumpCache(): Record<string, CachedEntry> {
    return Object.fromEntries(this.cache);
  }
}
