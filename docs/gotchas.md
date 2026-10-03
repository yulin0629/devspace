# Troubleshooting Gotchas

This page collects the setup issues users are most likely to hit.

## Opening A Large Workspace

Adding `~` to `workspaces.allowedRoots` permits Home access, but
`open_workspace` discovers nested `AGENTS.md` and `CLAUDE.md` files, skipping
hidden child directories, `node_modules`, `dist`, `build`, and directories named
`cache` or `caches` (case-insensitive). Hidden child directories commonly contain
harness history, plugin caches, worktrees, and trash. They remain accessible
when explicitly opened as a workspace; this discovery filter does not change
the filesystem allowlist or initial root/global instruction loading.

On macOS, automatically scanning Home also skips its standard Desktop,
Documents, Downloads, Library, Movies, Music, and Pictures children. Directory
reads there can wait for a TCC privacy prompt when DevSpace runs under launchd,
even if an SSH-launched preview can read them. These exclusions apply only to
Home discovery, including a Git repository rooted at Home. An explicitly
opened directory or a normal project containing those names is still scanned;
filesystem operations remain subject to macOS permissions. Automatic macOS
Home discovery also stays on Home's filesystem rather than descending into
NFS or other mounted volumes, whose directory reads can block a background
service. Opening a mounted directory explicitly retains normal discovery.

Within Git repositories, discovery uses Git's tracked and non-ignored untracked
files, including nested `.gitignore` rules. This also applies to repositories
encountered while scanning a non-Git parent such as Home. Tracked files remain
visible even if a later ignore rule matches them. Directory symlinks are not
followed. Discovery is limited to eight nested directory levels and 2,000
walked directories; bounded Git queries fail closed with a scan-limit notice.

The nested instruction and skill catalogs show at most 50 entries, including
structured output and card metadata, with omitted counts in the response.
Skill descriptions are shortened to 160 characters when the catalog exceeds
50 entries. A scan-limit notice means the instruction count covers only the
scanned portion. Use the shell to inspect omitted files or skill directories.

Open the actual project or harness subdirectory as the workspace while keeping
Home in the allowlist. This reduces the discovery scope without changing the
configured access boundary.

## User Commands Missing From Bash PATH

DevSpace probes the user's login shell once per server process to obtain PATH,
then merges it with the inherited tool PATH using Pi's Bash spawn hook. The
login shell comes from `SHELL`, or the operating system's user account record.
Only PATH is imported; commands still execute with Bash syntax. The probe has
a two-second timeout and retains the inherited PATH on errors or malformed
output. Restart DevSpace after changing login PATH configuration.

## `devspace` Command Not Found

Use `npx`:

```bash
npx @waishnav/devspace init
npx @waishnav/devspace serve
```

If you installed globally, confirm npm's global bin directory is on `PATH`.

## Unsupported Node Version

DevSpace requires Node `>=22.19 <27`.

Check:

```bash
node --version
```

Install Node 22 LTS with your preferred version manager such as `nvm`, `fnm`, or
`mise`.

## `better-sqlite3` Could Not Load

This usually means native dependencies were installed under a different Node
runtime.

Try:

```bash
npm rebuild better-sqlite3
```

Then run:

```bash
npx @waishnav/devspace doctor
```

Release starts run a native dependency check before launching.

## Public URL Includes `/mcp`

Use the origin for setup:

```text
https://your-tunnel-host.example.com
```

Use the MCP endpoint in the client:

```text
https://your-tunnel-host.example.com/mcp
```

If you saved the wrong value:

```bash
npx @waishnav/devspace config set publicBaseUrl https://your-tunnel-host.example.com
```

## Tailscale Funnel `/mcp` Returns 404

Proxy the whole DevSpace server from the Funnel root:

```bash
tailscale funnel --bg 7676
```

Do not use `--set-path=/mcp`. Tailscale removes a configured mount path before
proxying to the local service, so a public `/mcp` request can otherwise arrive
at DevSpace as `/`. DevSpace also needs OAuth routes outside `/mcp`, so serving
the whole local origin is the correct setup.

## Tunnel URL Changed

Temporary tunnels often change URLs between runs.

Update the configured URL:

```bash
npx @waishnav/devspace config set publicBaseUrl https://new-tunnel.example.com
```

For a stable URL:

```bash
npx @waishnav/devspace config set publicBaseUrl https://devspace.example.com
```

## Host Header Or 403 Problems

DevSpace derives allowed hosts from the configured public URL.

Run:

```bash
npx @waishnav/devspace doctor
```

Confirm the public URL hostname appears in allowed hosts. If you changed tunnel
URLs, update `publicBaseUrl`.

For intentional local debugging only, set `server.allowedHosts` to `["*"]` in
`~/.devspace/config.jsonc`.

## OAuth Redirect Host Rejected

By default, DevSpace allows redirects for:

```text
chatgpt.com
localhost
127.0.0.1
```

If another MCP client uses a different redirect host, add it to
`oauth.allowedRedirectHosts` in `~/.devspace/config.jsonc`.

