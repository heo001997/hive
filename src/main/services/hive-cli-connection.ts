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
  /**
   * Absolute path to the `hive-ticket` CLI this instance hands to spawned agents,
   * resolved once at connection setup (where Electron's `app` paths are known —
   * see backend-manager). Prefers the bundled copy; null when nothing resolvable,
   * in which case `buildHiveCliEnv` retries the env/global-skill fallbacks itself.
   */
  readonly ticketCliPath?: string | null
  /**
   * Absolute path to the `hive` orchestration CLI this instance hands to spawned
   * agents, resolved once at connection setup (where Electron's `app` paths are
   * known — see backend-manager). Prefers the bundled copy; null when nothing
   * resolvable, in which case `buildHiveCliEnv` retries the env fallback itself.
   */
  readonly hiveCliPath?: string | null
}

let connection: HiveCliConnection | null = null

export function setHiveCliConnection(next: HiveCliConnection | null): void {
  connection = next
}

export function getHiveCliConnection(): HiveCliConnection | null {
  return connection
}

/**
 * Resolve the `hive-ticket` CLI entry the spawned agent should call. Resolution
 * order, most authoritative first:
 *   1. `HIVE_TICKET_CLI` env override (explicit, always wins if it exists).
 *   2. The bundled copy shipped with the app — `hive-ticket.mjs` under each dir in
 *      `searchDirs` (packaged: `process.resourcesPath/cli`; dev: the repo's
 *      `resources/cli`). This is the canonical, versioned CLI.
 *   3. Legacy fallback: the hand-installed global skill
 *      (`~/.claude/skills/hive-create-ticket/create.mjs`).
 * Returns null when nothing is present (the feature then no-ops) — never throws.
 */
export function resolveHiveTicketCliPath(searchDirs: readonly string[] = []): string | null {
  const override = process.env.HIVE_TICKET_CLI?.trim()
  if (override && existsSync(override)) return override
  for (const dir of searchDirs) {
    if (!dir) continue
    const bundled = join(dir, 'hive-ticket.mjs')
    if (existsSync(bundled)) return bundled
  }
  const skillPath = join(homedir(), '.claude', 'skills', 'hive-create-ticket', 'create.mjs')
  if (existsSync(skillPath)) return skillPath
  return null
}

/**
 * Resolve the `hive` orchestration CLI entry the spawned agent should call.
 * Resolution order, most authoritative first:
 *   1. `HIVE_CLI` env override (explicit, always wins if it exists).
 *   2. The bundled copy shipped with the app — `hive.mjs` under each dir in
 *      `searchDirs` (packaged: `process.resourcesPath/cli`; dev: the repo's
 *      `resources/cli`). This is the canonical, versioned CLI.
 * Returns null when nothing is present (the feature then no-ops) — never throws.
 */
export function resolveHiveCliPath(searchDirs: readonly string[] = []): string | null {
  const override = process.env.HIVE_CLI?.trim()
  if (override && existsSync(override)) return override
  for (const dir of searchDirs) {
    if (!dir) continue
    const bundled = join(dir, 'hive.mjs')
    if (existsSync(bundled)) return bundled
  }
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
  // Prefer the path resolved at connection setup (Electron `app` paths are only
  // known there); otherwise re-resolve via env override / global-skill fallback.
  const cliPath = conn.ticketCliPath ?? resolveHiveTicketCliPath()
  if (cliPath) env.HIVE_TICKET_CLI = cliPath
  const hiveCliPath = conn.hiveCliPath ?? resolveHiveCliPath()
  if (hiveCliPath) env.HIVE_CLI = hiveCliPath
  return env
}
