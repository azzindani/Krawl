// workers/browser.ts — Playwright browser worker pool
// Handles SPA pages, JS-rendered content, XHR interception.
// Scrapling-inspired additions:
//   • Consistent browser identity profiles (fingerprint.ts)
//   • Deep stealth: canvas noise, navigator props, battery, screen, permissions
//   • Adaptive / self-healing CSS selectors (selectors/)

import {
  chromium, Browser, BrowserContext, Page, Dialog, Response
} from "playwright";
import pLimit from "p-limit";
import { DEFAULTS, DOMAIN_CONFIG } from "../config/defaults.js";
import { withRetry } from "../resilience/retry.js";
import { CircuitBreaker } from "../resilience/circuit_breaker.js";
import { RateLimiter } from "../resilience/rate_limiter.js";
import { pickProfile, type BrowserProfile } from "./fingerprint.js";
import { SelectorTracker } from "../selectors/tracker.js";
import { similarity, type ElementFingerprint } from "../selectors/similarity.js";
import type { Task } from "../core/queue.js";
import type Database from "better-sqlite3";

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

// Builds a comprehensive browser-side stealth init script from a profile.
// Runs in every new page context before any page JS executes.
function buildStealthScript(p: BrowserProfile): string {
  return `
(function() {
  // ── Remove automation markers ──────────────────────────────────────────
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  delete window.__nightmare;
  delete window._phantom;
  delete window.callPhantom;
  // Remove Chrome DevTools Protocol injection markers
  const cdcKeys = Object.keys(window).filter(k => k.startsWith('cdc_'));
  cdcKeys.forEach(k => { try { delete window[k]; } catch(e) {} });

  // ── Consistent navigator properties ───────────────────────────────────
  const overrides = {
    platform           : ${JSON.stringify(p.platform)},
    hardwareConcurrency: ${p.hardwareConcurrency},
    deviceMemory       : ${p.deviceMemory},
    maxTouchPoints     : ${p.maxTouchPoints},
    languages          : ${JSON.stringify(p.locale.startsWith("id")
                            ? ["id-ID","id","en-US","en"]
                            : ["en-US","en"])},
  };
  for (const [k, v] of Object.entries(overrides)) {
    try {
      Object.defineProperty(navigator, k, { get: () => v, configurable: true });
    } catch(e) {}
  }

  // ── Plugins (non-empty list looks more real) ───────────────────────────
  Object.defineProperty(navigator, 'plugins', {
    get: () => {
      const arr = [
        { filename: 'internal-pdf-viewer',              description: 'Portable Document Format', name: 'Chrome PDF Plugin' },
        { filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai',  description: 'Portable Document Format', name: 'Chrome PDF Viewer' },
        { filename: 'internal-nacl-plugin',             description: 'Native Client',            name: 'Native Client' },
      ];
      arr.refresh = () => {};
      arr.item    = (i) => arr[i] ?? null;
      arr.namedItem = (n) => arr.find(p => p.name === n) ?? null;
      return arr;
    },
    configurable: true,
  });

  // ── chrome runtime stub ────────────────────────────────────────────────
  window.chrome = window.chrome || {};
  window.chrome.runtime = window.chrome.runtime || {
    connect    : () => ({}),
    sendMessage: () => {},
    onMessage  : { addListener: () => {} },
    id         : undefined,
  };
  window.chrome.loadTimes = () => ({});
  window.chrome.csi       = () => ({});
  window.chrome.app       = {};

  // ── Screen dimensions matching the chosen viewport ─────────────────────
  try {
    Object.defineProperty(screen, 'width',       { get: () => ${p.screenWidth} });
    Object.defineProperty(screen, 'height',      { get: () => ${p.screenHeight} });
    Object.defineProperty(screen, 'availWidth',  { get: () => ${p.screenWidth} });
    Object.defineProperty(screen, 'availHeight', { get: () => ${p.screenHeight - 40} });
    Object.defineProperty(screen, 'colorDepth',  { get: () => ${p.colorDepth} });
    Object.defineProperty(screen, 'pixelDepth',  { get: () => ${p.colorDepth} });
  } catch(e) {}

  // ── Outer window size ─────────────────────────────────────────────────
  if (window.outerWidth === 0) {
    Object.defineProperty(window, 'outerWidth',  { get: () => window.innerWidth  });
    Object.defineProperty(window, 'outerHeight', { get: () => window.innerHeight });
  }

  // ── Canvas fingerprint noise ───────────────────────────────────────────
  // Adds imperceptible per-session noise so canvas hash never matches a
  // known headless browser signature.
  const NOISE = ${p.canvasNoise};
  const _toDataURL     = HTMLCanvasElement.prototype.toDataURL;
  const _toBlob        = HTMLCanvasElement.prototype.toBlob;
  const _getImageData  = CanvasRenderingContext2D.prototype.getImageData;

  HTMLCanvasElement.prototype.toDataURL = function(...args) {
    const ctx = this.getContext('2d');
    if (ctx) {
      const imgData = ctx.getImageData(0, 0, this.width || 1, this.height || 1);
      for (let i = 0; i < imgData.data.length; i += 4) {
        imgData.data[i]     = Math.min(255, imgData.data[i]     + NOISE * 255);
        imgData.data[i + 1] = Math.min(255, imgData.data[i + 1] + NOISE * 255);
        imgData.data[i + 2] = Math.min(255, imgData.data[i + 2] + NOISE * 255);
      }
      ctx.putImageData(imgData, 0, 0);
    }
    return _toDataURL.apply(this, args);
  };

  CanvasRenderingContext2D.prototype.getImageData = function(...args) {
    const data = _getImageData.apply(this, args);
    for (let i = 0; i < data.data.length; i += 4) {
      data.data[i]     = Math.min(255, data.data[i]     + (Math.random() - 0.5) * NOISE * 255);
      data.data[i + 1] = Math.min(255, data.data[i + 1] + (Math.random() - 0.5) * NOISE * 255);
      data.data[i + 2] = Math.min(255, data.data[i + 2] + (Math.random() - 0.5) * NOISE * 255);
    }
    return data;
  };

  // ── WebGL vendor / renderer ────────────────────────────────────────────
  const _getParam  = WebGLRenderingContext.prototype.getParameter;
  const WGL_VENDOR   = ${JSON.stringify(p.webglVendor)};
  const WGL_RENDERER = ${JSON.stringify(p.webglRenderer)};
  WebGLRenderingContext.prototype.getParameter = function(param) {
    if (param === 37445) return WGL_VENDOR;
    if (param === 37446) return WGL_RENDERER;
    return _getParam.call(this, param);
  };
  // Also patch WebGL2
  if (typeof WebGL2RenderingContext !== 'undefined') {
    const _get2 = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function(param) {
      if (param === 37445) return WGL_VENDOR;
      if (param === 37446) return WGL_RENDERER;
      return _get2.call(this, param);
    };
  }

  // ── Battery API stub ───────────────────────────────────────────────────
  if ('getBattery' in navigator) {
    navigator.getBattery = () => Promise.resolve({
      charging        : true,
      chargingTime    : 0,
      dischargingTime : Infinity,
      level           : 1.0,
      addEventListener   : () => {},
      removeEventListener: () => {},
      dispatchEvent      : () => true,
    });
  }

  // ── Permissions API — always grant common permissions ─────────────────
  if (navigator.permissions) {
    const _query = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (params) => {
      const alwaysGranted = ['notifications','clipboard-read','clipboard-write'];
      if (alwaysGranted.includes(params.name)) {
        return Promise.resolve({ state: 'granted', onchange: null,
          addEventListener: () => {}, removeEventListener: () => {},
          dispatchEvent: () => true });
      }
      return _query(params);
    };
  }

  // ── navigator.connection stub ──────────────────────────────────────────
  if (!navigator.connection) {
    Object.defineProperty(navigator, 'connection', {
      get: () => ({
        effectiveType: '4g',
        rtt          : 50,
        downlink     : 10,
        saveData     : false,
      }),
      configurable: true,
    });
  }

  // ── Prevent iframe sandbox detection ─────────────────────────────────
  Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
    get: function() {
      const win = Object.getOwnPropertyDescriptor(
        HTMLIFrameElement.prototype, 'contentWindow'
      )?.get?.call(this);
      if (win) {
        try { win.navigator; } catch(e) { return null; }
      }
      return win;
    },
    configurable: true,
  });
})();
`;
}

