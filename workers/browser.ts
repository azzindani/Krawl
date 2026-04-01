// workers/browser.ts
// Playwright browser worker pool
// Handles SPA pages, JS-rendered content, XHR interception

import {
  chromium, Browser, BrowserContext, Page, Dialog, Response
} from "playwright";
import pLimit from "p-limit";
import { DEFAULTS, DOMAIN_CONFIG } from "../config/defaults.js";
import { withRetry } from "../resilience/retry.js";
import { CircuitBreaker } from "../resilience/circuit_breaker.js";
import { RateLimiter } from "../resilience/rate_limiter.js";
import type { Task } from "../core/queue.js";

export interface BrowserResult {
  task        : Task;
  status      : "ok" | "error" | "blocked" | "timeout";
  mode        : "browser";
  url         : string;
  title       : string;
  extracted   : Record<string, unknown>;
  links       : string[];
  endpoints   : Array<{ url: string; method: string; response_keys: string[] }>;
  elapsedMs   : number;
  error      ?: string;
  group       : string;
  extractType : string;
  extractedAt : string;
}

function domainOf(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

async function applyStealthPatches(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver",
      { get: () => undefined, configurable: true });

    Object.defineProperty(navigator, "plugins", {
      get: () => [
        { filename: "internal-pdf-viewer", description: "Portable Document Format" },
        { filename: "mhjfbmdgcfjbbpaeojofohoefgiehjai", description: "Portable Document Format" },
      ],
    });

    Object.defineProperty(navigator, "languages",
      { get: () => ["id-ID", "id", "en-US", "en"] });

    (window as Window & { chrome?: unknown }).chrome = {
      runtime: {
        connect: () => ({}), sendMessage: () => {},
        onMessage: { addListener: () => {} },
      },
      loadTimes: () => ({}), csi: () => ({}), app: {},
    };

    const getParam = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(p: number) {
      if (p === 37445) return "Intel Inc.";
      if (p === 37446) return "Intel Iris OpenGL Engine";
      return getParam.call(this, p);
    };

    if (window.outerWidth === 0) {
      Object.defineProperty(window, "outerWidth",  { get: () => window.innerWidth });
      Object.defineProperty(window, "outerHeight", { get: () => window.innerHeight });
    }
  });
}

async function waitForRealData(
  page      : Page,
  selector  : string,
  minValue  : number = 100,
  timeoutMs : number = 25_000
): Promise<void> {
  try {
    await page.waitForFunction(
      ({ sel, min }) => {
        const el  = document.querySelector(sel);
        const val = parseFloat(el?.getAttribute("value") ?? "0");
        return val > min;
      },
      { sel: selector, min: minValue },
      { timeout: timeoutMs }
    );
  } catch {
    // Continue with whatever is available
  }
}

export class BrowserWorker {
  private browser  : Browser | null = null;
  private limit    : ReturnType<typeof pLimit>;
  private breaker  : CircuitBreaker;
  private limiter  : RateLimiter;
  private pageCount: number = 0;

  constructor(
    concurrency: number = DEFAULTS.BROWSER_CONTEXTS,
    breaker    : CircuitBreaker,
    limiter    : RateLimiter,
  ) {
    this.limit   = pLimit(concurrency);
    this.breaker = breaker;
    this.limiter = limiter;
  }

