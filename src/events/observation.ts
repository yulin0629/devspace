import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { resolve } from "node:path";
import type { McpRegistrationTarget } from "../mcp-modern-server.js";
import type { ServerConfig } from "../config.js";
import type { WorkspaceRegistry } from "../workspaces.js";
import { commandSummary, redact, statusOutput } from "./privacy.js";
import { EventSpool, type ToolEvent } from "./spool.js";

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" ? value as Record<string, any> : {};
}

function text(result: Record<string, any>): string {
  if (typeof result.structuredContent?.result === "string") return result.structuredContent.result;
  return Array.isArray(result.content) ? result.content.filter((item: any) => item.type === "text").map((item: any) => item.text).join("\n") : "";
}

export function toolEvent(tool: string, inputValue: unknown, resultValue: unknown, failed: boolean,
  durationMs: number, occurredAt: string, config: ServerConfig, workspaces: WorkspaceRegistry): ToolEvent {
  const input = record(inputValue);
  const result = record(resultValue);
  const workspaceId = String(result.structuredContent?.workspace_id ?? input.workspace_id ?? "none");
  const context = workspaces.eventContext(workspaceId);
  const cwd = context?.cwd ?? process.cwd();
  const details: Record<string, string | number> = {};
  const path = typeof input.path === "string" ? redact(input.path) : undefined;
  switch (tool) {
    case "open_workspace":
      if (path) details.path = path;
      details.mode = String(result.structuredContent?.mode ?? input.mode ?? "checkout");
      if (typeof input.base_ref === "string") details.base_ref = redact(input.base_ref, 256);
      details.workspace_id = workspaceId;
      break;
    case "read":
      if (path) details.path = path;
      if (typeof input.offset === "number") details.offset = input.offset;
      if (typeof input.limit === "number") details.limit = input.limit;
      details.read_bytes = Buffer.byteLength(text(result));
      break;
    case "show_changes": {
      const summary = result._meta?.card?.summary;
      for (const key of ["files", "additions", "removals"]) if (typeof summary?.[key] === "number") details[key] = summary[key];
      break;
    }
    case "write":
      if (path) details.path = path;
      if (typeof input.content === "string") {
        details.content_bytes = Buffer.byteLength(input.content);
        let lines = 0;
        for (let at = 0; at < input.content.length;) {
          lines++;
          const newline = input.content.indexOf("\n", at);
          if (newline === -1) break;
          at = newline + 1;
        }
        details.lines = lines;
      }
      break;
    case "edit": {
      if (path) details.path = path;
      const edits = Array.isArray(input.edits) ? input.edits : [];
      details.edit_count = edits.length;
      details.old_bytes = edits.reduce((sum: number, edit: any) => sum + Buffer.byteLength(String(edit.old_text ?? "")), 0);
      details.new_bytes = edits.reduce((sum: number, edit: any) => sum + Buffer.byteLength(String(edit.new_text ?? "")), 0);
      break;
    }
    case "bash":
      details.command_summary = commandSummary(String(input.command ?? ""));
      details.working_directory = redact(resolve(cwd, typeof input.working_directory === "string" ? input.working_directory : "."));
      if (typeof result.details?.exitCode === "number") details.exit_code = result.details.exitCode;
      details.output = statusOutput(text(result));
      break;
  }
  return {
    schema_version: 1, event_id: randomUUID(), event_type: "tool.completed", occurred_at: occurredAt,
    machine_id: redact(config.machine?.name ?? hostname(), 128), workspace_id: redact(workspaceId, 128),
    project: redact(context?.project ?? "unknown", 256), cwd: redact(cwd), tool,
    outcome: { status: failed || result.isError ? "failure" : "success", duration_ms: durationMs },
    ...(Object.keys(details).length ? { details } : {}),
  };
}

export function withEventObservation(server: McpRegistrationTarget, config: ServerConfig,
  workspaces: WorkspaceRegistry, spool: EventSpool): McpRegistrationTarget {
  if (!config.events?.enabled) return server;
  return {
    registerTool: ((...args: unknown[]) => {
      const tool = args[0] as string;
      const handler = args.at(-1) as (...handlerArgs: unknown[]) => unknown;
      return (server.registerTool as (...callArgs: unknown[]) => unknown)(...args.slice(0, -1), async (...handlerArgs: unknown[]) => {
        const started = performance.now();
        const emit = (result: unknown, failed: boolean) => {
          const duration = performance.now() - started;
          const occurredAt = new Date().toISOString();
          try {
            const event = toolEvent(tool, handlerArgs[0], result, failed, duration, occurredAt, config, workspaces);
            spool.enqueue(() => event);
          }
          catch { console.warn("[devspace.events] enqueue_failed_event_dropped"); }
        };
        try { const result = await handler(...handlerArgs); emit(result, false); return result; }
        catch (error) { emit(undefined, true); throw error; }
      });
    }) as McpRegistrationTarget["registerTool"],
    registerResource: server.registerResource.bind(server),
  };
}
