# Configuration Reference

DevSpace stores durable settings in `~/.devspace/config.jsonc`. The file accepts
comments and trailing commas and is validated before the server starts. Editor
completion is provided by the versioned [JSON Schema](../schema/v1/devspace.schema.json),
also hosted at the URL in the file's `$schema` property.

Authentication stays separate because it contains a secret:

```text
~/.devspace/config.jsonc
~/.devspace/auth.json
```

Run `devspace init` to create both files. `devspace config set publicBaseUrl
<url|null>` updates the JSONC document without discarding its comments.

## Complete example

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/Waishnav/devspace/main/schema/v1/devspace.schema.json",
  "configVersion": 1,

  "server": {
    "host": "127.0.0.1",
    "port": 7676,
    // Use the public origin only; do not append /mcp.
    "publicBaseUrl": "https://devspace.example.com",
    "allowedHosts": [],
    "trustProxy": false,
  },
  "workspaces": {
    "allowedRoots": ["~/personal", "~/work"],
    "worktreeRoot": "~/.devspace/worktrees",
  },
  "storage": {
    "stateDir": "~/.local/share/devspace",
  },
  "events": {
    "enabled": false,
  },
  "tools": {
    "mode": "codex",
  },
  "ui": {
    "enabled": true,
  },
  "artifacts": {
    "enabled": false,
    "maxFileBytes": 104857600,
  },
  "skills": {
    "enabled": true,
    "paths": [],
    "agentDir": "~/.codex",
  },
  "subagents": {
    "enabled": false,
    "instructions": "on-demand",
    "providers": [],
  },
  "logging": {
    "level": "info",
    "format": "json",
    "requests": true,
    "assets": false,
    "toolCalls": true,
    "shellCommands": false,
  },
  "oauth": {
    "accessTokenTtlSeconds": 3600,
    "refreshTokenTtlSeconds": 2592000,
    "scopes": ["devspace"],
    "allowedResourceUrls": [],
    "allowedRedirectHosts": ["chatgpt.com", "localhost", "127.0.0.1"],
  },
}
```

Omitted sections and keys use the defaults shown above. An empty
`workspaces.allowedRoots` uses the current working directory. Unknown keys are
rejected so spelling mistakes cannot silently alter behavior.

### Tool completion events

`events.enabled` defaults to `false`; disabled observation creates no event
directory or files. After the Agent Memory server supports UUID deduplication
and its deployment is authorized and verified, set `events.enabled: true` and
restart DevSpace. Events are independent of request/tool logging and remain off
until explicitly enabled. The producer never starts a forwarder or manages
authentication/tunnels.

Events use `~/.local/share/devspace/events/`, a single asynchronous FIFO writer,
on macOS and Linux in this first version,
private `0700` directories and `0600` files. A record is at most 16 KiB including
its newline, and segments rotate at 16 MiB. Retention removes oldest segments
after seven days or at 1 GiB, whichever limit applies first. The writer warns
once per crossing of 80% of a retention limit and again before deleting retained
segments. An active writer also checks idle segments once per minute through
the same FIFO, so expiration does not depend on another tool completion. An
event with oversized details drops those details; a still-oversized envelope
is dropped with a warning. Write failures and queue overflow warn without
changing MCP results. Failure warnings include a sanitized filesystem error
code; paths and exception messages are excluded. The in-memory queue holds
at most 1,024 pending events;
unflushed events can be lost when the process crashes.

Each completion has `schema_version`, UUID `event_id`, `event_type`,
`occurred_at`, `machine_id`, `workspace_id`, `project`, `cwd`, `tool` and
`outcome` (status and elapsed milliseconds). Machine identity uses `tools.machine.name`
when configured, otherwise the local hostname. Workspace/project/cwd come from
the existing workspace registry; request metadata is not stored or treated as
a global conversation identifier. Machine/workspace identities that require
redaction or truncation use deterministic SHA-256 pseudonyms to prevent distinct
identities from merging; ordinary identifiers retain their original values.

The initial detailed whitelist covers `open_workspace` (path, mode, base ref,
workspace ID), `read` (path, offset, limit, returned text bytes), `show_changes`
(file/addition/removal counts), `write` (path, content bytes, lines), `edit`
(path, edit count, old/new bytes) and `bash` (filtered command summary, working
directory, available exit code and bounded status output). Bash nonzero-exit
codes come from the pinned Pi adapter's terminal status line when present;
process exit codes/signals also determine generic command outcomes. Other tools
retain only the envelope/outcome. In Codex mode, `apply_patch`, `exec_command` and
`write_stdin` therefore record generic completion events.

The paired forwarder and deployment sequence are documented in
[Agent Memory's DevSpace integration](https://github.com/yulin0629/agentmemory/tree/feat/devspace-event-observation/integrations/devspace-forwarder).

`oauth.allowedResourceUrls` accepts exact alternate MCP resource URLs for
clients that connect through a resource alias, such as a secure MCP tunnel.
The normal `server.publicBaseUrl` `/mcp` resource remains allowed automatically.
Configure the complete alias URL, not a hostname or origin; aliases do not
change OAuth discovery URLs or proxy routing.
Resource URLs must use HTTPS; HTTP is allowed only for `localhost`, `127.0.0.1`,
or `[::1]`, with optional ports. Restart DevSpace after changing
`oauth.allowedResourceUrls`: the provider reads this policy at server creation.
After restarting, refresh tokens for removed aliases can no longer mint tokens.

### Optional static bearer token

This fork can also accept one fixed bearer token on `/mcp` for clients that cannot use the OAuth flow. Keep it in `~/.devspace/auth.json`, alongside the owner token:

```json
{
  "ownerToken": "...",
  "staticBearerToken": "..."
}
```

`DEVSPACE_STATIC_BEARER_TOKEN` overrides the stored value for deployments that inject secrets at process start. The static token grants the same MCP scope as an approved DevSpace OAuth token; use a long random secret and treat it as equivalent to remote DevSpace access. OAuth remains enabled and unchanged for every other bearer token.

## Tool modes and UI

`tools.mode` accepts two values:

| Value | Tool surface |
| --- | --- |
| `codex` | Default. `open_workspace`, `read`, `apply_patch`, `exec_command`, `write_stdin`, and `show_changes`. |
| `claude` | `open_workspace`, `read`, `write`, `edit`, `bash`, and `show_changes`. |

The dedicated MCP tools `grep`, `glob`, and `ls` are not exposed. Each mode uses
its shell tool with programs such as `rg`, `find`, and `ls` when it needs those
operations.

DevSpace attaches Apps UI metadata only to `open_workspace` and `show_changes`.
This avoids rendering an iframe for every read, edit, search, or command call.
Setting `ui.enabled` to `false` removes the metadata but does not remove the
`show_changes` tool.

### Machine label

When one host connects to several DevSpace servers, every server otherwise
advertises the same instructions and tool descriptions. Hosts that defer tool
schemas behind a tool search see only names and server instructions, so they
cannot tell the machines apart. Set `tools.machine` to name each one:

```jsonc
"tools": {
  "mode": "claude",
  "machine": { "name": "Oracle", "description": "always-on cloud VM" }
}
```

The server instructions then begin with the machine name, description, and when
to use it, and every tool description is prefixed with `On <name>:`. Keep the
description to one line; it is sent on every connection.

## Skills and subagents

DevSpace discovers standard Agent Skills from `~/.agents/skills`, project
`.agents/skills`, and `~/.devspace/skills`. It also checks
`skills.agentDir/skills` and each path in `skills.paths`. Relative custom paths
are resolved from the active workspace.

By default, discovered skills keep their filesystem paths for compatibility
with existing MCP hosts. Set `DEVSPACE_EXPERIMENTAL_SKILL_URIS=1` to expose
logical `skills://<name>` URIs instead. The bare URI loads the skill entry
file; bundled resources use `skills://<name>/<relative-path>`.
As an experimental compatibility workaround, standalone skill URI arguments in
the shell tools are resolved to their local files immediately before execution.

