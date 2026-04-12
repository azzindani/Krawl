import { describe, it, expect, beforeEach } from "vitest";
import { TaskQueue, makeTask, type TaskInput } from "../../core/queue.js";

function input(overrides: Partial<TaskInput> = {}): TaskInput {
  return { url: `https://example.com/${Math.random()}`, ...overrides };
}

describe("makeTask", () => {
  it("creates a task with defaults", () => {
    const t = makeTask({ url: "https://example.com" });
    expect(t.id).toMatch(/^task_/);
    expect(t.url).toBe("https://example.com");
    expect(t.mode).toBe("auto");
    expect(t.priority).toBe(5);
    expect(t.group).toBe("default");
    expect(t.tags).toEqual([]);
    expect(t.retries).toBe(0);
    expect(t.maxRetries).toBe(3);
    expect(t.status).toBe("pending");
    expect(t.createdAt).toBeTruthy();
  });

  it("applies custom values", () => {
    const t = makeTask({
      url: "https://test.com",
      name: "my task",
      mode: "browser",
      priority: 1,
      group: "finance",
      tags: ["stock"],
      maxRetries: 5,
      crawl_depth: 3,
    });
    expect(t.name).toBe("my task");
    expect(t.mode).toBe("browser");
    expect(t.priority).toBe(1);
    expect(t.group).toBe("finance");
    expect(t.tags).toEqual(["stock"]);
    expect(t.maxRetries).toBe(5);
    expect(t.crawlDepth).toBe(3);
  });

  it("derives name from hostname when not provided", () => {
    const t = makeTask({ url: "https://finance.yahoo.com/quote/AAPL" });
    expect(t.name).toBe("finance.yahoo.com");
  });

  it("sets parentId when provided", () => {
    const t = makeTask({ url: "https://example.com" }, "parent_123");
    expect(t.parentId).toBe("parent_123");
  });

  it("generates unique IDs for each task", () => {
    const ids = new Set(Array.from({ length: 100 }, () => makeTask(input()).id));
    expect(ids.size).toBe(100);
  });
});

