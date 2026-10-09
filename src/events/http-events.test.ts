import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "../config.js";
import { createServer } from "../server.js";
import { writeTestDevspaceConfig } from "../test-support/config.test.js";
import { EventSpool } from "./spool.js";

const execFileAsync = promisify(execFile);
for (const enabled of [true, false]) test(`HTTP MCP events.enabled=${enabled} preserves tool behavior and checkout conversation reuse`, { skip: enabled && process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-http-events-"));
  await execFileAsync("git", ["init", root]);
  await writeFile(join(root, "file.ts"), "export const example = 1;\n");
  await execFileAsync("git", ["-C", root, "add", "file.ts"]);
  await execFileAsync("git", ["-C", root, "-c", "core.hooksPath=/dev/null", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture"]);
  const token = "test-static-bearer-token-long-enough";
  const env = writeTestDevspaceConfig(join(root, "config"), {
    server: { publicBaseUrl: "https://example.test" }, events: { enabled },
    storage: { stateDir: join(root, "state") }, workspaces: { allowedRoots: [root] },
    tools: { mode: "claude" }, ui: { enabled: false }, skills: { enabled: false }, logging: { level: "silent" },
  });
  const config = loadConfig({ ...env, DEVSPACE_STATIC_BEARER_TOKEN: token });
  const spool = new EventSpool({ enabled, dir: join(root, "spool") });
  const running = createServer(config, { eventSpool: spool, incomingArtifactAdapters: [] });
  const listener = running.app.listen(0, "127.0.0.1");
  const client = new Client({ name: "http-events-test", version: "1.0.0" });
  t.after(async () => {
    await client.close(); await running.close(); listener.closeAllConnections();
    await new Promise<void>((done) => listener.close(() => done()));
    await rm(root, { recursive: true, force: true });
  });
  await once(listener, "listening");
  const address = listener.address(); assert.ok(address && typeof address !== "string");
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  }));
  const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args, _meta: { "openai/session": "conversation-fixture" } });
  const opened = await call("open_workspace", { path: root, mode: "checkout" });
  const workspace_id = (opened.structuredContent as Record<string, unknown>).workspace_id as string;
  const reopened = await call("open_workspace", { path: root, mode: "checkout" });
  assert.equal((reopened.structuredContent as Record<string, unknown>).workspace_id, workspace_id);
  for (const [name, args] of [
    ["read", { workspace_id, path: "file.ts", offset: 1, limit: 1 }],
    ["write", { workspace_id, path: "file.ts", content: "export const example = 2;\n" }],
    ["edit", { workspace_id, path: "file.ts", edits: [{ old_text: "= 2", new_text: "= 3" }] }],
    ["bash", { workspace_id, command: "printf 'PASS\\n'" }],
    ["show_changes", { workspace_id }],
  ] as const) assert.ok(!(await call(name, args)).isError);
  await spool.flush();
  if (enabled) {
    const chunks = await Promise.all((await readdir(spool.dir)).map((name) => readFile(join(spool.dir, name), "utf8")));
    const events = chunks.join("").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(events.map((event) => event.tool), ["open_workspace", "open_workspace", "read", "write", "edit", "bash", "show_changes"]);
    assert.equal(new Set(events.map((event) => event.event_id)).size, 7);
    assert.ok(events.every((event) => event.workspace_id === workspace_id));
    assert.ok(!JSON.stringify(events).includes("conversation-fixture"));
    assert.ok(!JSON.stringify(events).includes("export const example"));
  } else await assert.rejects(stat(spool.dir), { code: "ENOENT" });
});