Skill URIs are experimental and may be removed in favor of the MCP Skills
extension as host support matures.

When Subagents are enabled for MCP workspaces, DevSpace keeps its bundled
`subagents` skill synchronized at `~/.devspace/skills/subagents/SKILL.md`.
That managed copy is the authoritative `subagents` skill for DevSpace and is
refreshed when the packaged skill changes.

Subagent providers are explicit. Omitted providers are disabled:

```jsonc
{
  "configVersion": 1,
  "subagents": {
    "enabled": true,
    "instructions": "on-demand",
    "providers": [
      {
        "id": "codex",
        "enabled": true,
        "model": "gpt-5.4",
        "effort": "high",
        "command": "/opt/devspace/bin/codex-wrapper",
        "env": {
          "CODEX_HOME": "/home/alice/.codex-work",
          "OPENAI_BASE_URL": "https://api.example.com/v1",
        },
      },
      {
        "id": "claude",
        "enabled": true,
        "model": "sonnet",
      },
    ],
  },
}
```

`subagents.instructions` controls when ChatGPT receives the managed workflow:

| Value | Behavior |
| --- | --- |
| `on-demand` | Default. `open_workspace` advertises the `subagents` skill and the model reads it only when the task benefits from delegation. |
| `preload` | `open_workspace` includes the `subagents` workflow in its initial workspace instructions instead of advertising that skill for a separate read. |