## Owner Password Not Accepted

Make sure you are entering the Owner password from:

```text
~/.devspace/auth.json
```

To regenerate setup:

```bash
npx @waishnav/devspace init --force
```

## Unknown `workspace_id`

`workspace_id` values are session identifiers. If the server restarts and the
client receives an unknown workspace error, call `open_workspace` again for that
project.

Workspace session metadata is persisted. ChatGPT may provide optional
conversation metadata that lets DevSpace resume the same checkout workspace for
the same project in that conversation; repeated opens reuse the `workspace_id`
and do not repeat context already provided for that reused checkout. Worktree
mode always creates a new isolated workspace with its own complete context.
Hosts without supported conversation metadata receive a normal new workspace.
In all cases, continue passing the `workspace_id` returned by `open_workspace` to
later tools. Other MCP hosts use this explicit workspace workflow as well.

To review work, call `show_changes` once after the final related file change. It
shows the combined changes and advances the review point automatically.

## Data Retention

DevSpace does not currently prune workspace sessions, conversation bindings,
or review refs. A future product retention policy will define safe cleanup for
these records; no automatic deletion is performed today.

## MCP Workspace Path Rejected

The path passed to `open_workspace` must be inside one of the allowed roots
configured during ChatGPT setup. Direct `devspace agents` commands instead use
the current local project and are not gated by MCP allowed roots.

Run:

```bash
npx @waishnav/devspace config get
```

Then either open a project under an allowed root or rerun setup:

```bash
npx @waishnav/devspace init --force
```

## Worktree Mode Fails

Worktree mode requires:

- Git installed
- the path is inside a Git repository
- the repository has at least one commit
- the requested `base_ref` resolves to a commit

For a new repository, create the first commit or use checkout mode.

Uncommitted source checkout changes are not copied into the managed worktree.
Commit, stash, or ask the model to work in checkout mode if those changes are
needed.

## Windows Shell Commands Fail

DevSpace shell execution requires Bash. Native PowerShell and `cmd.exe` command
execution are not supported yet.

Install Git for Windows and use Git Bash, or use WSL, MSYS2, or Cygwin Bash.

Run:

```bash
npx @waishnav/devspace doctor
```

Confirm Bash is detected.

## Skills Do Not Appear

Skills are enabled by default. Confirm `skills.enabled` is `true` in
`~/.devspace/config.jsonc`.

DevSpace looks in standard Agent Skills locations:

- `~/.agents/skills`
- project `.agents/skills`
- `~/.devspace/skills`

It also checks compatibility and custom paths:

- `skills.agentDir/skills`, defaulting to `~/.codex/skills`
- additional paths from `skills.paths`

When Subagents are enabled, DevSpace loads agent profiles from
`~/.devspace/agents/*.md` and project `.devspace/agents/*.md`, then exposes a
compact profile catalog through `open_workspace`. DevSpace also synchronizes
its managed `subagents` skill to `~/.devspace/skills/subagents/SKILL.md` and
uses that copy instead of a package-manager path. The skill keeps the
model-facing workflow to
`devspace agents targets`, `devspace agents ls`, `devspace agents run`,
`devspace agents continue`, `devspace agents show`, and `devspace agents wait`.
Those commands automatically manage the internal local agent daemon; `devspace
serve` is not a prerequisite.
`devspace agents ls` lists existing subagent sessions, not profile
definitions.

By default, `subagents.instructions` is `on-demand`, so `open_workspace`
advertises the skill and the model reads it only when useful. Set it to
`preload` to include the workflow directly in the initial workspace
instructions instead.

For a Coding Agent, run the installation command printed by
`devspace init`:

```bash
npx skills add Waishnav/devspace --skill subagents --global
```

The Skills CLI handles agent discovery and installation. DevSpace setup does
not copy files into agent skill directories. The managed
`~/.devspace/skills/subagents` copy is for DevSpace MCP workspaces and is
separate from Coding Agent installation.

Packaged agent profile examples under `examples/agents/` are starter templates.
Copy or adapt them into one of the active profile directories before use.

Legacy project paths such as `.pi/skills` can be added to `skills.paths` when needed.

If a skill appears in `open_workspace`, the model should read that skill's
`SKILL.md` before following it. DevSpace permits reads within advertised skill
directories without tracking whether `SKILL.md` was read first.

## Review Card Does Not Appear

DevSpace attaches widget UI only to `open_workspace` and `show_changes`.
Ordinary reads, edits, and commands intentionally render as normal tool results
to avoid one iframe per call. Plain MCP clients may ignore ChatGPT Apps widget
metadata and only show text results; `show_changes` remains available there.

If both cards are missing in ChatGPT, confirm that `ui.enabled` is not `false`
in `~/.devspace/config.jsonc` and reconnect the MCP server.

Historical `show_changes` cards use the `review_ref` in their structured result
to recover the exact Git-backed review when a host reloads the app without its
original result metadata. `open_workspace` can rebuild its card directly from
its structured result.