describe("TaskQueue", () => {
  let q: TaskQueue;

  beforeEach(() => {
    q = new TaskQueue();
  });

  describe("enqueue / dequeue", () => {
    it("enqueues and dequeues in priority order", () => {
      const t1 = makeTask(input({ priority: 5 }));
      const t2 = makeTask(input({ priority: 1 }));
      const t3 = makeTask(input({ priority: 3 }));
      q.enqueue(t1);
      q.enqueue(t2);
      q.enqueue(t3);

      expect(q.pendingCount).toBe(3);
      const first = q.dequeue()!;
      expect(first.priority).toBe(1);
      const second = q.dequeue()!;
      expect(second.priority).toBe(3);
      const third = q.dequeue()!;
      expect(third.priority).toBe(5);
    });

    it("returns undefined when empty", () => {
      expect(q.dequeue()).toBeUndefined();
    });

    it("sets status to running on dequeue", () => {
      q.enqueue(makeTask(input()));
      const t = q.dequeue()!;
      expect(t.status).toBe("running");
      expect(t.startedAt).toBeTruthy();
    });

    it("skips duplicate URLs in pending", () => {
      const url = "https://example.com/page1";
      q.enqueue(makeTask({ url }));
      q.enqueue(makeTask({ url }));
      expect(q.pendingCount).toBe(1);
    });

    it("skips URLs already done", () => {
      const url = "https://example.com/done";
      const t = makeTask({ url });
      q.enqueue(t);
      const dequeued = q.dequeue()!;
      q.markDone(dequeued.id);

      q.enqueue(makeTask({ url }));
      expect(q.pendingCount).toBe(0);
    });
  });

  describe("enqueueMany", () => {
    it("enqueues multiple tasks at once", () => {
      const tasks = [makeTask(input()), makeTask(input()), makeTask(input())];
      q.enqueueMany(tasks);
      expect(q.pendingCount).toBe(3);
    });
  });

  describe("markDone", () => {
    it("marks a running task as done", () => {
      q.enqueue(makeTask(input()));
      const t = q.dequeue()!;
      q.markDone(t.id);
      expect(q.doneCount).toBe(1);
      expect(q.runningCount).toBe(0);
    });

    it("does nothing for unknown task ID", () => {
      q.markDone("nonexistent");
      expect(q.doneCount).toBe(0);
    });
  });

  describe("markFailed", () => {
    it("requeues a failed task with lower priority", () => {
      const t = makeTask(input({ priority: 3, maxRetries: 3 }));
      q.enqueue(t);
      const dequeued = q.dequeue()!;
      q.markFailed(dequeued.id, "timeout");

      expect(q.pendingCount).toBe(1);
      expect(q.runningCount).toBe(0);
      const requeued = q.dequeue()!;
      expect(requeued.retries).toBe(1);
      expect(requeued.priority).toBe(4); // 3 + 1
    });

    it("sends to dead letter after max retries", () => {
      const t = makeTask(input({ maxRetries: 1 }));
      q.enqueue(t);
      const dequeued = q.dequeue()!;
      q.markFailed(dequeued.id, "permanent error");

      expect(q.pendingCount).toBe(0);
      expect(q.deadCount).toBe(1);
      expect(q.getDeadLetter()).toHaveLength(1);
      expect(q.getDeadLetter()[0].status).toBe("dead_letter");
    });
  });

  describe("spawnFromCrawl", () => {
    it("creates child tasks from crawl discovery", () => {
      const parent = makeTask(input({
        priority: 2,
        group: "crawl_group",
        tags: ["tag1"],
        crawl_depth: 2,
      }));
      q.enqueue(parent);
      q.dequeue();

      const children = q.spawnFromCrawl(parent, [
        "https://a.com/1",
        "https://a.com/2",
      ]);

      expect(children).toHaveLength(2);
      expect(q.pendingCount).toBe(2);
      expect(children[0].priority).toBe(3); // parent.priority + 1
      expect(children[0].group).toBe("crawl_group");
      expect(children[0].parentId).toBe(parent.id);
    });

    it("returns empty if crawl depth is exhausted", () => {
      const parent = makeTask(input({ crawl_depth: 0 }));
      const children = q.spawnFromCrawl(parent, ["https://a.com"]);
      expect(children).toHaveLength(0);
    });

    it("skips already-known URLs", () => {
      const existing = makeTask({ url: "https://known.com" });
      q.enqueue(existing);
      const d = q.dequeue()!;
      q.markDone(d.id);

      const parent = makeTask(input({ crawl_depth: 2 }));
      const children = q.spawnFromCrawl(parent, ["https://known.com", "https://new.com"]);
      expect(children).toHaveLength(1);
      expect(children[0].url).toBe("https://new.com");
    });

    it("deduplicates within batch", () => {
      const parent = makeTask(input({ crawl_depth: 2 }));
      const children = q.spawnFromCrawl(parent, [
        "https://dup.com",
        "https://dup.com",
        "https://dup.com",
      ]);
      expect(children).toHaveLength(1);
    });
  });

  describe("drainPending", () => {
    it("drains all pending tasks", () => {
      q.enqueue(makeTask(input()));
      q.enqueue(makeTask(input()));
      const drained = q.drainPending();
      expect(drained).toHaveLength(2);
      expect(q.pendingCount).toBe(0);
    });
  });

  describe("counters and state", () => {
    it("reports isEmpty correctly", () => {
      expect(q.isEmpty).toBe(true);
      q.enqueue(makeTask(input()));
      expect(q.isEmpty).toBe(false);
      q.dequeue();
      expect(q.isEmpty).toBe(false); // still running
    });

    it("tracks totalCount", () => {
      q.enqueue(makeTask(input()));
      q.enqueue(makeTask(input()));
      const t = q.dequeue()!;
      q.markDone(t.id);
      expect(q.totalCount).toBe(2);
    });

    it("isDoneUrl returns correct value", () => {
      const url = "https://example.com/check";
      expect(q.isDoneUrl(url)).toBe(false);
      const t = makeTask({ url });
      q.enqueue(t);
      q.markDone(q.dequeue()!.id);
      expect(q.isDoneUrl(url)).toBe(true);
    });

    it("getDoneUrls returns set of done URLs", () => {
      const t = makeTask({ url: "https://done.com" });
      q.enqueue(t);
      q.markDone(q.dequeue()!.id);
      const urls = q.getDoneUrls();
      expect(urls.has("https://done.com")).toBe(true);
    });
  });

  describe("snapshot / loadSnapshot", () => {
    it("takes and restores snapshot", () => {
      const t = makeTask({ url: "https://snap.com" });
      q.enqueue(t);
      q.markDone(q.dequeue()!.id);
      const snap = q.snapshot() as { doneUrls: string[] };

      const q2 = new TaskQueue();
      q2.loadSnapshot(snap);
      expect(q2.isDoneUrl("https://snap.com")).toBe(true);
    });
  });
});