Both modes only make the workflow available; neither tells the model to prefer
subagents for routine work.

Profiles are loaded from `~/.devspace/agents/*.md` and project
`.devspace/agents/*.md`. `devspace agents targets` prints the configured targets
available in the current workspace.

`command` names one executable. DevSpace does not split shell arguments, so use
a wrapper executable when startup needs fixed arguments. `env` maps environment
variable names to literal string values and preserves empty strings. DevSpace
does not expand `$NAME` references in these values.

All subagent providers accept `env`. The daemon inherits its startup
environment, then overlays the provider's `env` without mutating the daemon's
process environment. OpenCode receives that environment on its managed server
process; embedded Pi scopes it to its provider requests and command execution.

Codex, Claude, Cursor, Copilot, and Grok also accept `command`. OpenCode and Pi
do not expose a command override. For providers that support it, an explicit
`command` wins over both the inherited command override and a command override
placed in `env`.

Existing process-level overrides remain supported: `CODEX_COMMAND`,
`CODEX_HOME`, `CLAUDE_COMMAND`, `CURSOR_COMMAND`, `COPILOT_COMMAND`,
`GROK_COMMAND`, and `GROK_AGENT_PROFILE`. Provider configuration takes
precedence where the same value is set in both places.

DevSpace writes `config.jsonc` with mode `0600`, but provider environment values
are still plain text on disk. Keep the file out of version control. Leave
credentials in the process environment if you do not want DevSpace to persist
them.

## Native artifact download

Set `artifacts.enabled` to `true` when a host needs to save a native attached or
generated file into an open workspace. `artifacts.maxFileBytes` limits one
streamed file. The secure publication path is available on Linux, macOS, and
Windows; the tool is not registered on BSD.

## Environment boundary

Only three user-facing DevSpace environment variables remain in this fork:

| Variable | Purpose |
| --- | --- |
| `DEVSPACE_CONFIG_DIR` | Bootstrap location for `config.jsonc`, `auth.json`, skills, and profiles. |
| `DEVSPACE_OAUTH_OWNER_TOKEN` | Optional secret override for the owner token stored in `auth.json`. |
| `DEVSPACE_STATIC_BEARER_TOKEN` | Optional override for the fixed MCP bearer token stored in `auth.json`. |

