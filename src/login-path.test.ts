import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLoginPathResolver, mergePaths } from "./login-path.js";
import { runShellTool } from "./pi-tools.js";

test("PATH merge preserves order and removes duplicates", () => {
  assert.equal(mergePaths("/user/bin:/usr/bin", "/usr/bin:/bin"), "/user/bin:/usr/bin:/bin");
});

test("login PATH is captured once despite profile chatter and injected into Bash", {
  skip: process.platform === "win32",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-login-path-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  const shell = join(root, "login-shell");
  const counter = join(root, "calls");
  await mkdir(bin);
  await writeFile(join(bin, "user-tool"), "#!/bin/sh\nprintf user-tool-ok\n", { mode: 0o755 });
  await writeFile(shell, `#!/bin/sh\nprintf x >> '${counter}'\nprintf 'profile chatter\\n'\nexport PATH='${bin}:/usr/bin:/bin'\neval "$2"\n`, { mode: 0o755 });
  const resolve = createLoginPathResolver({ shell, env: { ...process.env, PATH: "/bin" } });
  assert.equal(resolve(), `${bin}:/usr/bin:/bin`);
  assert.equal(resolve(), `${bin}:/usr/bin:/bin`);
  assert.equal(await readFile(counter, "utf8"), "x");

  const oldShell = process.env.SHELL;
  const oldPath = process.env.PATH;
  process.env.SHELL = shell;
  process.env.PATH = "/usr/bin:/bin";
  try {
    const input = { command: 'command -v user-tool; user-tool; values=(bash syntax); printf "\\n%s\\n" "${values[0]}" "$BASH_VERSION" "$PATH"' };
    const first = await runShellTool(input, { cwd: root });
    const second = await runShellTool(input, { cwd: root });
    assert.ok(!first.isError && !second.isError);
    const text = first.content.map((block) => block.type === "text" ? block.text : "").join("");
    assert.match(text, /user-tool-ok\nbash\n+\d+\./);
    assert.ok(text.includes(bin));
    assert.equal(await readFile(counter, "utf8"), "xx");
  } finally {
    if (oldShell === undefined) delete process.env.SHELL; else process.env.SHELL = oldShell;
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
  }
});

test("missing shell, failed profile, malformed output and timeout retain service PATH", {
  skip: process.platform === "win32",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-login-fallback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env, PATH: "/service/bin:/bin" };
  assert.equal(createLoginPathResolver({ shell: join(root, "missing"), env })(), env.PATH);
  for (const [name, body] of [
    ["failure", "exit 1"],
    ["malformed", "printf invalid"],
    ["timeout", "exec /bin/sleep 10"],
  ]) {
    const shell = join(root, name!);
    await writeFile(shell, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    const start = Date.now();
    const resolve = createLoginPathResolver({ shell, env, timeout: 100 });
    assert.equal(resolve(), env.PATH);
    assert.equal(resolve(), env.PATH);
    assert.ok(Date.now() - start < 2000);
  }
});
