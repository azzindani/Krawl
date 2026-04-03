// workers/http.ts
// HTTP worker — handles http_json and http_curl modes
// Uses built-in fetch (Node 18+)
// No external HTTP library needed

import pLimit from "p-limit";
import { DEFAULTS, DOMAIN_CONFIG } from "../config/defaults.js";
import { withRetry } from "../resilience/retry.js";
import { CircuitBreaker } from "../resilience/circuit_breaker.js";
import { RateLimiter } from "../resilience/rate_limiter.js";
import type { Task } from "../core/queue.js";

export interface HttpResult {
  task      : Task;
  status    : "ok" | "error" | "blocked" | "skipped";
  mode      : "http_json" | "http_curl";
  url       : string;
  title     : string;
  extracted : Record<string, unknown>;
  links     : string[];
  elapsedMs : number;
  error    ?: string;
  group     : string;
  ticker   ?: string;
  price    ?: number;
  currency ?: string;
  exchange ?: string;
  company  ?: string;
  extractedAt: string;
}

const BASE_HEADERS = {
  "User-Agent"     : DEFAULTS.USER_AGENT,
  "Accept"         : "application/json, text/html, */*",
  "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8",
  "Referer"        : "",
};

const CURL_HEADERS = {
  ...BASE_HEADERS,
  "Accept"          : "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "sec-ch-ua"       : '"Not_A Brand";v="8", "Chromium";v="120"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "sec-fetch-dest"  : "document",
  "sec-fetch-mode"  : "navigate",
  "sec-fetch-site"  : "none",
};

function domainOf(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

async function fetchJson(url: string, headers: Record<string, string>): Promise<{
  ok: boolean; status: number; body: unknown; contentType: string
}> {
  const referer = `https://${domainOf(url)}/`;
  const resp    = await fetch(url, {
    headers: { ...headers, "Referer": referer },
    signal : AbortSignal.timeout(DEFAULTS.HTTP_TIMEOUT),
    redirect: "follow",
  });
  const contentType = resp.headers.get("content-type") ?? "";
  const text        = await resp.text();

  let body: unknown = text;
  if (contentType.includes("json") || text.trim().startsWith("{") ||
      text.trim().startsWith("[")) {
    try { body = JSON.parse(text); } catch { /* keep as text */ }
  }

  return { ok: resp.ok, status: resp.status, body, contentType };
}

function parseYahooChart(body: unknown): Record<string, unknown> {
  try {
    const r      = (body as Record<string, unknown>);
    const chart  = r["chart"] as Record<string, unknown>;
    const result = (chart["result"] as unknown[])?.[0] as Record<string, unknown>;
    const meta   = result?.["meta"] as Record<string, unknown> ?? {};

    const price     = meta["regularMarketPrice"]    as number | undefined;
    const prevClose = meta["chartPreviousClose"]    as number | undefined;

    // Use API fields if available; otherwise calculate from price/prevClose
    const change = (meta["regularMarketChange"] != null)
      ? (meta["regularMarketChange"] as number)
      : (price != null && prevClose != null)
        ? +(price - prevClose).toFixed(4)
        : null;
    const changePct = (meta["regularMarketChangePercent"] != null)
      ? (meta["regularMarketChangePercent"] as number)
      : (price != null && prevClose != null && prevClose !== 0)
        ? +((price - prevClose) / prevClose * 100).toFixed(4)
        : null;

    return {
      price,
      change,
      changePct,
      prevClose,
      currency : meta["currency"]     ?? "IDR",
      exchange : meta["exchangeName"] ?? "",
      company  : meta["longName"]     ?? "",
    };
  } catch {
    return {};
  }
}

export class HttpWorker {
  private limit  : ReturnType<typeof pLimit>;
  private breaker: CircuitBreaker;
  private limiter: RateLimiter;

  constructor(
    concurrency: number = DEFAULTS.HTTP_CONCURRENCY,
    breaker    : CircuitBreaker,
    limiter    : RateLimiter,
  ) {
    this.limit   = pLimit(concurrency);
    this.breaker = breaker;
    this.limiter = limiter;
  }

  async run(tasks: Task[]): Promise<HttpResult[]> {
    const jobs = tasks.map(task => this.limit(() => this.runOne(task)));
    return Promise.all(jobs);
  }

  private async runOne(task: Task): Promise<HttpResult> {
    const domain    = domainOf(task.url);
    const t0        = Date.now();
    const now       = new Date().toISOString();
    const mode      = task.mode === "http_curl" ? "http_curl" : "http_json";

    if (!this.breaker.allow(domain)) {
      return {
        task, status: "skipped", mode, url: task.url,
        title: "", extracted: {}, links: [],
        elapsedMs: 0, error: "circuit open",
        group: task.group, extractedAt: now,
      };
    }

    await this.limiter.acquire(domain);

    try {
      const headers = mode === "http_curl" ? CURL_HEADERS : BASE_HEADERS;

      const { ok, status, body, contentType } = await withRetry(
        () => fetchJson(task.url, headers),
        task.maxRetries,
        (attempt, err, waitMs) => {
          console.log(
            `\n  ↻ [HTTP] ${task.name} attempt ${attempt} — ${err.message.slice(0, 50)} — retry in ${(waitMs/1000).toFixed(1)}s`
          );
        }
      );

      const elapsedMs = Date.now() - t0;

      if (!ok) {
        this.breaker.failure(domain);
        return {
          task, status: "error", mode, url: task.url,
          title: "", extracted: {}, links: [],
          elapsedMs, error: `HTTP ${status}`,
          group: task.group, extractedAt: now,
        };
      }

      this.breaker.success(domain);

      // Auto-detect and parse response
      let extracted: Record<string, unknown> = {};
      let title     = task.name;

      if (typeof body === "object" && body !== null) {
        const b = body as Record<string, unknown>;
        // Yahoo Finance chart format
        if (b["chart"]) {
          extracted = parseYahooChart(body);
          title     = (extracted["company"] as string) || task.name;
        } else {
          // Generic JSON — store as-is
          extracted = b;
        }
      }

      return {
        task,
        status    : "ok",
        mode,
        url       : task.url,
        title,
        extracted,
        links     : [],
        elapsedMs,
        group     : task.group,
        ticker    : task.group === "Yahoo" ? task.name : undefined,
        price     : extracted["price"] as number | undefined,
        currency  : extracted["currency"] as string | undefined,
        exchange  : extracted["exchange"] as string | undefined,
        company   : extracted["company"] as string | undefined,
        extractedAt: now,
      };

    } catch (e) {
      this.breaker.failure(domain);
      return {
        task, status: "error", mode, url: task.url,
        title: "", extracted: {}, links: [],
        elapsedMs: Date.now() - t0,
        error: (e as Error).message.slice(0, 100),
        group: task.group, extractedAt: now,
      };
    }
  }
}
