# `hive-ticket` — Hive kanban CLI

`hive-ticket.mjs` is the canonical command-line client for a running Hive app's
kanban board. It lets an **AI agent** or a **human** create, read, update, move,
and delete tickets from a terminal — no UI, no "Create all" button.

It is **self-contained and dependency-free**: it uses Node's built-in global
`WebSocket` (Node ≥ 22), so it runs as a single file with no `node_modules`
alongside it, from any working directory.

## How the app uses it

The desktop app resolves this CLI once at backend startup and injects its path as
`$HIVE_TICKET_CLI` (plus `HIVE_PORT`, `HIVE_PROJECT_ID`, `HIVE_WORKTREE_ID`,
`HIVE_DATA_DIR`, `HIVE_DESKTOP_BOOTSTRAP_TOKEN`) into every agent it spawns. The
agent can then drive the board with **zero flags** — the right instance, project,
and auth are already wired. See:

- `src/main/services/hive-cli-connection.ts` — `resolveHiveTicketCliPath()` /
  `buildHiveCliEnv()` (resolution order: `$HIVE_TICKET_CLI` → bundled copy →
  legacy global skill).
- `src/main/desktop/backend-manager.ts` — resolves the bundled path from Electron
  `app` paths and stores it on the live connection.

Resolution finds this file at:

- **Packaged app:** `process.resourcesPath/cli/hive-ticket.mjs` (copied there by
  `electron-builder` `extraResources`).
- **Dev:** `<repo>/resources/cli/hive-ticket.mjs` (via `app.getAppPath()`).

## Commands

```
hive-ticket create "Title" ["Description"] ["todo|in_progress|review|done"]
hive-ticket create --title "..." [--description "..."] [--column todo]
                   [--worktree <id>] [--depends-on <id[,id,...]>]
                   [--session <id>] [--mode build]
                   [--gate [--gate-max N] [--gate-provider p] [--gate-model m]
                    [--gate-auto-done]]
hive-ticket batch tickets.json     # JSON array of { title, description?, column?,
                                   #   draftKey?, dependsOn?, worktreeId?, gate? }
hive-ticket list [--column <col>] [--include-archived] [--json]
hive-ticket get <id> [--json]
hive-ticket update <id> [--title ..] [--description ..] [--column ..]
                        [--worktree <id>] [--mark ..] [--auto-approve-review true|false]
hive-ticket move <id> <todo|in_progress|review|done> [sortOrder]
hive-ticket delete <id>
hive-ticket dep add <dependentId> <blockerId>
hive-ticket dep remove <dependentId> <blockerId>
hive-ticket list-projects
hive-ticket list-instances
```

### Targeting a Hive & project

Several Hive apps usually run at once (production, a `pnpm dev` build, one per
worktree). The CLI selects deterministically and **never guesses**:

1. `--port <n>` / `$HIVE_PORT`
2. `--instance <name|kind>` / `$HIVE_INSTANCE` (matches label / kind / repoRoot / dataDir)
3. Context auto-match — the instance for the repo/worktree your shell is in
4. Exactly one instance running
5. Otherwise it lists them and stops

A `production` instance is refused unless selected explicitly (safety guard).
Project resolves via `--project <name|id>` → `$HIVE_PROJECT_ID` → the only project.

## Running it by hand

```sh
node resources/cli/hive-ticket.mjs list
node resources/cli/hive-ticket.mjs create "Fix login bug" "" in_progress
node resources/cli/hive-ticket.mjs --help
```

`stdout` stays machine-parseable (`<id>\t<column>\t<title>`); the chosen instance
and other diagnostics go to `stderr`.

## Testing

Pure, deterministic helpers (arg parsing, column validation, gate config, batch
draft mapping, instance selection) are exported and covered by
`test/utils/hive-ticket-cli.test.ts`. Discovery / auth / RPC need a live Hive and
are exercised by running the app.
