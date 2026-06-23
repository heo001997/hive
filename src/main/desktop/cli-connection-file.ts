import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Per-instance connection handoff for same-user local CLIs/tools (e.g. the Claude
// Code "create Hive ticket" skill). Written into THIS instance's own data dir —
// which is already isolated per worktree (`<worktree>/.hive-data`, gitignored) in
// dev and `~/.hive` in prod — so the file is automatically unique per running
// instance with no port-keyed registry needed.
//
// Why it exists: the desktop backend always requires auth, and its bootstrap token
// is otherwise only reachable by scraping the renderer's argv via `ps` — which is
// fragile (a hardened/notarized app may hide argv) and ambiguous when several Hive
// instances run at once. This file hands the token to a co-located terminal client
// deterministically. It carries `port` so a client can reject a stale file whose
// instance is no longer the one it selected.
//
// Security: mode 0600 (owner-only), written atomically (temp + rename), removed on
// shutdown and overwritten on every start. Strictly tighter than the argv exposure
// it replaces — `ps` argv is visible to other users under the common Linux
// `hidepid=0`, whereas this file is not — and a leftover token is useless without
// its matching live server (bootstrap validates against the running token).
export interface CliConnectionFile {
  readonly version: 1
  readonly port: number
  readonly bootstrapToken: string
  readonly pid: number
  readonly startedAt: string
}

const FILE_NAME = 'cli.json'

export const cliConnectionFilePath = (baseDir: string): string => join(baseDir, FILE_NAME)

export const writeCliConnectionFile = (
  baseDir: string,
  data: Omit<CliConnectionFile, 'version'>
): void => {
  mkdirSync(baseDir, { recursive: true })
  const target = cliConnectionFilePath(baseDir)
  const tmp = `${target}.tmp`
  const body = JSON.stringify({ version: 1, ...data } satisfies CliConnectionFile)
  // Fresh 0600 temp, then atomic rename so a reader never sees a partial file and
  // the final file inherits the restrictive mode.
  rmSync(tmp, { force: true })
  writeFileSync(tmp, body, { mode: 0o600 })
  renameSync(tmp, target)
}

export const removeCliConnectionFile = (baseDir: string): void => {
  try {
    rmSync(cliConnectionFilePath(baseDir), { force: true })
  } catch {
    // Best-effort: a leftover file is overwritten on the next start and ignored by
    // clients once its port no longer matches a live instance.
  }
}