Durable environment settings were removed in v1.1. Move existing deployment
values to these JSONC keys:

| Removed setting | JSONC key |
| --- | --- |
| `HOST`, `PORT` | `server.host`, `server.port` |
| `DEVSPACE_PUBLIC_BASE_URL` | `server.publicBaseUrl` |
| `DEVSPACE_ALLOWED_HOSTS` | `server.allowedHosts` |
| `DEVSPACE_TRUST_PROXY` | `server.trustProxy` |
| `DEVSPACE_ALLOWED_ROOTS` | `workspaces.allowedRoots` |
| `DEVSPACE_WORKTREE_ROOT` | `workspaces.worktreeRoot` |
| `DEVSPACE_STATE_DIR` | `storage.stateDir` |
| `DEVSPACE_TOOL_MODE`, `DEVSPACE_MINIMAL_TOOLS` | `tools.mode` |
| `DEVSPACE_WIDGETS` | `ui.enabled` |
| `DEVSPACE_ARTIFACTS` | `artifacts.enabled` |
| `DEVSPACE_ARTIFACT_MAX_FILE_BYTES` | `artifacts.maxFileBytes` |
| `DEVSPACE_SKILLS` | `skills.enabled` |
| `DEVSPACE_SKILL_PATHS` | `skills.paths` |
| `DEVSPACE_AGENT_DIR` | `skills.agentDir` |
| `DEVSPACE_SUBAGENTS` | `subagents.enabled` |
| `DEVSPACE_LOG_LEVEL` | `logging.level` |
| `DEVSPACE_LOG_FORMAT` | `logging.format` |
| `DEVSPACE_LOG_REQUESTS` | `logging.requests` |
| `DEVSPACE_LOG_ASSETS` | `logging.assets` |
| `DEVSPACE_LOG_TOOL_CALLS` | `logging.toolCalls` |
| `DEVSPACE_LOG_SHELL_COMMANDS` | `logging.shellCommands` |
| `DEVSPACE_OAUTH_ACCESS_TOKEN_TTL_SECONDS` | `oauth.accessTokenTtlSeconds` |
| `DEVSPACE_OAUTH_REFRESH_TOKEN_TTL_SECONDS` | `oauth.refreshTokenTtlSeconds` |
| `DEVSPACE_OAUTH_SCOPES` | `oauth.scopes` |
| `DEVSPACE_OAUTH_ALLOWED_REDIRECT_HOSTS` | `oauth.allowedRedirectHosts` |

These environment values are not read or auto-imported in v1.1. Environment is
process state, so there is no reliable file DevSpace can migrate on the user's
behalf.

## v1.0 file migration

The first v1.1 load performs one migration when `config.jsonc` is missing and
`config.json` exists:

1. Validate the old JSON document.
2. Translate its known fields into the versioned JSONC structure.
3. Write and validate a temporary `config.jsonc`.
4. Atomically publish it.
5. Rename the old file to `config.json.v1.0.bak`.

If `config.jsonc` exists, DevSpace never reads `config.json`. Invalid JSONC also
never falls back to the old file. Unsupported legacy keys stop migration with an
actionable error instead of being silently discarded.

The persisted fields map as follows:

| v1.0 JSON field | v1.1 JSONC key |
| --- | --- |
| `host`, `port` | `server.host`, `server.port` |
| `publicBaseUrl`, `allowedHosts` | `server.publicBaseUrl`, `server.allowedHosts` |
| `allowedRoots`, `worktreeRoot` | `workspaces.allowedRoots`, `workspaces.worktreeRoot` |
| `stateDir` | `storage.stateDir` |
| `artifactsEnabled`, `artifactMaxFileBytes` | `artifacts.enabled`, `artifacts.maxFileBytes` |
| `agentDir` | `skills.agentDir` |
| `subagents` | `subagents` |
| `tools.mode`, `ui.enabled` | unchanged nested keys |

`auth.json` is unchanged.
