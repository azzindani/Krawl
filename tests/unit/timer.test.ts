import { describe, it, expect, beforeEach, vi } from "vitest";
import { Timer } from "../../core/timer.js";

describe("Timer", () => {
  let timer: Timer;

  beforeEach(() => {
    timer = new Timer("test-run-1");
  });

  it("initializes with run ID", () => {
    const stats = timer.getStats();
    expect(stats.runId).toBe("test-run-1");
    expect(stats.startMs).toBeGreaterThan(0);
    expect(stats.phases.size).toBe(0);
  });

  describe("phase tracking", () => {
    it("starts and ends a phase", () => {
      timer.startPhase("resolve", 10);
      const stats = timer.getStats();
      const phase = stats.phases.get("resolve")!;
      expect(phase.name).toBe("resolve");
      expect(phase.total).toBe(10);
      expect(phase.completed).toBe(0);
      expect(phase.errors).toBe(0);

      timer.endPhase("resolve");
      expect(stats.phases.get("resolve")!.endMs).toBeGreaterThan(0);
    });

    it("tracks multiple phases", () => {
      timer.startPhase("resolve", 5);
      timer.startPhase("execute", 15);
      expect(timer.getStats().phases.size).toBe(2);
    });
  });

  describe("tick", () => {
    it("increments phase completion count", () => {
      timer.startPhase("execute", 10);
      timer.tick("execute", "http_json", "example.com", 150);
      timer.tick("execute", "http_json", "example.com", 200);

      const phase = timer.getStats().phases.get("execute")!;
      expect(phase.completed).toBe(2);
      expect(phase.errors).toBe(0);
    });

    it("tracks errors in phase", () => {
      timer.startPhase("execute", 10);
      timer.tick("execute", "browser", "fail.com", 300, true);

      const phase = timer.getStats().phases.get("execute")!;
      expect(phase.completed).toBe(1);
      expect(phase.errors).toBe(1);
    });

    it("aggregates by mode", () => {
      timer.startPhase("execute", 10);
      timer.tick("execute", "http_json", "a.com", 100);
      timer.tick("execute", "http_json", "b.com", 200);
      timer.tick("execute", "browser", "c.com", 500, true);

      const byMode = timer.getStats().byMode;
      expect(byMode["http_json"]).toEqual({ ok: 2, err: 0, totalMs: 300 });
      expect(byMode["browser"]).toEqual({ ok: 0, err: 1, totalMs: 500 });
    });

    it("aggregates by domain", () => {
      timer.startPhase("execute", 10);
      timer.tick("execute", "http_json", "a.com", 100);
      timer.tick("execute", "http_json", "a.com", 200);
      timer.tick("execute", "browser", "b.com", 500);

      const byDomain = timer.getStats().byDomain;
      expect(byDomain["a.com"]).toEqual({ count: 2, totalMs: 300 });
      expect(byDomain["b.com"]).toEqual({ count: 1, totalMs: 500 });
    });
  });

  describe("display", () => {
    it("does not throw on display", () => {
      timer.startPhase("execute", 5);
      timer.tick("execute", "http_json", "a.com", 100);
      expect(() => timer.display()).not.toThrow();
    });

    it("handles zero total without throwing", () => {
      timer.startPhase("empty", 0);
      expect(() => timer.display()).not.toThrow();
    });
  });

  describe("summary", () => {
    it("prints summary without throwing", () => {
      const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      timer.startPhase("execute", 2);
      timer.tick("execute", "http_json", "a.com", 100);
      timer.tick("execute", "browser", "b.com", 200, true);
      timer.endPhase("execute");

      expect(() => timer.summary()).not.toThrow();
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });
});
