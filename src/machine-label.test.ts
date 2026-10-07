import assert from "node:assert/strict";
import test from "node:test";
import { machineInstruction, withMachineLabel } from "./server.js";
import type { McpRegistrationTarget } from "./mcp-modern-server.js";

test("machine instruction is empty without a configured machine", () => {
  assert.equal(machineInstruction({}), "");
});

test("machine instruction names the machine and when to use it", () => {
  const text = machineInstruction({ machine: { name: "Oracle", description: "always-on cloud VM" } });
  assert.match(text, /^DevSpace on Oracle \(always-on cloud VM\)\./);
  assert.match(text, /mentions Oracle/);
});

test("machine label prefixes tool descriptions only when configured", () => {
  const seen: Array<Record<string, unknown>> = [];
  const target = {
    registerTool: (_name: string, definition: Record<string, unknown>) => { seen.push(definition); },
    registerResource: () => undefined,
  } as unknown as McpRegistrationTarget;

  const labeled = withMachineLabel(target, { machine: { name: "MBP" } });
  (labeled.registerTool as (...args: unknown[]) => unknown)("bash", { description: "Run a shell command." }, () => undefined);
  assert.equal(seen[0]?.description, "On MBP: Run a shell command.");

  assert.equal(withMachineLabel(target, {}), target);
});
