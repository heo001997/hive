# Hive MCP server

`hive-mcp.mjs` turns the running **Hive desktop app** into a
[Model Context Protocol](https://modelcontextprotocol.io) *provider*. Any external
AI agent that speaks MCP (Claude Code, Claude Desktop, Cursor, …) can then drive
Hive over stdio: create and list git worktrees, start / prompt / inspect agent
sessions, and read git status.

It is **dependency-free** — a single self-contained `.mjs` that uses only Node
built-ins plus the global `fetch` and `WebSocket` (Node **≥ 22**). No
`node_modules`, no build step. It rides along in packaged builds the same way as
`resources/cli/hive-ticket.mjs`.

## What it does

- **Transport**: MCP stdio — newline-delimited JSON-RPC 2.0 on stdin/stdout.
  Implements `initialize`, `tools/list`, `tools/call`, `ping`, and accepts
  `notifications/*` silently. stdout is reserved for JSON-RPC frames; all logging
  goes to stderr.
- **Backend**: it discovers the live Hive instance exactly like the `hive-ticket`
  CLI — scans ports `3773..3873`, selects one deterministically, does the
  `bootstrap → ws-token` handshake, and speaks Hive's RPC envelope over
  `ws://…/ws`. The Hive app must be running.

## Tools (curated, safe)

Only read + create/prompt operations are exposed. Destructive RPCs (delete /
discard) are intentionally **not** mapped.

| MCP tool | Hive RPC | Arguments |
| --- | --- | --- |
| `hive_worktree_create` | `db.project.getAll` → `worktreeOps.create` | `projectId` |
| `hive_worktree_list` | `db.worktree.getByProject` | `projectId` |
| `hive_session_start` | `opencodeOps.connect` | `worktreePath`, `hiveSessionId` |
| `hive_session_prompt` | `opencodeOps.prompt` | `worktreePath`, `opencodeSessionId`, `message`, `model?` |
| `hive_session_status` | `opencodeOps.sessionInfo` | `worktreePath`, `opencodeSessionId` |
| `hive_git_status` | `gitOps.getFileStatuses` | `worktreePath` |

Each tool returns the raw Hive RPC result as MCP text content. On a backend
failure the tool returns `isError: true` with the error text (rather than crashing
the transport).

`hive_worktree_create` takes **only** a `projectId`. It looks the project up in the
running app (`db.project.getAll`) and derives the repository path and name from
that trusted record before creating the worktree — a caller cannot pass a path or
name of its own (this prevents a crafted name from escaping the worktree base
directory).

## Registering it

### Claude Code (`.mcp.json` in a project, or user config)

```json
{
  "mcpServers": {
    "hive": {
      "command": "node",
      "args": ["resources/mcp/hive-mcp.mjs"]
    }
  }
}
```

Use an absolute path to `hive-mcp.mjs` if the agent's working directory is not the
repo root — e.g. in a packaged install:
`"args": ["/Applications/Hive.app/Contents/Resources/mcp/hive-mcp.mjs"]`.

You can also add it from the CLI:

```bash
claude mcp add hive -- node /absolute/path/to/resources/mcp/hive-mcp.mjs
```

### Claude Desktop (`claude_desktop_config.json`)

Same shape as above — add a `hive` entry under `mcpServers`.

### Cursor / other MCP clients

Any client that launches an MCP stdio server works; point its command at
`node …/hive-mcp.mjs`.

## Selecting a Hive instance

Several Hive instances can run at once (production, `pnpm dev`, one per worktree).
The server auto-matches the instance bound to the current working directory /
repo. Override via environment variables on the `mcpServers` entry:

| Env var | Purpose |
| --- | --- |
| `HIVE_PORT` | Target an exact port (`3773`..`3873`). |
| `HIVE_INSTANCE` | Match by label / kind / repo root / data dir (e.g. `production`). |
| `HIVE_HOST` | Backend host (default `127.0.0.1`). |
| `HIVE_DATA_DIR` | This shell's data dir (used for context auto-match + token lookup). |
| `HIVE_DESKTOP_BOOTSTRAP_TOKEN` | Explicit bootstrap token when it can't be auto-discovered (e.g. signed/notarized app that hides its argv). |

A **production** instance is refused unless selected explicitly with
`HIVE_INSTANCE=production` or `HIVE_PORT=<n>` (safety guard). `--port` / `--instance`
CLI flags are also honored.

```json
{
  "mcpServers": {
    "hive": {
      "command": "node",
      "args": ["/absolute/path/to/resources/mcp/hive-mcp.mjs"],
      "env": { "HIVE_INSTANCE": "hive-dev" }
    }
  }
}
```

## Smoke test

```bash
node --check resources/mcp/hive-mcp.mjs

# Two requests on separate lines. Lines are handled concurrently (a slow
# tools/call never blocks ping/initialize); replies are matched by id, so they may
# arrive in any order.
printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | node resources/mcp/hive-mcp.mjs
# → {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","serverInfo":{"name":"hive-mcp","version":"0.1.0"},"capabilities":{"tools":{}}}}
# → {"jsonrpc":"2.0","id":2,"result":{"tools":[ … ]}}
```

`initialize` and `tools/list` work with no backend; `tools/call` requires a running
Hive app to return data.

## Requirements

- Node **≥ 22** (built-in global `WebSocket`).
- A running Hive desktop app on the same machine.
