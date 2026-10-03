import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const NAMES = new Set(["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);
const SKIPPED = new Set(["node_modules", "dist", "build", "cache", "caches"]);
// Automatic Home discovery must not prompt a background service for macOS privacy access.
const MAC_HOME_SKIPPED = new Set(["desktop", "documents", "downloads", "library", "movies", "music", "pictures"]);
const MAX_DEPTH = 8;
const MAX_DIRECTORIES = 2000;

function skipDirectory(name: string): boolean {
  // Explicitly opening a hidden directory still works; only nested discovery skips it.
  return name.startsWith(".") || SKIPPED.has(name.toLowerCase());
}

export async function discoverInstructionPaths(
  root: string,
  environment: { platform?: NodeJS.Platform; homeDir?: string } = {},
): Promise<{
  paths: string[];
  limited: boolean;
}> {
  const macHome = (environment.platform ?? process.platform) === "darwin"
    && resolve(root) === resolve(environment.homeDir ?? homedir());
  const homeDevice = macHome ? (await fs.stat(root).catch(() => undefined))?.dev : undefined;
  const skipChild = (name: string, depth: number) => skipDirectory(name)
    || (macHome && depth === 0 && MAC_HOME_SKIPPED.has(name.toLowerCase()));
  const paths = new Set<string>();
  let limited = false;
  let directories = 0;

  async function scanGit(directory: string): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync("git", [
        "ls-files", "--cached", "--others", "--exclude-standard", "--deduplicate", "-z",
      ], { cwd: directory, env: { ...process.env, LC_ALL: "C" }, timeout: 5000, maxBuffer: 16 * 1024 * 1024 });
      for (const file of stdout.split("\0")) {
        if (!NAMES.has(basename(file))) continue;
        const path = join(directory, file);
        const parts = relative(root, path).split(sep);
        if (parts.slice(0, -1).some((part, depth) => skipChild(part, depth))) continue;
        if (parts.length - 1 > MAX_DEPTH) { limited = true; continue; }
        const stats = await fs.lstat(path).catch(() => undefined);
        if (stats?.isFile() && (homeDevice === undefined || stats.dev === homeDevice)) paths.add(path);
      }
    } catch (error) {
      // A stray .git directory is not a repository and must not hide its parent.
      if (error instanceof Error && "stderr" in error
        && /not a git repository/i.test(String(error.stderr))) return false;
      // Do not fall back to an unfiltered walk when Git cannot apply its ignore rules.
      limited = true;
    }
    return true;
  }

  async function walk(): Promise<void> {
    const pending = [{ directory: root, depth: 0 }];
    for (let index = 0; index < pending.length; index++) {
      if (++directories > MAX_DIRECTORIES) { limited = true; break; }
      const { directory, depth } = pending[index]!;
      // Home catalogs stay on their filesystem; opening a mount explicitly still scans it.
      if (homeDevice !== undefined && directory !== root
        && (await fs.lstat(directory).catch(() => undefined))?.dev !== homeDevice) continue;
      const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => undefined);
      if (!entries) continue;
      if (entries.some((entry) => entry.name === ".git") && await scanGit(directory)) {
        continue;
      }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const path = join(directory, entry.name);
        if (entry.isDirectory() && !skipChild(entry.name, depth)) {
          if (depth >= MAX_DEPTH || directories >= MAX_DIRECTORIES) { limited = true; continue; }
          if (pending.length < 10000) pending.push({ directory: path, depth: depth + 1 });
          else limited = true;
        } else if (entry.isFile() && NAMES.has(entry.name)) {
          paths.add(path);
        }
      }
    }
  }

  const insideGit = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: root, timeout: 2000,
  }).then(({ stdout }) => stdout.trim() === "true", () => false);
  if (insideGit) await scanGit(root);
  else await walk();
  return { paths: [...paths].sort((a, b) => a.localeCompare(b)), limited };
}