export class BrowserWorker {
  private browser  : Browser | null = null;
  private limit    : ReturnType<typeof pLimit>;
  private breaker  : CircuitBreaker;
  private limiter  : RateLimiter;
  private tracker  : SelectorTracker;
  private profile  : BrowserProfile;
  private pageCount: number = 0;

  constructor(
    concurrency: number = DEFAULTS.BROWSER_CONTEXTS,
    breaker    : CircuitBreaker,
    limiter    : RateLimiter,
    db         : Database.Database,
  ) {
    this.limit   = pLimit(concurrency);
    this.breaker = breaker;
    this.limiter = limiter;
    this.tracker = new SelectorTracker(db);
    this.profile = pickProfile(DEFAULTS.LOCALE);
  }

  async launch(): Promise<void> {
    this.browser   = await chromium.launch({ headless: true, args: [...DEFAULTS.CHROMIUM_ARGS] });
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
    const p = this.profile;
    return this.browser!.newContext({
      viewport        : p.viewport,
      userAgent       : p.userAgent,
      locale          : p.locale,
      timezoneId      : p.timezone,
      colorScheme     : "light",
      extraHTTPHeaders: {
        "Accept-Language"   : p.acceptLanguage,
        "sec-ch-ua"         : p.secChuaFull,
        "sec-ch-ua-mobile"  : "?0",
        "sec-ch-ua-platform": JSON.stringify(
          p.platform.startsWith("Win") ? "Windows" :
          p.platform === "MacIntel"    ? "macOS"   : "Linux"
        ),
      },
    });
  }

