// workers/crawl.ts
// BFS crawler — static HTML pages, file discovery
// Politeness rules, deduplication, depth limiting

import { DEFAULTS } from "../config/defaults.js";
import { CircuitBreaker } from "../resilience/circuit_breaker.js";
import { RateLimiter } from "../resilience/rate_limiter.js";
import type { Task } from "../core/queue.js";
import { URL } from "url";
import path from "path";

export interface CrawlResult {
  task       : Task;
  status     : "ok" | "error";
  mode       : "crawl";
  url        : string;
  title      : string;
  links      : string[];
  files      : Array<{ url: string; text: string; ext: string }>;
  extracted  : Record<string, unknown>;
  elapsedMs  : number;
  error     ?: string;
  group      : string;
  extractedAt: string;
}

// Static asset extensions that carry no crawlable content
const STATIC_EXTENSIONS = new Set([
  ".css", ".js", ".mjs", ".map",
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".svg",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
]);

function domainOf(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

export class CrawlWorker {
  private visited: Set<string> = new Set();
  private breaker : CircuitBreaker;
  private limiter : RateLimiter;

  constructor(breaker: CircuitBreaker, limiter: RateLimiter) {
    this.breaker = breaker;
    this.limiter = limiter;
  }

  async run(task: Task): Promise<CrawlResult[]> {
    const results : CrawlResult[] = [];
    const maxDepth = task.crawlDepth ?? 0;
    const maxPages = DEFAULTS.MAX_CRAWL_PAGES;

    // BFS queue: [url, depth]
    const queue: Array<[string, number]> = [[task.url, 0]];
    this.visited.add(task.url);

    while (queue.length > 0 && results.length < maxPages) {
      const [url, depth] = queue.shift()!;
      const domain       = domainOf(url);

      if (!this.breaker.allow(domain)) continue;
      await this.limiter.acquire(domain);

      const result = await this.fetchOne(task, url, depth);
      results.push(result);

      if (result.status === "ok" && depth < maxDepth) {
        for (const link of result.links) {
          if (!this.visited.has(link)) {
            this.visited.add(link);
            queue.push([link, depth + 1]);
          }
        }
      }
    }

    return results;
  }

  private async fetchOne(
    task : Task,
    url  : string,
    depth: number
  ): Promise<CrawlResult> {
    const t0     = Date.now();
    const now    = new Date().toISOString();
    const domain = domainOf(url);

    try {
      const resp = await fetch(url, {
        headers: {
          "User-Agent"     : DEFAULTS.USER_AGENT,
          "Accept"         : "text/html,*/*",
          "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8",
        },
        signal  : AbortSignal.timeout(DEFAULTS.CRAWL_TIMEOUT),
        redirect: "follow",
      });

      if (!resp.ok) {
        this.breaker.failure(domain);
        return {
          task, status: "error", mode: "crawl", url,
          title: "", links: [], files: [], extracted: {},
          elapsedMs: Date.now() - t0,
          error: `HTTP ${resp.status}`,
          group: task.group, extractedAt: now,
        };
      }

      const contentType = resp.headers.get("content-type") ?? "";
      if (!contentType.includes("html")) {
        // Non-HTML — determine extension from URL or Content-Type fallback
        const filename = path.basename(new URL(url).pathname);
        let ext = path.extname(filename).toLowerCase();

        // For extensionless or unrecognised URLs, infer from Content-Type
        // (e.g. arxiv.org/pdf/2604.02280 has no .pdf suffix)
        if (!(DEFAULTS.COLLECTIBLE_EXTENSIONS as readonly string[]).includes(ext)) {
          if (contentType.includes("pdf"))                               ext = ".pdf";
          else if (contentType.includes("spreadsheetml") ||
                   contentType.includes("excel"))                        ext = ".xlsx";
          else if (contentType.includes("csv"))                         ext = ".csv";
          else if (contentType.includes("zip"))                         ext = ".zip";
          else if (contentType.includes("msword") ||
                   contentType.includes("wordprocessingml"))             ext = ".docx";
          else if (contentType.includes("presentationml") ||
                   contentType.includes("powerpoint"))                   ext = ".pptx";
        }

        // Only record as a collectible file if the extension is useful
        if ((DEFAULTS.COLLECTIBLE_EXTENSIONS as readonly string[]).includes(ext)) {
          this.breaker.success(domain);
          return {
            task, status: "ok", mode: "crawl", url,
            title: filename, links: [],
            files: [{ url, text: filename, ext }],
            extracted: { files: [{ url, text: filename, ext }] },
            elapsedMs: Date.now() - t0,
            group: task.group, extractedAt: now,
          };
        }

        // Non-collectible binary/resource — skip silently
        this.breaker.success(domain);
        return {
          task, status: "ok", mode: "crawl", url,
          title: filename, links: [], files: [], extracted: {},
          elapsedMs: Date.now() - t0,
          group: task.group, extractedAt: now,
        };
      }

      const html  = await resp.text();
      const title = this.extractTitle(html);
      const base  = new URL(url);

      const links : string[] = [];
      const files : CrawlResult["files"] = [];

      const linkRe = /href=["']([^"'#?][^"']*?)["']/gi;
      let m: RegExpExecArray | null;

      while ((m = linkRe.exec(html)) !== null) {
        const href = m[1].trim();
        let fullUrl: string;

        try {
          fullUrl = new URL(href, base).toString();
        } catch { continue; }

        const ext = path.extname(new URL(fullUrl).pathname).toLowerCase();

        if ((DEFAULTS.COLLECTIBLE_EXTENSIONS as readonly string[]).includes(ext)) {
          files.push({
            url : fullUrl,
            text: href,
            ext,
          });
        } else if (
          !STATIC_EXTENSIONS.has(ext) &&
          new URL(fullUrl).hostname === domain &&
          fullUrl.startsWith("http")
        ) {
          links.push(fullUrl);
        }
      }

      const uniqueLinks = [...new Set(links)].slice(0, 50);
      const uniqueFiles = [...new Map(files.map(f => [f.url, f])).values()];

      this.breaker.success(domain);

      return {
        task, status: "ok", mode: "crawl", url,
        title,
        links  : uniqueLinks,
        files  : uniqueFiles,
        extracted: {
          files: uniqueFiles,
          links: uniqueLinks,
          depth,
        },
        elapsedMs : Date.now() - t0,
        group     : task.group,
        extractedAt: now,
      };

    } catch (e) {
      this.breaker.failure(domain);
      return {
        task, status: "error", mode: "crawl", url,
        title: "", links: [], files: [], extracted: {},
        elapsedMs: Date.now() - t0,
        error: (e as Error).message.slice(0, 100),
        group: task.group, extractedAt: now,
      };
    }
  }

  private extractTitle(html: string): string {
    const m = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
    return m?.[1]?.trim() ?? "";
  }
}