  async launch(): Promise<void> {
    this.browser = await chromium.launch({
      headless: true,
      args    : [...DEFAULTS.CHROMIUM_ARGS],
    });
    this.pageCount = 0;
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => {});
    this.browser   = null;
    this.pageCount = 0;
  }

  async run(tasks: Task[]): Promise<BrowserResult[]> {
    if (!this.browser) await this.launch();

    const jobs = tasks.map(task => this.limit(() => this.runOne(task)));
    return Promise.all(jobs);
  }

  private async makeContext(): Promise<BrowserContext> {
    if (!this.browser) await this.launch();
    return this.browser!.newContext({
      viewport  : DEFAULTS.VIEWPORT,
      userAgent : DEFAULTS.USER_AGENT,
      locale    : DEFAULTS.LOCALE,
      timezoneId: DEFAULTS.TIMEZONE,
      extraHTTPHeaders: {
        "Accept-Language"   : "id-ID,id;q=0.9,en-US;q=0.8",
        "sec-ch-ua"         : '"Not_A Brand";v="8", "Chromium";v="120"',
        "sec-ch-ua-mobile"  : "?0",
        "sec-ch-ua-platform": '"Windows"',
      },
    });
  }

  private async runOne(task: Task): Promise<BrowserResult> {
    const domain    = domainOf(task.url);
    const t0        = Date.now();
    const now       = new Date().toISOString();
    const timeout   = DOMAIN_CONFIG[domain]?.timeout ?? DEFAULTS.BROWSER_TIMEOUT;
    const extractType = (task as Task & { extractType?: string }).extractType ?? "auto";

    if (!this.breaker.allow(domain)) {
      return {
        task, status: "blocked", mode: "browser", url: task.url,
        title: "", extracted: {}, links: [], endpoints: [],
        elapsedMs: 0, error: "circuit open",
        group: task.group, extractType, extractedAt: now,
      };
    }

    await this.limiter.acquire(domain);

    const context = await this.makeContext();
    const page    = await context.newPage();
    const capturedEndpoints: BrowserResult["endpoints"] = [];

    await applyStealthPatches(page);

    // Dialog handler
    page.on("dialog", async (dialog: Dialog) => {
      await dialog.dismiss().catch(() => {});
    });

    // XHR interception
    page.on("response", async (response: Response) => {
      const url = response.url();
      if (url.includes("umbraco/Surface") || url.includes("/api/")) {
        try {
          const body = await response.json() as Record<string, unknown>;
          capturedEndpoints.push({
            url,
            method       : "GET",
            response_keys: Object.keys(body),
          });
        } catch { /* ignore */ }
      }
    });

    try {
      await withRetry(async () => {
        await page.goto(task.url, {
          waitUntil: "domcontentloaded",
          timeout,
        });
      }, task.maxRetries);

      // Check for Cloudflare challenge
      const title = await page.title();
      const isChallenge = DEFAULTS.CHALLENGE_TITLES.some(
        t => title.toLowerCase().includes(t)
      );

      if (isChallenge) {
        await context.close().catch(() => {});
        this.breaker.failure(domain);
        return {
          task, status: "blocked", mode: "browser", url: task.url,
          title, extracted: {}, links: [], endpoints: [],
          elapsedMs: Date.now() - t0,
          error: "Cloudflare challenge not cleared",
          group: task.group, extractType, extractedAt: now,
        };
      }

      // Wait for content
      await this.waitForContent(page, extractType);

      // Dismiss overlays
      await this.dismissOverlays(page);

      // Extract
      const extracted = await this.extract(page, extractType);

      // Collect links
      const links = await page.evaluate((): string[] =>
        Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"))
          .map(a => a.href)
          .filter(h => h.startsWith("http"))
          .slice(0, 50)
      );

      await context.close().catch(() => {});
      this.breaker.success(domain);
      this.pageCount++;

      return {
        task,
        status    : "ok",
        mode      : "browser",
        url       : task.url,
        title     : await page.title().catch(() => title),
        extracted,
        links,
        endpoints : capturedEndpoints,
        elapsedMs : Date.now() - t0,
        group     : task.group,
        extractType,
        extractedAt: now,
      };

    } catch (e) {
      await context.close().catch(() => {});
      this.breaker.failure(domain);

      const msg      = (e as Error).message;
      const isTimeout = msg.includes("Timeout") || msg.includes("timeout");

      return {
        task,
        status   : isTimeout ? "timeout" : "error",
        mode     : "browser",
        url      : task.url,
        title    : "",
        extracted: {},
        links    : [],
        endpoints: capturedEndpoints,
        elapsedMs: Date.now() - t0,
        error    : msg.slice(0, 100),
        group    : task.group,
        extractType,
        extractedAt: now,
      };
    }
  }

  private async waitForContent(page: Page, extractType: string): Promise<void> {
    try {
      switch (extractType) {
        case "stock_price":
          await waitForRealData(
            page,
            "fin-streamer[data-field='regularMarketPrice']"
          );
          break;
        case "headlines":
          await page.waitForSelector("article", { timeout: 10_000 });
          break;
        case "index_price":
          await page.waitForSelector(
            "[data-test='instrument-price-last']",
            { timeout: 10_000 }
          );
          break;
        default:
          await page.waitForLoadState("networkidle", { timeout: 8_000 })
            .catch(() => {});
      }
    } catch { /* best effort */ }
  }

  private async dismissOverlays(page: Page): Promise<void> {
    const selectors = [
      "button[name='agree']",
      "#onetrust-accept-btn-handler",
      "button[id*='accept']",
      ".js-accept-cookies",
      "[data-testid='sign-in-bar-close']",
      ".popupCloseIcon",
    ];

    for (const sel of selectors) {
      try {
        const el = await page.waitForSelector(sel, { timeout: 800 });
        if (el) {
          await el.click();
          await page.waitForTimeout(300);
        }
      } catch { /* not found */ }
    }

    // JS overlay removal
    await page.evaluate(() => {
      [
        '[class*="modal"]', '[class*="popup"]',
        '[class*="overlay"]', '[class*="cookie"]',
        '[class*="consent"]', '[class*="gdpr"]',
      ].forEach(s =>
        document.querySelectorAll(s).forEach(el => {
          const style = window.getComputedStyle(el);
          if (["fixed","absolute"].includes(style.position) &&
              style.display !== "none") {
            (el as HTMLElement).remove();
          }
        })
      );
      document.body.style.overflow = "auto";
    }).catch(() => {});
  }

  private async extract(
    page       : Page,
    extractType: string
  ): Promise<Record<string, unknown>> {
    switch (extractType) {
      case "stock_price":
        return page.evaluate((): Record<string, unknown> => {
          const get = (field: string) =>
            document.querySelector<Element>(
              `fin-streamer[data-field='${field}']`
            )?.getAttribute("value") ?? null;
          const nameEl =
            document.querySelector<HTMLElement>('h1[class*="title"]') ??
            document.querySelector<HTMLElement>("section h1");
          return {
            price      : get("regularMarketPrice"),
            change     : get("regularMarketChange"),
            changePct  : get("regularMarketChangePercent"),
            volume     : get("regularMarketVolume"),
            marketCap  : get("marketCap"),
            dayHigh    : get("regularMarketDayHigh"),
            dayLow     : get("regularMarketDayLow"),
            prevClose  : get("regularMarketPreviousClose"),
            week52High : get("fiftyTwoWeekHigh"),
            week52Low  : get("fiftyTwoWeekLow"),
            companyName: nameEl?.innerText?.trim() ?? null,
          };
        });

      case "headlines":
        return page.evaluate((): Record<string, unknown> => {
          const articles = Array.from(document.querySelectorAll("article"));
          const headlines = articles.slice(0, 15).map(art => {
            for (const sel of ["h2","h3","h4",".title",".headline"]) {
              const el = art.querySelector<HTMLElement>(sel);
              if (el?.innerText?.trim())
                return el.innerText.trim().slice(0, 120);
            }
            return null;
          }).filter((h): h is string => h !== null);
          return { headlines, count: headlines.length };
        });

      case "index_price":
        return page.evaluate((): Record<string, unknown> => ({
          price    : document.querySelector<HTMLElement>(
            "[data-test='instrument-price-last']"
          )?.innerText ?? null,
          change   : document.querySelector<HTMLElement>(
            "[data-test='instrument-price-change']"
          )?.innerText ?? null,
          changePct: document.querySelector<HTMLElement>(
            "[data-test='instrument-price-change-percent']"
          )?.innerText ?? null,
        }));

      default: {
        const body = await page.innerText("body").catch(() => "");
        return {
          text_preview: body.slice(0, 500).replace(/\n/g, " ").trim(),
        };
      }
    }
  }
}
