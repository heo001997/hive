import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The live local Hive backend's connection details, captured by the backend
 * manager the moment the server is confirmed up (alongside the `cli.json` write).
 * Held in a main-process singleton so the Claude CLI spawner can inject the
 * `HIVE_*` env into every agent it launches — the agent then shells out to the
 * `hive-ticket` CLI with zero flags (right instance, pre-authed), no port scan or
 * token discovery needed. Cleared on backend stop so a stale token is never handed
 * to a CLI once the server it belonged to is gone.
 */
export interface HiveCliConnection {
  readonly host: string
  readonly port: number
  readonly bootstrapToken: string
  /** This instance's data dir (`<worktree>/.hive-data` in dev, `~/.hive` in prod). */
  readonly baseDir: string
}

let connection: HiveCliConnection | null = null

export function setHiveCliConnection(next: HiveCliConnection | null): void {
  connection = next
}

export function getHiveCliConnection(): HiveCliConnection | null {
  return connection
}

/**
 * Resolve the `hive-ticket` CLI entry the spawned agent should call. Prefers an
 * explicit `HIVE_TICKET_CLI` override, else the well-known global skill install
 * (`~/.claude/skills/hive-create-ticket/create.mjs`). Returns null when neither is
 * present (the agent then falls back to its own discovery, or the feature is a
 * no-op) — never throws.
 */
export function resolveHiveTicketCliPath(): string | null {
  const override = process.env.HIVE_TICKET_CLI?.trim()
  if (override && existsSync(override)) return override
  const skillPath = join(homedir(), '.claude', 'skills', 'hive-create-ticket', 'create.mjs')
  if (existsSync(skillPath)) return skillPath
  return null
}

/**
 * Build the `HIVE_*` environment the spawned Claude CLI needs to drive the
 * `hive-ticket` CLI autonomously. Empty when the backend connection isn't captured
 * yet (pre-startup) — the caller merges it over the user's own env vars.
 */
export function buildHiveCliEnv(context: {
  projectId?: string | null
  worktreeId?: string | null
}): Record<string, string> {
  const conn = connection
  if (!conn) return {}
  const env: Record<string, string> = {
    HIVE_HOST: conn.host,
    HIVE_PORT: String(conn.port),
    HIVE_DATA_DIR: conn.baseDir,
    HIVE_DESKTOP_BOOTSTRAP_TOKEN: conn.bootstrapToken
  }
  if (context.projectId) env.HIVE_PROJECT_ID = context.projectId
  if (context.worktreeId) env.HIVE_WORKTREE_ID = context.worktreeId
  const cliPath = resolveHiveTicketCliPath()
  if (cliPath) env.HIVE_TICKET_CLI = cliPath
  return env
}
