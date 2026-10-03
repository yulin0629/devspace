import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs, { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { discoverInstructionPaths } from "./instruction-discovery.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "devspace-discovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function instruction(root: string, directory: string) {
  await mkdir(join(root, directory), { recursive: true });
  await writeFile(join(root, directory, "AGENTS.md"), "instructions");
}

test("nested discovery skips hidden, dependency, build and cache directories", async (t) => {
  const root = await fixture(t);
  for (const dir of ["src", ".hermes", ".codex-other", ".worktrees", ".Trash", "node_modules", "dist", "plugins/cache", "Library/Caches"]) {
    await instruction(root, dir);
  }
  assert.deepEqual((await discoverInstructionPaths(root)).paths, [join(root, "src/AGENTS.md")]);
  assert.deepEqual((await discoverInstructionPaths(join(root, ".hermes"))).paths, [join(root, ".hermes/AGENTS.md")]);
});

test("Git discovery respects nested ignores, keeps tracked files, and works from a subdirectory or parent", async (t) => {
  const parent = await fixture(t);
  const root = join(parent, "repo");
  await mkdir(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  await writeFile(join(root, ".gitignore"), "results/\nignored.md\n");
  await instruction(root, "results");
  await instruction(root, "src");
  await instruction(root, "src/ignored");
  await instruction(root, "src/keep");
  await writeFile(join(root, "src/.gitignore"), "ignored/\n");
  await instruction(root, "tracked");
  execFileSync("git", ["add", "tracked"], { cwd: root });
  const expected = [join(root, "src/AGENTS.md"), join(root, "src/keep/AGENTS.md"), join(root, "tracked/AGENTS.md")];
  assert.deepEqual((await discoverInstructionPaths(root)).paths, expected);
  assert.deepEqual((await discoverInstructionPaths(parent)).paths, expected);
  assert.deepEqual((await discoverInstructionPaths(join(root, "src"))).paths, expected.slice(0, 2));
});

test("discovery reports depth limits and does not follow directory symlinks", async (t) => {
  const root = await fixture(t);
  await instruction(root, "a/b/c/d/e/f/g/h/i");
  await instruction(root, "visible");
  if (process.platform !== "win32") await symlink(join(root, "visible"), join(root, "link"));
  const result = await discoverInstructionPaths(root);
  assert.equal(result.limited, true);
  assert.deepEqual(result.paths, [join(root, "visible/AGENTS.md")]);
});

test("Git discovery includes initialized submodules while respecting their ignores and skipped paths", async (t) => {
  const parent = await fixture(t);
  const source = join(parent, "source");
  const root = join(parent, "repo");
  await mkdir(source);
  await mkdir(root);
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });
  git(source, "init", "-q");
  await instruction(source, "src");
  await instruction(source, "cache");
  await writeFile(join(source, ".gitignore"), "ignored/\n");
  git(source, "add", ".");
  git(source, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  git(root, "init", "-q");
  for (const name of ["module", ".hidden-module", "cache/module", "uninitialized"]) {
    git(root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", source, name);
  }
  git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qam", "fixture");
  git(root, "submodule", "deinit", "-f", "uninitialized");
  await instruction(root, "module/ignored");
  await instruction(root, "module/untracked");
  assert.deepEqual((await discoverInstructionPaths(root)).paths, [join(root, "module/src/AGENTS.md"), join(root, "module/untracked/AGENTS.md")]);
  assert.deepEqual((await discoverInstructionPaths(join(root, "module"))).paths, [join(root, "module/src/AGENTS.md"), join(root, "module/untracked/AGENTS.md")]);
});

test("directory budget keeps shallow instructions visible before a large subtree", async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, "a-large"));
  await instruction(root, "z-project");
  await Promise.all(Array.from({ length: 2001 }, (_, index) => mkdir(join(root, "a-large", `dir-${index}`))));
  const result = await discoverInstructionPaths(root);
  assert.equal(result.limited, true);
  assert.deepEqual(result.paths, [join(root, "z-project/AGENTS.md")]);
});

