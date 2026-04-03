// core/timer.ts
// Performance tracking, ETA calculation, live display

export interface PhaseStats {
  name       : string;
  startMs    : number;
  endMs     ?: number;
  completed  : number;
  total      : number;
  errors     : number;
}

export interface RunStats {
  runId      : string;
  startMs    : number;
  phases     : Map<string, PhaseStats>;
  byMode     : Record<string, { ok: number; err: number; totalMs: number }>;
  byDomain   : Record<string, { count: number; totalMs: number }>;
}

export class Timer {
  private stats: RunStats;

  constructor(runId: string) {
    this.stats = {
      runId,
      startMs: Date.now(),
      phases : new Map(),
      byMode : {},
      byDomain: {},
    };
  }

  startPhase(name: string, total: number): void {
    this.stats.phases.set(name, {
      name,
      startMs  : Date.now(),
      completed: 0,
      total,
      errors   : 0,
    });
  }

  tick(
    phase  : string,
    mode   : string,
    domain : string,
    elapsedMs: number,
    error  : boolean = false
  ): void {
    // Phase stats
    const p = this.stats.phases.get(phase);
    if (p) {
      p.completed++;
      if (error) p.errors++;
    }

    // Mode stats
    if (!this.stats.byMode[mode]) {
      this.stats.byMode[mode] = { ok: 0, err: 0, totalMs: 0 };
    }
    if (error) this.stats.byMode[mode].err++;
    else this.stats.byMode[mode].ok++;
    this.stats.byMode[mode].totalMs += elapsedMs;

    // Domain stats
    if (!this.stats.byDomain[domain]) {
      this.stats.byDomain[domain] = { count: 0, totalMs: 0 };
    }
    this.stats.byDomain[domain].count++;
    this.stats.byDomain[domain].totalMs += elapsedMs;
  }

  endPhase(name: string): void {
    const p = this.stats.phases.get(name);
    if (p) p.endMs = Date.now();
  }

  // Total tasks across all phases
  private totals(): { completed: number; total: number; errors: number } {
    let completed = 0, total = 0, errors = 0;
    for (const p of this.stats.phases.values()) {
      completed += p.completed;
      total     += p.total;
      errors    += p.errors;
    }
    return { completed, total, errors };
  }

  // Render live progress to terminal
  display(): void {
    const { completed, total, errors } = this.totals();
    const wallMs  = Date.now() - this.stats.startMs;
    const wallSec = wallMs / 1000;
    const rate    = completed > 0 ? completed / wallSec : 0;
    const remaining = total - completed;
    const etaSec  = rate > 0 ? remaining / rate : 0;

    // Progress bar — clamp to [0, 30] so repeat() never gets a negative arg
    const pct    = total > 0 ? completed / total : 0;
    const filled = Math.min(30, Math.max(0, Math.round(pct * 30)));
    const bar    = "█".repeat(filled) + "░".repeat(30 - filled);

    // Mode summary
    const modeSummary = Object.entries(this.stats.byMode)
      .map(([m, s]) => `${m.replace("_","")}✓${s.ok}✗${s.err}`)
      .join("  ");

    const line =
      `[${this.formatTime(wallMs)}] ${bar} ${Math.round(pct*100)}%` +
      `  ${completed}/${total}` +
      `  ${rate.toFixed(1)}/s` +
      `  ETA:${this.formatSec(etaSec)}` +
      `  ${modeSummary}` +
      `  err:${errors}`;

    if (process.stdout.isTTY) {
      // Interactive terminal: overwrite the current line in-place
      process.stdout.write("\r\x1b[K" + line);
    } else {
      // Piped / non-interactive (Colab, CI): emit a normal log line
      console.log(line);
    }
  }

  // Print final summary
  summary(): void {
    const { completed, total, errors } = this.totals();
    const wallMs = Date.now() - this.stats.startMs;

    console.log("\n");
    console.log("=".repeat(60));
    console.log("RUN SUMMARY");
    console.log("=".repeat(60));
    console.log(`Run ID       : ${this.stats.runId}`);
    console.log(`Total time   : ${this.formatTime(wallMs)}`);
    console.log(`Completed    : ${completed}/${total}`);
    console.log(`Errors       : ${errors}`);
    console.log(`Avg rate     : ${(completed/(wallMs/1000)).toFixed(2)} tasks/sec`);
    console.log("");

    console.log("By mode:");
    for (const [mode, s] of Object.entries(this.stats.byMode)) {
      const avg = s.totalMs / Math.max(s.ok + s.err, 1);
      console.log(
        `  ${mode.padEnd(14)} ok=${s.ok}  err=${s.err}  avg=${(avg/1000).toFixed(2)}s`
      );
    }

    console.log("");
    console.log("Top domains by volume:");
    const topDomains = Object.entries(this.stats.byDomain)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 8);
    for (const [domain, s] of topDomains) {
      const avg = s.totalMs / s.count;
      console.log(
        `  ${domain.padEnd(35)} ${s.count} reqs  avg=${(avg/1000).toFixed(2)}s`
      );
    }

    console.log("");
    console.log("Phases:");
    for (const p of this.stats.phases.values()) {
      const dur = p.endMs ? p.endMs - p.startMs : Date.now() - p.startMs;
      console.log(
        `  ${p.name.padEnd(20)} ${p.completed}/${p.total}  ` +
        `${this.formatTime(dur)}  err=${p.errors}`
      );
    }
  }

  private formatTime(ms: number): string {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    if (h > 0) return `${h}h${m % 60}m${s % 60}s`;
    if (m > 0) return `${m}m${s % 60}s`;
    return `${s}s`;
  }

  private formatSec(s: number): string {
    if (!isFinite(s)) return "?";
    return this.formatTime(s * 1000);
  }

  getStats(): RunStats { return this.stats; }
}
