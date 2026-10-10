import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig, type ServerConfig } from "../config.js";
import { createMcpServer } from "../server.js";
import { WorkspaceRegistry } from "../workspaces.js";
import { createReviewCheckpointManager } from "../review-checkpoints.js";
import { ProcessSessionManager } from "../process-sessions.js";
import { writeTestDevspaceConfig } from "../test-support/config.test.js";
import type { McpRegistrationTarget } from "../mcp-modern-server.js";
import { toolEvent, withEventObservation } from "./observation.js";
import { EventSpool, EVENT_LIMITS, type ToolEvent } from "./spool.js";
import { commandSummary, redact, statusOutput } from "./privacy.js";

const execFileAsync = promisify(execFile);

async function temporary(t: test.TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "devspace-events-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function events(dir: string): Promise<ToolEvent[]> {
  const lines = await Promise.all((await readdir(dir)).filter((file) => file.endsWith(".jsonl")).sort().map((file) => readFile(join(dir, file), "utf8")));
  return lines.join("").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function sample(): ToolEvent {
  return {
    schema_version: 1, event_id: randomUUID(), event_type: "tool.completed", occurred_at: new Date().toISOString(),
    machine_id: "host", workspace_id: "workspace", project: "example", cwd: "/tmp/example", tool: "other",
    outcome: { status: "success", duration_ms: 1 },
  };
}

test("real MCP handlers emit the six whitelisted tools and retain their original results", { skip: process.platform === "win32" }, async (t) => {
  const dir = await temporary(t);
  const root = join(dir, "repo");
  await mkdir(root);
  await execFileAsync("git", ["init", root]);
  await writeFile(join(root, "example.ts"), "export const before = 1;\n");
  await execFileAsync("git", ["-C", root, "add", "example.ts"]);
  await execFileAsync("git", ["-C", root, "-c", "core.hooksPath=/dev/null", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture"]);
  const config = loadConfig(writeTestDevspaceConfig(join(dir, "config"), {
    events: { enabled: true }, workspaces: { allowedRoots: [root], worktreeRoot: join(dir, "worktrees") },
    storage: { stateDir: join(dir, "state") }, tools: { mode: "claude" },
    ui: { enabled: false }, skills: { enabled: false }, logging: { level: "silent" },
  }));
  const spool = new EventSpool({ enabled: true, dir: join(dir, "events") });
  const processes = new ProcessSessionManager();
  const server = createMcpServer(config, new WorkspaceRegistry(config), createReviewCheckpointManager(), processes, () => [], [], undefined, spool);
  const client = new Client({ name: "events-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); processes.shutdown(); await spool.close(); });
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
  const opened = await call("open_workspace", { path: root, mode: "checkout" });
  const workspace_id = (opened.structuredContent as Record<string, unknown>)?.workspace_id as string;
  assert.ok(workspace_id);
  const read = await call("read", { workspace_id, path: "example.ts", offset: 1, limit: 1 });
  assert.match((read.structuredContent as Record<string, unknown>)?.result as string, /export const before/);
  const source = "export const secretFixture = 2;\n";
  assert.ok(!(await call("write", { workspace_id, path: "example.ts", content: source })).isError);
  assert.ok(!(await call("edit", { workspace_id, path: "example.ts", edits: [{ old_text: "= 2", new_text: "= 3" }] })).isError);
  assert.ok(!(await call("bash", { workspace_id, command: "printf 'PASS\\n'" })).isError);
  assert.ok(!(await call("show_changes", { workspace_id })).isError);
  assert.equal((await call("read", { workspace_id, path: "missing.ts" })).isError, true);
  assert.equal((await call("bash", { workspace_id, command: "exit 7" })).isError, true);
  await spool.flush();
  const recorded = await events(spool.dir);
  assert.deepEqual(recorded.map((event) => event.tool), ["open_workspace", "read", "write", "edit", "bash", "show_changes", "read", "bash"]);
  assert.equal(new Set(recorded.map((event) => event.event_id)).size, 8);
  assert.equal(recorded[0].workspace_id, workspace_id);
  assert.equal(recorded[0].cwd, root);
  assert.equal(recorded[0].details?.mode, "checkout");
  assert.equal(recorded[1].details?.offset, 1);
  assert.ok(Number(recorded[1].details?.read_bytes) > 0);
  assert.equal(recorded[2].details?.content_bytes, Buffer.byteLength(source));
  assert.equal(recorded[2].details?.lines, 1);
  assert.equal(recorded[3].details?.edit_count, 1);
  assert.equal(recorded[3].details?.old_bytes, 3);
  assert.equal(recorded[3].details?.new_bytes, 3);
  assert.equal(recorded[4].details?.command_summary, "printf");
  assert.equal(recorded[4].details?.output, "PASS");
  assert.equal(recorded[5].details?.files, 1);
  assert.equal(recorded[5].details?.additions, 1);
  assert.equal(recorded[5].details?.removals, 1);
  assert.equal(recorded[6].outcome.status, "failure");
  assert.equal(recorded[6].details?.read_bytes, undefined);
  assert.equal(recorded[7].outcome.status, "failure");
  assert.equal(recorded[7].details?.exit_code, 7);
  assert.ok(!JSON.stringify(recorded).includes(source.trim()));
  assert.ok(!JSON.stringify(recorded).includes("export const before"));
});

test("disabled events never serialize metadata or create a spool", async (t) => {
  const dir = join(await temporary(t), "absent");
  const spool = new EventSpool({ enabled: false, dir });
  spool.enqueue({ ...sample(), get details(): never { throw new Error("must not serialize"); } });
  await spool.close();
  await assert.rejects(stat(dir), { code: "ENOENT" });
});

test("the FIFO writer enforces line size, segment size, retention and private modes", { skip: process.platform === "win32" }, async (t) => {
  const dir = join(await temporary(t), "events");
  const warnings: string[] = [];
  let time = 10_000;
  const spool = new EventSpool({ enabled: true, dir, now: () => time,
    limits: { segmentBytes: 800, retentionBytes: 1800, retentionMs: 1000 }, warn: (code) => warnings.push(code) });
  for (let i = 0; i < 9; i++) { spool.enqueue(sample()); await spool.flush(); time++; }
  assert.ok(warnings.indexOf("retention_limit_approaching") < warnings.indexOf("retention_removing_oldest_segment"));
  let total = 0;
  for (const name of await readdir(dir)) {
    const info = await stat(join(dir, name));
    assert.ok(info.size <= 800); total += info.size;
    assert.equal(info.mode & 0o777, 0o600);
    if (!name.endsWith(".jsonl")) continue;
    for (const line of (await readFile(join(dir, name), "utf8")).trim().split("\n")) {
      assert.ok(Buffer.byteLength(line + "\n") <= EVENT_LIMITS.eventBytes);
      JSON.parse(line);
    }
  }
  assert.ok(total <= 1800);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  time += 1001;
  spool.enqueue(sample());
  await spool.flush();
  assert.equal((await readdir(dir)).filter((name) => name.endsWith(".jsonl")).length, 1);
  spool.enqueue({ ...sample(), details: { oversized: "繁".repeat(20_000) } });
  await spool.close();
  assert.ok(warnings.includes("event_details_truncated"));
});

test("observer write failures preserve successful results and original tool errors", async (t) => {
  const dir = await temporary(t);
  const blocked = join(dir, "file");
  await writeFile(blocked, "fixture");
  const warnings: string[] = [];
  const spool = new EventSpool({ enabled: true, dir: blocked, warn: (code) => warnings.push(code) });
  const handlers = new Map<string, Function>();
  const target = { registerTool: (...args: unknown[]) => handlers.set(args[0] as string, args.at(-1) as Function), registerResource: () => {} } as unknown as McpRegistrationTarget;
  const registry = { eventContext: () => ({ project: "example", cwd: dir }) } as unknown as WorkspaceRegistry;
  const wrapped = withEventObservation(target, { events: { enabled: true } } as ServerConfig, registry, spool);
  const response = { content: [{ type: "text" as const, text: "raw data" }] };
  const failure = new Error("original tool failure");
  wrapped.registerTool("other", {}, async () => response);
  wrapped.registerTool("failure", {}, async () => { throw failure; });
  assert.equal(await handlers.get("other")!({ workspace_id: "workspace" }), response);
  await assert.rejects(handlers.get("failure")!({ workspace_id: "workspace" }), (error) => error === failure);
  await spool.flush();
  assert.equal(warnings.filter((code) => code === "write_failed_event_dropped:EEXIST").length, 2);
});

test("retention expires idle segments without creating another event file", { skip: process.platform === "win32" }, async (t) => {
  const dir = join(await temporary(t), "events");
  const warnings: string[] = [];
  let time = 10_000;
  const spool = new EventSpool({ enabled: true, dir, now: () => time, limits: { retentionMs: 100 }, warn: (code) => warnings.push(code) });
  t.after(() => spool.close());
  spool.enqueue(sample());
  await spool.flush();
  assert.equal((await readdir(dir)).filter((name) => name.endsWith(".jsonl")).length, 1);
  time += 101;
  const deadline = Date.now() + 2000;
  while ((await readdir(dir)).length && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20));
  await spool.flush();
  assert.deepEqual(await readdir(dir), []);
  assert.ok(warnings.includes("retention_removing_oldest_segment"));
});

test("retention preserves another process's open segment until its writer closes", { skip: process.platform === "win32", timeout: 15_000 }, async (t) => {
  const dir = join(await temporary(t), "events"), value = sample();
  const script = `
    import { EventSpool } from ${JSON.stringify(new URL("./spool.ts", import.meta.url).href)};
    const spool = new EventSpool({ enabled: true, dir: ${JSON.stringify(dir)}, now: () => 10_000, limits: { retentionMs: 1000 } });
    const value = ${JSON.stringify(value)};
    spool.enqueue(value); await spool.flush(); process.send("ready");
    process.on("message", async (command) => {
      if (command === "append") { spool.enqueue(value); await spool.flush(); process.send("appended"); }
      if (command === "close") { await spool.close(); process.send("closed"); process.disconnect(); }
    });
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let errors = "";
  child.stderr!.on("data", (data) => { errors += data; });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const ready = await Promise.race([once(child, "message"), once(child, "exit").then(() => { throw new Error(errors || "writer exited before ready"); })]);
  assert.equal(ready[0], "ready");
  const activeName = (await readdir(dir)).find((name) => name.endsWith(".jsonl"))!;
  const warnings: string[] = [];
  const spool = new EventSpool({ enabled: true, dir, now: () => 20_000, limits: { retentionMs: 1000 }, warn: (code) => warnings.push(code) });
  t.after(() => spool.close());
  spool.enqueue(sample()); await spool.flush();
  assert.ok((await stat(join(dir, activeName))).size > 0);
  const appended = once(child, "message"); child.send("append");
  assert.equal((await appended)[0], "appended");
  assert.equal((await readFile(join(dir, activeName), "utf8")).trim().split("\n").length, 2);
  const closed = once(child, "message"), exited = once(child, "exit"); child.send("close");
  assert.equal((await closed)[0], "closed");
  assert.equal((await exited)[0], 0);
  spool.enqueue(sample()); await spool.flush();
  await assert.rejects(stat(join(dir, activeName)), { code: "ENOENT" });
  assert.ok(warnings.includes("retention_removing_oldest_segment"));
});

test("retention drops an incoming event rather than deleting a live foreign segment", { skip: process.platform === "win32" }, async (t) => {
  const dir = join(await temporary(t), "events"), value = sample();
  const bytes = Buffer.byteLength(JSON.stringify(value) + "\n");
  const first = new EventSpool({ enabled: true, dir });
  t.after(() => first.close());
  first.enqueue(value); await first.flush();
  const warnings: string[] = [];
  const second = new EventSpool({ enabled: true, dir, limits: { retentionBytes: bytes }, warn: (code) => warnings.push(code) });
  t.after(() => second.close());
  second.enqueue(sample()); await second.flush();
  assert.deepEqual(await events(dir), [value]);
  assert.ok(warnings.includes("retention_active_segments_event_dropped"));
});

test("process exit and signal failures affect outcomes without adding generic tool details", () => {
  const registry = { eventContext: () => undefined } as unknown as WorkspaceRegistry;
  const config = { events: { enabled: true } } as ServerConfig;
  for (const [tool, result, status] of [
    ["exec_command", { structuredContent: { exit_code: 1 } }, "failure"],
    ["write_stdin", { structuredContent: { signal: "SIGTERM" } }, "failure"],
    ["exec_command", { structuredContent: { exit_code: 0 } }, "success"],
    ["exec_command", { structuredContent: { session_id: 1 } }, "success"],
    ["bash", { details: { exitCode: 7 } }, "failure"],
  ] as const) {
    const event = toolEvent(tool, { workspace_id: "workspace" }, result, false, 1, new Date().toISOString(), config, registry);
    assert.equal(event.outcome.status, status);
    if (tool !== "bash") assert.equal(event.details, undefined);
  }
});

test("sensitive or truncated identities remain distinct without retaining their plaintext", () => {
  const registry = { eventContext: () => undefined } as unknown as WorkspaceRegistry;
  const identities = ["token=fixture-alpha", "token=fixture-beta", "host-" + "a".repeat(130), "host-" + "a".repeat(129) + "b"];
  const recorded = identities.map((identity) => toolEvent("open_workspace", { workspace_id: identity }, {}, false, 1,
    new Date().toISOString(), { machine: { name: identity } } as ServerConfig, registry));
  assert.equal(new Set(recorded.map((event) => event.machine_id)).size, identities.length);
  assert.equal(new Set(recorded.map((event) => event.workspace_id)).size, identities.length);
  for (const [index, event] of recorded.entries()) {
    assert.ok(!JSON.stringify(event).includes(identities[index]));
    assert.ok(event.machine_id.length <= 128);
    assert.equal(event.details?.workspace_id, event.workspace_id);
  }
  const ordinary = toolEvent("other", { workspace_id: "workspace" }, {}, false, 1, new Date().toISOString(),
    { machine: { name: "host" } } as ServerConfig, registry);
  assert.equal(ordinary.machine_id, "host");
  assert.equal(ordinary.workspace_id, "workspace");
});

test("retention warning fires once per approach episode and resets after pruning", { skip: process.platform === "win32" }, async (t) => {
  const dir = join(await temporary(t), "events"), value = sample();
  const bytes = Buffer.byteLength(JSON.stringify(value) + "\n");
  const warnings: string[] = [];
  const spool = new EventSpool({ enabled: true, dir, limits: { segmentBytes: bytes * 2, retentionBytes: bytes * 4 }, warn: (code) => warnings.push(code) });
  t.after(() => spool.close());
  for (let i = 0; i < 5; i++) { spool.enqueue({ ...value }); await spool.flush(); }
  assert.equal(warnings.filter((code) => code === "retention_limit_approaching").length, 1);
  spool.enqueue({ ...value });
  await spool.flush();
  assert.equal(warnings.filter((code) => code === "retention_limit_approaching").length, 2);
});

test("a directly created MCP server flushes its owned spool on close", { skip: process.platform === "win32" }, async (t) => {
  const dir = await temporary(t), previousHome = process.env.HOME;
  process.env.HOME = dir;
  t.after(() => { if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome; });
  const config = loadConfig(writeTestDevspaceConfig(join(dir, "config"), {
    events: { enabled: true }, workspaces: { allowedRoots: [dir] }, storage: { stateDir: join(dir, "state") },
    tools: { mode: "claude" }, ui: { enabled: false }, skills: { enabled: false }, logging: { level: "silent" },
  }));
  const processes = new ProcessSessionManager();
  const server = createMcpServer(config, new WorkspaceRegistry(config), createReviewCheckpointManager(), processes, () => [], []);
  const client = new Client({ name: "owned-spool-test", version: "1.0.0" });
  t.after(async () => { await client.close(); await server.close(); processes.shutdown(); });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  assert.ok(!(await client.callTool({ name: "open_workspace", arguments: { path: dir, mode: "checkout" } })).isError);
  await server.close();
  const recorded = await events(join(dir, ".local/share/devspace/events"));
  assert.deepEqual(recorded.map((event) => event.tool), ["open_workspace"]);
});

test("privacy filters keep operational metadata and omit source, credentials and command arguments", () => {
  assert.equal(commandSummary("git status --short && curl -H 'Authorization: Bearer fixture' https://example.invalid"), "git status; curl");
  assert.equal(commandSummary("TOKEN=fixture node -e 'raw code'"), "[command]");
  assert.equal(statusOutput("const token = 'fixture';\nPASS"), "PASS");
  assert.equal(statusOutput("password=fixture"), "[output omitted]");
  assert.equal(redact("src/feature-file.ts"), "src/feature-file.ts");
  assert.equal(redact("api_key=fixture-value"), "api_key=[redacted]");
  assert.ok(!redact('{"token":"fixture-value"}').includes("fixture-value"));
  assert.equal(redact("data:image/png;base64,ZmFrZQ=="), "[attachment omitted]");
  assert.equal(redact("https://name:fixture@example.invalid"), "https://[redacted]@example.invalid");
  assert.equal(redact("-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----"), "[redacted]");
});

test("enabled event observation adds less than 5 ms at p95 with the real async writer", { skip: process.platform === "win32" }, async (t) => {
  const dir = join(await temporary(t), "events");
  const warnings: string[] = [];
  const spool = new EventSpool({ enabled: true, dir, warn: (code) => warnings.push(code) });
  const handlers = new Map<string, Function>();
  const target = { registerTool: (...args: unknown[]) => handlers.set(args[0] as string, args.at(-1) as Function), registerResource: () => {} } as unknown as McpRegistrationTarget;
  const registry = { eventContext: () => ({ project: "example", cwd: "/tmp/example" }) } as unknown as WorkspaceRegistry;
  const wrapped = withEventObservation(target, { events: { enabled: true } } as ServerConfig, registry, spool);
  const source = "export const example = 1;\n".repeat(160);
  const handler = async () => ({ content: [], structuredContent: { workspace_id: "workspace", mode: "checkout", result: source }, _meta: { card: { summary: { files: 1, additions: 1, removals: 1 } } } });
  const tools = ["open_workspace", "read", "show_changes", "write", "edit", "bash", "other"];
  for (const tool of tools) wrapped.registerTool(tool, {}, handler);
  const input = { workspace_id: "workspace", path: "example.ts", content: source, edits: [{ old_text: source, new_text: source }], command: "git status --short" };
  const deltas: number[] = [];
  for (let i = 0; i < 1000; i++) {
    const baseStart = performance.now(); await handler(); const baseline = performance.now() - baseStart;
    const eventStart = performance.now(); await handlers.get(tools[i % tools.length]!)!(input);
    deltas.push(Math.max(0, performance.now() - eventStart - baseline));
    if (i % 32 === 31) await spool.flush();
  }
  await spool.close();
  const p95 = deltas.sort((a, b) => a - b)[Math.floor(deltas.length * 0.95)]!;
  console.log(`Event observer additional latency: p95=${p95.toFixed(4)} ms, samples=${deltas.length}`);
  assert.ok(p95 < 5);
  assert.equal((await events(dir)).length, 1000);
  assert.deepEqual(warnings, []);
});
