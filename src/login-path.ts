import { spawnSync } from "node:child_process";
import { delimiter } from "node:path";
import { userInfo } from "node:os";

export function mergePaths(...paths: Array<string | undefined>): string {
  return [...new Set(paths.flatMap((path) => path ? path.split(delimiter) : []))].join(delimiter);
}

// Each process probes once; only PATH is imported, never profile output or other variables.
export function createLoginPathResolver(options: {
  env?: NodeJS.ProcessEnv;
  shell?: string;
  timeout?: number;
} = {}): () => string {
  let cached: string | undefined;
  return () => {
    if (cached !== undefined) return cached;
    const env = options.env ?? process.env;
    cached = env.PATH ?? "";
    if (process.platform === "win32") return cached;
    try {
      const shell = options.shell ?? env.SHELL ?? userInfo().shell ?? "/bin/bash";
      const result = spawnSync(shell, ["-lc", 'printf "\\0DEVSPACE_PATH\\0%s\\0" "$PATH"'], {
        env,
        encoding: "utf8",
        timeout: options.timeout ?? 2000,
        killSignal: "SIGKILL",
        maxBuffer: 64 * 1024,
      });
      const path = result.stdout?.split("\0DEVSPACE_PATH\0")[1]?.split("\0")[0];
      if (!result.error && result.status === 0 && path && !/[\r\n]/.test(path)) {
        cached = mergePaths(path, env.PATH);
      }
    } catch {
      // Missing shell, profile errors, and timeouts retain the service environment.
    }
    return cached;
  };
}

export const resolveLoginPath = createLoginPathResolver();