  private async runOne(task: Task): Promise<BrowserResult> {
    const domain     = domainOf(task.url);
    const t0         = Date.now();
    const now        = new Date().toISOString();
    const timeout    = DOMAIN_CONFIG[domain]?.timeout ?? DEFAULTS.BROWSER_TIMEOUT;
    const extractType = task.extractType ?? "auto";

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

    await page.addInitScript(buildStealthScript(this.profile));

    page.on("dialog", async (dialog: Dialog) => {
      await dialog.dismiss().catch(() => {});
    });

    page.on("response", async (response: Response) => {
      const url = response.url();
      if (url.includes("umbraco/Surface") || url.includes("/api/")) {
        try {
          const body = await response.json() as Record<string, unknown>;
          capturedEndpoints.push({ url, method: "GET", response_keys: Object.keys(body) });
        } catch { /* ignore */ }
      }
    });

    try {
      await withRetry(async () => {
        await page.goto(task.url, { waitUntil: "domcontentloaded", timeout });
      }, task.maxRetries);

      const title = await page.title();
      const isChallenge = DEFAULTS.CHALLENGE_TITLES.some(t => title.toLowerCase().includes(t));

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

      await this.waitForContent(page, extractType);
      await this.dismissOverlays(page);

      const extracted = task.selectors && Object.keys(task.selectors).length > 0
        ? await this.adaptiveExtract(page, task.selectors, domain)
        : await this.extract(page, extractType);

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
        task, status: "ok", mode: "browser", url: task.url,
        title, extracted, links, endpoints: capturedEndpoints,
        elapsedMs: Date.now() - t0,
        group: task.group, extractType, extractedAt: now,
      };

    } catch (e) {
      await context.close().catch(() => {});
      this.breaker.failure(domain);
      const msg       = (e as Error).message;
      const isTimeout = msg.includes("Timeout") || msg.includes("timeout");
      return {
        task, status: isTimeout ? "timeout" : "error",
        mode: "browser", url: task.url, title: "",
        extracted: {}, links: [], endpoints: capturedEndpoints,
        elapsedMs: Date.now() - t0,
        error: msg.slice(0, 100),
        group: task.group, extractType, extractedAt: now,
      };
    }
  }

  // ── Adaptive / self-healing selector extraction ──────────────────────────
  // For each key in task.selectors:
  //   1. Try the stored (possibly updated) selector.
  //   2. If it fails, collect all same-tag candidates from the page and score
  //      them against the stored fingerprint using similarity.ts.
  //   3. Accept the best match above threshold, update the stored selector.
  private async adaptiveExtract(
    page     : Page,
    selectors: Record<string, string>,
    domain   : string,
  ): Promise<Record<string, unknown>> {
    const results: Record<string, unknown> = {};

    for (const [key, originalSel] of Object.entries(selectors)) {
      const stored      = this.tracker.get(domain, key);
      const activeSel   = stored?.selector ?? originalSel;

      // Try active selector
      const hit = await page.evaluate((sel: string) => {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (!el) return null;
        return {
          text: el.innerText?.trim() ?? el.textContent?.trim() ?? "",
          fp  : {
            tag      : el.tagName.toLowerCase(),
            textSample: (el.innerText ?? el.textContent ?? "").trim().slice(0, 100),
            classes  : Array.from(el.classList) as string[],
            id       : el.id ?? "",
            depth    : (() => {
              let d = 0; let n: Element | null = el;
              while (n?.parentElement) { d++; n = n.parentElement; }
              return d;
            })(),
            parentTag : el.parentElement?.tagName.toLowerCase() ?? "",
            attributes: Object.fromEntries(
              Array.from(el.attributes).map(a => [a.name, a.value]).slice(0, 10)
            ) as Record<string, string>,
          } satisfies ElementFingerprint,
        };
      }, activeSel);

      if (hit) {
        this.tracker.store(domain, key, activeSel, hit.fp);
        results[key] = hit.text;
        continue;
      }

      // Selector failed — try adaptive recovery if we have a stored fingerprint
      if (!stored) { results[key] = null; continue; }

      const tag        = stored.tag || "div";
      const candidates = await page.evaluate((t: string) =>
        Array.from(document.querySelectorAll(t)).slice(0, 150).map(el => {
          const h = el as HTMLElement;
          return {
            sel: `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}${
              Array.from(el.classList).slice(0, 2).map(c => "." + c).join("")}`,
            text: (h.innerText ?? el.textContent ?? "").trim(),
            fp  : {
              tag      : el.tagName.toLowerCase(),
              textSample: (h.innerText ?? el.textContent ?? "").trim().slice(0, 100),
              classes  : Array.from(el.classList) as string[],
              id       : el.id ?? "",
              depth    : (() => {
                let d = 0; let n: Element | null = el;
                while (n?.parentElement) { d++; n = n.parentElement; }
                return d;
              })(),
              parentTag : el.parentElement?.tagName.toLowerCase() ?? "",
              attributes: Object.fromEntries(
                Array.from(el.attributes).map(a => [a.name, a.value]).slice(0, 10)
              ) as Record<string, string>,
            } satisfies ElementFingerprint,
          };
        })
      , tag);

      const fps   = candidates.map(c => c.fp);
      const { index, score } = this.tracker.bestMatch(stored, fps);

      if (index >= 0) {
        const best = candidates[index];
        this.tracker.store(domain, key, best.sel, best.fp);
        results[key] = best.text;
        console.log(`  ♻ [Adaptive] ${domain} "${key}" relocated (score ${score.toFixed(2)})`);
      } else {
        results[key] = null;
      }
    }

    return results;
  }

  private async waitForContent(page: Page, extractType: string): Promise<void> {
    try {
      switch (extractType) {
        case "stock_price":
          await page.waitForFunction(
            ({ sel, min }: { sel: string; min: number }) => {
              const el  = document.querySelector(sel);
              const val = parseFloat(el?.getAttribute("value") ?? "0");
              return val > min;
            },
            { sel: "fin-streamer[data-field='regularMarketPrice']", min: 100 },
            { timeout: 25_000 }
          ).catch(() => {});
          break;
        case "headlines":
          await page.waitForSelector(
            "article, h2 a, h3 a, h4 a, [class*='headline'], [class*='article-title'], [class*='news-title']",
            { timeout: 15_000 }
          ).catch(() => {});
          break;
        case "index_price":
          await page.waitForFunction(
            () => {
              const sels = [
                "[data-test='instrument-price-last']",
                "[class*='last-price']", "[class*='lastPrice']",
                "span[class*='text-5xl']", ".instrument-price_last-price",
                "[class*='priceSection'] [class*='price']",
              ];
              return sels.some(s => {
                const el = document.querySelector(s);
                return el && /[\d,.]/.test(el.textContent ?? "");
              });
            },
            { timeout: 15_000 }
          ).catch(() => {});
          break;
        default:
          await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => {});
      }
    } catch { /* best effort */ }
  }

  private async dismissOverlays(page: Page): Promise<void> {
    const selectors = [
      "button[name='agree']", "#onetrust-accept-btn-handler",
      "button[id*='accept']", ".js-accept-cookies",
      "[data-testid='sign-in-bar-close']", ".popupCloseIcon",
    ];
    for (const sel of selectors) {
      try {
        const el = await page.waitForSelector(sel, { timeout: 800 });
        if (el) { await el.click(); await page.waitForTimeout(300); }
      } catch { /* not found */ }
    }
    await page.evaluate(() => {
      [
        '[class*="modal"]', '[class*="popup"]',
        '[class*="overlay"]', '[class*="cookie"]',
        '[class*="consent"]', '[class*="gdpr"]',
      ].forEach(s =>
        document.querySelectorAll(s).forEach(el => {
          const style = window.getComputedStyle(el);
          if (["fixed","absolute"].includes(style.position) && style.display !== "none")
            (el as HTMLElement).remove();
        })
      );
      document.body.style.overflow = "auto";
    }).catch(() => {});
  }

  private async extract(page: Page, extractType: string): Promise<Record<string, unknown>> {
    switch (extractType) {
      case "stock_price":
        return page.evaluate((): Record<string, unknown> => {
          const get = (field: string) =>
            document.querySelector<Element>(`fin-streamer[data-field='${field}']`)
              ?.getAttribute("value") ?? null;
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
          const headlines: string[] = [];
          const articles = Array.from(document.querySelectorAll("article"));
          for (const art of articles.slice(0, 20)) {
            for (const sel of ["h2","h3","h4",".title",".headline"]) {
              const el = art.querySelector<HTMLElement>(sel);
              const text = el?.innerText?.trim();
              if (text && text.length > 8) { headlines.push(text.slice(0, 120)); break; }
            }
          }
          if (headlines.length < 5) {
            const seen = new Set(headlines);
            for (const el of Array.from(document.querySelectorAll("h2 a, h3 a, h4 a, [class*='title'] a, [class*='headline'] a")).slice(0, 30)) {
              const text = (el as HTMLElement).innerText?.trim();
              if (text && text.length > 8 && !seen.has(text)) { seen.add(text); headlines.push(text.slice(0, 120)); }
            }
          }
          if (headlines.length < 3) {
            const seen = new Set(headlines);
            for (const a of Array.from(document.querySelectorAll("a"))) {
              const text = (a as HTMLElement).innerText?.trim();
              if (text && text.length > 20 && text.length < 150 && !text.includes("\n") && !seen.has(text)) {
                seen.add(text); headlines.push(text.slice(0, 120));
                if (headlines.length >= 15) break;
              }
            }
          }
          return { headlines: headlines.slice(0, 15), count: headlines.length };
        });

      case "index_price":
        return page.evaluate((): Record<string, unknown> => {
          const pickFirst = (sels: string[]): string | null => {
            for (const sel of sels) {
              const text = document.querySelector<HTMLElement>(sel)?.innerText?.trim();
              if (text && /[\d,.]/.test(text)) return text;
            }
            return null;
          };
          return {
            price    : pickFirst(["[data-test='instrument-price-last']","[class*='last-price']","[class*='lastPrice']","[class*='priceSection'] [class*='price']","span[class*='text-5xl']",".instrument-price_last-price"]),
            change   : pickFirst(["[data-test='instrument-price-change']","[class*='price-change'] [class*='change']"]),
            changePct: pickFirst(["[data-test='instrument-price-change-percent']","[class*='price-change'] [class*='percent']"]),
          };
        });

      default: {
        const body = await page.innerText("body").catch(() => "");
        return { text_preview: body.slice(0, 500).replace(/\n/g, " ").trim() };
      }
    }
  }
}
