// resilience/retry.ts
// Exponential backoff with jitter
// Classifies errors to decide retry vs give up

import { DEFAULTS } from "../config/defaults.js";

export type ErrorClass =
  | "transient"     // retry — network blip, timeout
  | "rate_limit"    // retry with longer backoff
  | "blocked"       // do not retry — Cloudflare block
  | "not_found"     // do not retry — 404
  | "permanent"     // do not retry — fatal error

export function classifyError(error: string | Error): ErrorClass {
  const msg = (typeof error === "string" ? error : error.message).toLowerCase();

  if (msg.includes("turnstile") || msg.includes("cf_clearance"))
    return "blocked";
  if (msg.includes("404") || msg.includes("not found"))
    return "not_found";
  if (msg.includes("429") || msg.includes("rate limit") || msg.includes("too many"))
    return "rate_limit";
  if (
    msg.includes("timeout") ||
    msg.includes("econnreset") ||
    msg.includes("enotfound") ||
    msg.includes("network") ||
    msg.includes("socket")
  ) return "transient";

  return "transient"; // default: assume transient, retry
}

export function shouldRetry(errorClass: ErrorClass): boolean {
  return errorClass === "transient" || errorClass === "rate_limit";
}

export function backoffMs(
  attempt    : number,
  errorClass : ErrorClass
): number {
  const base   = errorClass === "rate_limit"
    ? DEFAULTS.BACKOFF_BASE_MS * 3
    : DEFAULTS.BACKOFF_BASE_MS;

  const exp    = base * Math.pow(2, attempt - 1);
  const jitter = Math.random() * base * 0.3;
  return Math.min(exp + jitter, DEFAULTS.BACKOFF_MAX_MS);
}

export async function withRetry<T>(
  fn         : () => Promise<T>,
  maxRetries : number = DEFAULTS.MAX_RETRIES,
  onRetry   ?: (attempt: number, error: Error, waitMs: number) => void
): Promise<T> {
  let lastError: Error = new Error("unknown");

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError      = e instanceof Error ? e : new Error(String(e));
      const errClass = classifyError(lastError);

      if (!shouldRetry(errClass) || attempt === maxRetries) {
        throw lastError;
      }

      const waitMs = backoffMs(attempt, errClass);
      onRetry?.(attempt, lastError, waitMs);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }

  throw lastError;
}
