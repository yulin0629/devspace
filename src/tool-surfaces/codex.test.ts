import assert from "node:assert/strict";
import test from "node:test";
import { processLogFields } from "./codex.js";

test("process logging keeps a running command successful", () => {
  assert.deepEqual(
    processLogFields({
      sessionId: 7,
      output: "",
      running: true,
      wallTimeSeconds: 10,
    }),
    { sessionId: 7, running: true, exitCode: undefined, success: true },
  );
});

test("process logging marks a zero exit code successful", () => {
  assert.deepEqual(
    processLogFields({
      output: "done",
      running: false,
      exitCode: 0,
      wallTimeSeconds: 20,
    }),
    { sessionId: undefined, running: false, exitCode: 0, success: true },
  );
});

test("process logging marks a non-zero exit code failed", () => {
  assert.deepEqual(
    processLogFields({
      output: "failed",
      running: false,
      exitCode: 1,
      wallTimeSeconds: 30,
    }),
    {
      sessionId: undefined,
      running: false,
      exitCode: 1,
      success: false,
      error: "Process exited with code 1.",
    },
  );
});