test("a stray .git directory does not suppress non-Git workspace discovery", async (t) => {
  const root = await fixture(t);
  await mkdir(join(root, ".git"));
  await instruction(root, "src");
  assert.deepEqual(await discoverInstructionPaths(root), {
    paths: [join(root, "src/AGENTS.md")], limited: false,
  });
});


test("macOS Home discovery skips privacy-protected children without filtering explicit projects", async (t) => {
  const root = await fixture(t);
  for (const dir of ["Desktop", "Documents", "Downloads", "Library", "Movies", "Music", "Pictures", "github/project"]) {
    await instruction(root, dir);
  }
  const environment = { platform: "darwin" as const, homeDir: root };
  assert.deepEqual((await discoverInstructionPaths(root, environment)).paths, [join(root, "github/project/AGENTS.md")]);
  assert.deepEqual((await discoverInstructionPaths(join(root, "Desktop"), environment)).paths, [join(root, "Desktop/AGENTS.md")]);
  assert.deepEqual((await discoverInstructionPaths(root, { ...environment, homeDir: join(root, "another-home") })).paths.length, 8);
  assert.deepEqual((await discoverInstructionPaths(root, { ...environment, platform: "linux" })).paths.length, 8);
});

test("Git discovery in macOS Home uses the same privacy boundary", async (t) => {
  const root = await fixture(t);
  execFileSync("git", ["init", "-q"], { cwd: root });
  await instruction(root, "Desktop");
  await instruction(root, "github/project");
  assert.deepEqual((await discoverInstructionPaths(root, { platform: "darwin", homeDir: root })).paths, [join(root, "github/project/AGENTS.md")]);
});


test("macOS Home discovery skips other filesystems but explicit mounts and ordinary projects remain visible", async (t) => {
  const root = await fixture(t);
  await instruction(root, "mounted/project");
  await instruction(root, "github/project");
  const realStat = fs.stat;
  const realLstat = fs.lstat;
  const mounted = join(root, "mounted");
  const differentDevice = (path: Parameters<typeof fs.lstat>[0], stats: Awaited<ReturnType<typeof realLstat>>) => {
    if (String(path) === mounted || String(path).startsWith(mounted + "/")) {
      return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, { dev: Number(stats.dev) + 1 });
    }
    return stats;
  };
  t.mock.method(fs, "stat", async (path: Parameters<typeof fs.stat>[0]) => differentDevice(path, await realStat(path)));
  t.mock.method(fs, "lstat", async (path: Parameters<typeof fs.lstat>[0]) => differentDevice(path, await realLstat(path)));
  const environment = { platform: "darwin" as const, homeDir: root };
  assert.deepEqual((await discoverInstructionPaths(root, environment)).paths, [join(root, "github/project/AGENTS.md")]);
  assert.deepEqual((await discoverInstructionPaths(mounted, environment)).paths, [join(mounted, "project/AGENTS.md")]);
  assert.equal((await discoverInstructionPaths(root, { ...environment, platform: "linux" })).paths.length, 2);
});

test("Git discovery in macOS Home also excludes files on other filesystems", async (t) => {
  const root = await fixture(t);
  execFileSync("git", ["init", "-q"], { cwd: root });
  await instruction(root, "mounted");
  await instruction(root, "github/project");
  const realLstat = fs.lstat;
  t.mock.method(fs, "lstat", async (path: Parameters<typeof fs.lstat>[0]) => {
    const stats = await realLstat(path);
    return String(path).includes("/mounted/")
      ? Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, { dev: Number(stats.dev) + 1 }) : stats;
  });
  assert.deepEqual((await discoverInstructionPaths(root, { platform: "darwin", homeDir: root })).paths, [join(root, "github/project/AGENTS.md")]);
});
