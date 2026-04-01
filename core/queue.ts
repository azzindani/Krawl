// core/queue.ts
// Priority task queue
// Lower priority number = processed first

export type TaskMode =
  | "auto"
  | "http_json"
  | "http_curl"
  | "browser"
  | "crawl"
  | "blocked";

export type TaskStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "skipped"
  | "dead_letter";

export interface Task {
  id          : string;
  name        : string;
  url         : string;
  mode        : TaskMode;
  priority    : number;       // 1 = highest
  group       : string;
  tags        : string[];
  retries     : number;
  maxRetries  : number;
  status      : TaskStatus;
  crawlDepth ?: number;
  collectFiles?: string[];
  parentId   ?: string;       // for tasks spawned by crawl
  createdAt   : string;
  startedAt  ?: string;
  finishedAt ?: string;
  error      ?: string;
}

export interface TaskInput {
  name         ?: string;
  url           : string;
  mode         ?: TaskMode;
  priority     ?: number;
  group        ?: string;
  tags         ?: string[];
  maxRetries   ?: number;
  crawl_depth  ?: number;
  collect_files?: string[];
}

let _idCounter = 0;

export function makeTask(input: TaskInput, parentId?: string): Task {
  _idCounter++;
  return {
    id        : `task_${Date.now()}_${_idCounter}`,
    name      : input.name ?? new URL(input.url).hostname,
    url       : input.url,
    mode      : input.mode ?? "auto",
    priority  : input.priority ?? 5,
    group     : input.group ?? "default",
    tags      : input.tags ?? [],
    retries   : 0,
    maxRetries: input.maxRetries ?? 3,
    status    : "pending",
    crawlDepth: input.crawl_depth,
    collectFiles: input.collect_files,
    parentId,
    createdAt : new Date().toISOString(),
  };
}

export class TaskQueue {
  private pending   : Task[] = [];
  private running   : Map<string, Task> = new Map();
  private done      : Map<string, Task> = new Map();
  private failed    : Task[] = [];
  private deadLetter: Task[] = [];

  enqueue(task: Task): void {
    // Skip if already done
    if (this.done.has(task.url)) return;
    // Skip duplicates in pending
    if (this.pending.some(t => t.url === task.url)) return;
    this.pending.push(task);
    // Sort by priority ascending (1 = first)
    this.pending.sort((a, b) => a.priority - b.priority);
  }

  enqueueMany(tasks: Task[]): void {
    for (const t of tasks) this.enqueue(t);
  }

  dequeue(): Task | undefined {
    const task = this.pending.shift();
    if (task) {
      task.status    = "running";
      task.startedAt = new Date().toISOString();
      this.running.set(task.id, task);
    }
    return task;
  }

  markDone(taskId: string): void {
    const task = this.running.get(taskId);
    if (!task) return;
    task.status     = "done";
    task.finishedAt = new Date().toISOString();
    this.running.delete(taskId);
    this.done.set(task.url, task);
  }

  markFailed(taskId: string, error: string): void {
    const task = this.running.get(taskId);
    if (!task) return;
    task.error  = error;
    task.retries++;

    if (task.retries >= task.maxRetries) {
      task.status = "dead_letter";
      this.deadLetter.push(task);
    } else {
      // Requeue with lower priority (higher number)
      task.status   = "pending";
      task.priority = task.priority + task.retries;
      this.pending.push(task);
      this.pending.sort((a, b) => a.priority - b.priority);
    }
    this.running.delete(taskId);
  }

  // Spawn child tasks from crawl discovery
  spawnFromCrawl(parentTask: Task, urls: string[]): Task[] {
    const depth = (parentTask.crawlDepth ?? 0) - 1;
    if (depth < 0) return [];

    const children: Task[] = [];
    for (const url of urls) {
      const child = makeTask({
        url,
        mode      : "auto",
        priority  : parentTask.priority + 1,
        group     : parentTask.group,
        tags      : parentTask.tags,
        crawl_depth: depth,
      }, parentTask.id);
      this.enqueue(child);
      children.push(child);
    }
    return children;
  }

  isDoneUrl(url: string): boolean {
    return this.done.has(url);
  }

  get pendingCount() : number { return this.pending.length; }
  get runningCount() : number { return this.running.size; }
  get doneCount()    : number { return this.done.size; }
  get failedCount()  : number { return this.failed.length; }
  get deadCount()    : number { return this.deadLetter.size; }
  get totalCount()   : number {
    return this.pendingCount + this.runningCount +
           this.doneCount + this.failedCount;
  }
  get isEmpty()      : boolean {
    return this.pendingCount === 0 && this.runningCount === 0;
  }

  getDoneUrls(): Set<string> {
    return new Set(this.done.keys());
  }

  getDeadLetter(): Task[] { return [...this.deadLetter]; }

  snapshot(): object {
    return {
      pending   : this.pending.length,
      running   : this.running.size,
      done      : this.done.size,
      dead      : this.deadLetter.length,
      doneUrls  : [...this.done.keys()],
    };
  }

  loadSnapshot(snap: ReturnType<typeof this.snapshot> & {
    doneUrls: string[]
  }): void {
    for (const url of snap.doneUrls) {
      this.done.set(url, makeTask({ url }));
    }
  }
}
