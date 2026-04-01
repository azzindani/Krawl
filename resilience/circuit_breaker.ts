// resilience/circuit_breaker.ts
// Per-domain circuit breaker
// Prevents hammering failing sites

import { DEFAULTS } from "../config/defaults.js";

type CircuitState = "closed" | "open" | "half_open";

interface DomainCircuit {
  state      : CircuitState;
  failures   : number;
  lastFailure: number;
  lastSuccess: number;
}

export class CircuitBreaker {
  private circuits: Map<string, DomainCircuit> = new Map();

  private get(domain: string): DomainCircuit {
    if (!this.circuits.has(domain)) {
      this.circuits.set(domain, {
        state      : "closed",
        failures   : 0,
        lastFailure: 0,
        lastSuccess: Date.now(),
      });
    }
    return this.circuits.get(domain)!;
  }

  // Returns true if request is allowed
  allow(domain: string): boolean {
    const c   = this.get(domain);
    const now = Date.now();

    if (c.state === "closed")    return true;

    if (c.state === "open") {
      // Try half-open after reset period
      if (now - c.lastFailure > DEFAULTS.CIRCUIT_RESET_MS) {
        c.state = "half_open";
        return true;
      }
      return false;
    }

    // half_open — allow one request through
    return true;
  }

  success(domain: string): void {
    const c = this.get(domain);
    c.failures    = 0;
    c.lastSuccess = Date.now();
    c.state       = "closed";
  }

  failure(domain: string): void {
    const c = this.get(domain);
    c.failures++;
    c.lastFailure = Date.now();

    if (c.failures >= DEFAULTS.CIRCUIT_THRESHOLD) {
      if (c.state !== "open") {
        console.log(`\n  ⚡ Circuit OPEN for ${domain} (${c.failures} failures)`);
      }
      c.state = "open";
    }
  }

  getState(domain: string): CircuitState {
    return this.get(domain).state;
  }

  getStats(): Record<string, { state: CircuitState; failures: number }> {
    const result: Record<string, { state: CircuitState; failures: number }> = {};
    for (const [domain, c] of this.circuits) {
      if (c.failures > 0 || c.state !== "closed") {
        result[domain] = { state: c.state, failures: c.failures };
      }
    }
    return result;
  }
}
