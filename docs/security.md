# Security Model

DevSpace exposes local coding capabilities over MCP. Treat it as remote access
to your development machine.

The security model is simple:

- you choose a narrow filesystem allowlist
- the MCP endpoint requires an approved OAuth token or the optional static bearer token
- Host headers are allowlisted from the configured public URL
- every coding action happens through explicit MCP tool calls

## Filesystem Allowlist

DevSpace only opens workspaces under configured roots.

Good examples:

```text
~/work
~/personal/open-source
```

Avoid broad roots:

```text
~
/
C:\
```

The narrower the root, the easier it is to reason about what the MCP client can
reach.

## Owner Password

`devspace init` generates an Owner password and stores it in:

```text
~/.devspace/auth.json
```

When an MCP client connects through OAuth, DevSpace shows an approval page. Enter the Owner
password only when you intentionally want that client to access this server.

This fork also accepts an optional static bearer token configured in
`~/.devspace/auth.json` or `DEVSPACE_STATIC_BEARER_TOKEN`. Possession of that token
grants the MCP scope directly, without an Owner approval page. Keep it private;
see [configuration](configuration.md#optional-static-bearer-token).

For env-driven deployments, set a long random value:

```bash
DEVSPACE_OAUTH_OWNER_TOKEN="$(openssl rand -base64 32)"
```

## Public URL And Host Allowlist

DevSpace needs `server.publicBaseUrl` in `config.jsonc` so MCP clients can
discover OAuth metadata and connect to the correct resource.

The value should be the origin only:

```text
https://your-tunnel-host.example.com
```

Do not include `/mcp` in `server.publicBaseUrl`.

By default, DevSpace derives allowed Host headers from the local host and public
URL. Put `"*"` in `server.allowedHosts` only for intentional local debugging.

## Tunnels

DevSpace does not manage tunnels. Your tunnel or reverse proxy should point to:

```text
http://127.0.0.1:7676
```

Prefer adding Cloudflare Access, Tailscale identity controls, or equivalent
protection in front of public tunnels. DevSpace bearer authentication still protects the MCP
endpoint, but the tunnel URL should not be treated as a secret.

## Shell Access

The shell tool is powerful by design. It is meant for tests, builds, git, and
package scripts.

Filesystem path containment applies to DevSpace file tools. Shell commands run
as local commands and can do what your user account can do. This is why the MCP
client must be trusted and the Owner password and static bearer token must stay private.

## Worktrees

Managed worktrees reduce accidental edits to your active checkout, but they are
not a security boundary. They are a workflow boundary for isolated coding
sessions.

## Native File Download

Native file download is an opt-in, one-shot transfer into an already-open
workspace. `download_artifact` accepts the MCP host's native file value, the
`workspace_id` returned by `open_workspace`, and an unused relative destination
path. It returns only the workspace-relative path and does not create a
persistent artifact service or reusable artifact ID.

DevSpace accepts only the documented native-file object and trusted OpenAI
download hosts and redirects. Arbitrary URL strings, local source paths,
credentials, malformed references, and unknown object fields are rejected.

Absolute paths, traversal, symlinked parents, and existing destinations also
fail closed. Downloads stream under the configured per-file limit and are
published without overwrite. On Linux, destination traversal stays anchored to
opened directory descriptors. On macOS, traversal, inspection, cleanup, and
publication use descriptor-relative filesystem operations against pinned
directories. On Windows, DevSpace holds native directory handles without
delete sharing, rejects reparse points, and keeps those handles open while Node
performs the path-based write and publication operations. On POSIX systems the
partial is created with mode `0600`; Windows permissions follow inherited ACLs.
DevSpace does not extract or execute transferred content.

## Logs

Optional `events.enabled` observation stores tool completion metadata in a
private JSONL spool. It defaults to false and is separate from logging.
Source, attachments, raw tool inputs and full results are excluded. Only the
six documented tools have detailed whitelist fields. Bash summaries omit
arguments; output retains only bounded operational status/count lines, with
other output replaced by `[output omitted]`. Filters redact credential formats,
assignments, auth headers, private keys and URL credentials in metadata.
Machine/workspace identifiers requiring filtering use SHA-256 pseudonyms to
preserve distinct session identities without storing their plaintext.
Arbitrary secrets disguised as ordinary filenames cannot be identified reliably.
Forwarder delivery repeats these filters before calling Agent Memory.

See [tool completion events](configuration.md#tool-completion-events) for
retention, failure handling and the server deployment gate.

By default, DevSpace logs requests and tool calls. Shell command previews are
disabled unless `logging.shellCommands` is `true`.

Do not enable shell command logging if commands may contain secrets.

Artifact tool logs contain bounded workspace ID, validated hostname,
workspace-relative output path, byte count, hash, duration, and status metadata.
`download_artifact` does not log the opaque file value. Raw content, connector
references, native file IDs, bearer credentials, presigned URLs, host paths,
temporary paths, and base64 chunks are never included in tool logs or tool
results.
