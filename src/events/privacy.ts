import { createHash } from "node:crypto";

export function redact(value: string, limit = 2048): string {
  return value
    .replace(/data:[^,\s]+;base64,[A-Za-z0-9+/_=-]+/gi, "[attachment omitted]")
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, "[redacted]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.=~-]+/gi, "[redacted]")
    .replace(/((?:password|passwd|secret|token|api[-_]?key|authorization|credential)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi, "$1[redacted]")
    .replace(/\b(?:sk-|gh[pousr]_|github_pat_|AKIA|ASIA)[A-Za-z0-9_/-]+/g, "[redacted]")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
    .slice(0, limit);
}

export function sessionIdentity(value: string): string {
  return redact(value, 128) === value ? value : `redacted-${createHash("sha256").update(value).digest("hex")}`;
}

export function commandSummary(command: string): string {
  const known = /^(git|npm|pnpm|node|python3?|rg|ls|pwd|cat|head|tail|sed|awk|find|mkdir|cp|mv|rm|curl|wget|ssh|make|cargo|go|printf|echo|true|false)$/;
  return command.split(/\r?\n|&&|\|\||[;|]/).slice(0, 8).map((part) => {
    const words = part.trim().split(/\s+/);
    const executable = words[0]?.split("/").at(-1);
    if (!known.test(executable ?? "")) return "[command]";
    const subcommand = ["git", "npm", "pnpm", "cargo", "go"].includes(executable ?? "")
      && /^(status|diff|show|log|add|commit|test|run|build|install|check|fetch|pull|push)$/.test(words[1] ?? "")
      ? ` ${words[1]}` : "";
    return executable + subcommand;
  }).join("; ").slice(0, 256);
}

export function statusOutput(output: string): string {
  return output.slice(0, 8192).split(/\r?\n/)
    .filter((line) => /^(?:\s*(?:PASS|FAIL|ok|not ok|Done|done|success|failed)\s*$|\s*(?:Tests|Test Files|# tests|# pass|# fail)\s*[: ]\s*[\d\s|()]+(?:passed|failed|skipped)?[\d\s|()]*)$/i.test(line))
    .join("\n").slice(0, 1024) || "[output omitted]";
}
