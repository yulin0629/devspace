import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, unlink, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const EVENT_LIMITS = {
  eventBytes: 16 * 1024,
  segmentBytes: 16 * 1024 * 1024,
  retentionBytes: 1024 * 1024 * 1024,
  retentionMs: 7 * 24 * 60 * 60 * 1000,
};

export interface ToolEvent {
  schema_version: 1;
  event_id: string;
  event_type: "tool.completed";
  occurred_at: string;
  machine_id: string;
  workspace_id: string;
  project: string;
  cwd: string;
  tool: string;
  outcome: { status: "success" | "failure"; duration_ms: number };
  details?: Record<string, string | number>;
}

const SEGMENT_NAME = /^\d+-[0-9a-f-]{36}\.jsonl$/;
const QUEUE_LIMIT = 1024;

export class EventSpool {
  private readonly queue: Array<() => ToolEvent> = [];
  private readonly idle: Array<() => void> = [];
  private draining = false;
  private initialized = false;
  private current?: { file: FileHandle; name: string; bytes: number; created: number };
  private readonly enabled: boolean;
  readonly dir: string;
  private readonly limits: typeof EVENT_LIMITS;
  private readonly now: () => number;
  private readonly warn: (code: string) => void;

  constructor(options: {
    enabled: boolean;
    dir?: string;
    limits?: Partial<typeof EVENT_LIMITS>;
    now?: () => number;
    warn?: (code: string) => void;
  }) {
    this.enabled = options.enabled;
    this.dir = options.dir ?? join(homedir(), ".local/share/devspace/events");
    this.limits = { ...EVENT_LIMITS, ...options.limits };
    this.now = options.now ?? Date.now;
    this.warn = options.warn ?? ((code) => console.warn(`[devspace.events] ${code}`));
  }

  enqueue(event: () => ToolEvent): void {
    if (!this.enabled) return;
    // debt: ceiling: 1024 pending events; upgrade: sustained writer backpressure.
    if (this.queue.length >= QUEUE_LIMIT) { this.warn("queue_limit_event_dropped"); return; }
    this.queue.push(event);
    if (!this.draining) {
      this.draining = true;
      setImmediate(() => { void this.drain(); });
    }
  }

  private async drain(): Promise<void> {
    while (this.queue.length) {
      const next = this.queue.shift()!;
      try { await this.append(next()); }
      catch {
        await this.current?.file.close().catch(() => {});
        this.current = undefined;
        this.warn("write_failed_event_dropped");
      }
    }
    this.draining = false;
    this.idle.splice(0).forEach((resolve) => resolve());
  }

  async flush(): Promise<void> {
    if (this.draining) await new Promise<void>((resolve) => this.idle.push(resolve));
  }

  async close(): Promise<void> {
    await this.flush();
    await this.current?.file.close();
    this.current = undefined;
  }

  private async append(event: ToolEvent): Promise<void> {
    let line = JSON.stringify(event) + "\n";
    if (Buffer.byteLength(line) > this.limits.eventBytes) {
      delete event.details;
      line = JSON.stringify(event) + "\n";
      this.warn("event_details_truncated");
    }
    const bytes = Buffer.byteLength(line);
    if (bytes > this.limits.eventBytes) { this.warn("event_limit_event_dropped"); return; }
    if (!this.initialized) {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const info = await lstat(this.dir);
      if (!info.isDirectory() || info.uid !== process.getuid?.()) throw new Error("invalid_events_directory");
      await chmod(this.dir, 0o700);
      this.initialized = true;
    }
    if (this.current && (this.current.bytes + bytes > this.limits.segmentBytes
      || this.now() - this.current.created >= this.limits.retentionMs)) {
      await this.current.file.close();
      this.current = undefined;
    }
    await this.prune(bytes);
    if (!this.current) {
      const created = this.now();
      const name = `${created}-${randomUUID()}.jsonl`;
      const file = await open(join(this.dir, name), "wx", 0o600);
      this.current = { file, name, bytes: 0, created };
    }
    await this.current.file.writeFile(line);
    this.current.bytes += bytes;
  }

  private async prune(incoming: number): Promise<void> {
    const files = [];
    for (const name of await readdir(this.dir)) {
      if (!SEGMENT_NAME.test(name)) continue;
      const info = await lstat(join(this.dir, name));
      if (info.isFile()) files.push({ name, bytes: info.size, created: Number(name.split("-")[0]) });
    }
    files.sort((a, b) => a.created - b.created || a.name.localeCompare(b.name));
    let total = files.reduce((sum, file) => sum + file.bytes, 0) + incoming;
    if (total >= this.limits.retentionBytes * 0.8
      || files.some((file) => this.now() - file.created >= this.limits.retentionMs * 0.8)) this.warn("retention_limit_approaching");
    for (const file of files) {
      if (file.name === this.current?.name) continue;
      if (total <= this.limits.retentionBytes && this.now() - file.created < this.limits.retentionMs) continue;
      this.warn("retention_removing_oldest_segment");
      await unlink(join(this.dir, file.name));
      total -= file.bytes;
    }
  }
}
