import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, readdir, unlink, type FileHandle } from "node:fs/promises";
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
const RETENTION_CHECK_MS = 60 * 1000;
const IO_CODES = new Set(["EACCES", "EEXIST", "EIO", "EISDIR", "EMFILE", "ENFILE", "ENOENT", "ENOSPC", "ENOTDIR", "EPERM", "EROFS", "EINVAL", "INVALID_EVENTS_DIRECTORY"]);

export class EventSpool {
  private readonly queue: Array<ToolEvent | undefined> = [];
  private readonly idle: Array<() => void> = [];
  private draining = false;
  private initialized = false;
  private retentionTimer?: ReturnType<typeof setInterval>;
  private maintenanceQueued = false;
  private retentionApproaching = false;
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

  enqueue(event: ToolEvent): void {
    if (!this.enabled) return;
    // debt: ceiling: 1024 pending events; upgrade: sustained writer backpressure.
    if (this.queue.length >= QUEUE_LIMIT) { this.warn("queue_limit_event_dropped"); return; }
    this.queue.push(event);
    this.startDrain();
  }

  private startDrain(): void {
    if (!this.draining) {
      this.draining = true;
      setImmediate(() => { void this.drain(); });
    }
  }

  private async drain(): Promise<void> {
    while (this.queue.length) {
      const next = this.queue.shift();
      try {
        if (next) await this.append(next);
        else {
          this.maintenanceQueued = false;
          if (this.current && this.now() - this.current.created >= this.limits.retentionMs) {
            await this.closeCurrent();
          }
          await this.prune(0);
        }
      }
      catch (error) {
        await this.closeCurrent().catch(() => {});
        this.initialized = false;
        const code = (error as NodeJS.ErrnoException)?.code;
        this.warn(`${next ? "write_failed_event_dropped" : "retention_failed"}:${code && IO_CODES.has(code) ? code : "UNKNOWN"}`);
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
    clearInterval(this.retentionTimer);
    this.retentionTimer = undefined;
    await this.closeCurrent();
  }

  private async closeCurrent(): Promise<void> {
    const current = this.current;
    this.current = undefined;
    if (!current) return;
    await current.file.close();
    try { await unlink(join(this.dir, `${current.name}.active`)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }

  private async isActive(name: string): Promise<boolean> {
    const marker = join(this.dir, `${name}.active`);
    try {
      const info = await lstat(marker);
      if (!info.isFile() || info.size > 32) return true;
      const value = await readFile(marker, "utf8");
      if (!/^[1-9]\d*\n$/.test(value)) return true;
      const pid = Number(value.trim());
      if (!Number.isSafeInteger(pid)) return true;
      try { process.kill(pid, 0); return true; }
      catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      return true;
    }
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
      if (!info.isDirectory() || info.uid !== process.getuid?.()) throw Object.assign(new Error("invalid_events_directory"), { code: "INVALID_EVENTS_DIRECTORY" });
      await chmod(this.dir, 0o700);
      this.initialized = true;
      if (!this.retentionTimer) {
        this.retentionTimer = setInterval(() => {
          if (this.maintenanceQueued) return;
          this.maintenanceQueued = true;
          this.queue.push(undefined);
          this.startDrain();
        }, Math.max(1, Math.min(RETENTION_CHECK_MS, this.limits.retentionMs / 5)));
        this.retentionTimer.unref();
      }
    }
    if (this.current && (this.current.bytes + bytes > this.limits.segmentBytes
      || this.now() - this.current.created >= this.limits.retentionMs)) {
      await this.closeCurrent();
    }
    if (!await this.prune(bytes)) { this.warn("retention_active_segments_event_dropped"); return; }
    if (!this.current) {
      const created = this.now();
      const name = `${created}-${randomUUID()}.jsonl`;
      // Publish ownership before the JSONL file can be seen by another process's pruner.
      const marker = await open(join(this.dir, `${name}.active`), "wx", 0o600);
      try {
        try { await marker.writeFile(`${process.pid}\n`); } finally { await marker.close(); }
        const file = await open(join(this.dir, name), "wx", 0o600);
        this.current = { file, name, bytes: 0, created };
      } catch (error) {
        await unlink(join(this.dir, `${name}.active`)).catch(() => {});
        throw error;
      }
    }
    try {
      await this.current.file.writeFile(line);
    } catch (error) {
      try { await this.current.file.truncate(this.current.bytes); }
      catch { this.warn("partial_write_rollback_failed"); }
      throw error;
    }
    this.current.bytes += bytes;
  }

  private async prune(incoming: number): Promise<boolean> {
    const files: Array<{ name: string; bytes: number; created: number }> = [];
    for (const name of await readdir(this.dir)) {
      if (!SEGMENT_NAME.test(name)) continue;
      let info;
      try { info = await lstat(join(this.dir, name)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      if (info.isFile()) files.push({ name, bytes: info.size, created: Number(name.split("-")[0]) });
    }
    files.sort((a, b) => a.created - b.created || a.name.localeCompare(b.name));
    let total = files.reduce((sum, file) => sum + file.bytes, 0) + incoming;
    const retained = new Set(files.map((file) => file.name));
    const approaching = () => total >= this.limits.retentionBytes * 0.8
      || files.some((file) => retained.has(file.name) && this.now() - file.created >= this.limits.retentionMs * 0.8);
    if (approaching() && !this.retentionApproaching) this.warn("retention_limit_approaching");
    for (const file of files) {
      if (file.name === this.current?.name) continue;
      if (total <= this.limits.retentionBytes && this.now() - file.created < this.limits.retentionMs) continue;
      if (await this.isActive(file.name)) continue;
      this.warn("retention_removing_oldest_segment");
      try { await unlink(join(this.dir, file.name)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      try { await unlink(join(this.dir, `${file.name}.active`)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      total -= file.bytes;
      retained.delete(file.name);
    }
    this.retentionApproaching = approaching();
    return total <= this.limits.retentionBytes;
  }
}
