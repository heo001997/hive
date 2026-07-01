import { exec, execFile } from 'node:child_process'
import { readFile } from 'node:fs'
import { createLogger } from './logger'

const log = createLogger({ component: 'OrphanMcpReaper' })

/**
 * Periodically reap MCP server processes that have orphaned to PID 1.
 *
 * Background: each `claude` CLI we spawn starts its configured MCP servers as
 * child processes over stdio. A well-behaved server exits when its parent dies
 * (stdin EOF). Some do not — e.g. `@delorenj/mcp-server-trello` keeps a
 * non-`.unref()`'d `setInterval` alive, so the server never exits and is
 * reparented to PID 1, leaking memory/CPU. Over days these accumulate (hundreds
 * of idle Node heaps) and can exhaust RAM/swap.
 *
 * The primary fix is the process-group kill in `PtyService.destroy()`; this
 * sweep is a belt-and-suspenders backstop that also reaps servers which escaped
 * the group (e.g. via their own `setsid`) or leaked before the fix shipped.
 *
 * The same sweep also reaps orphaned agent CLIs (claude/codex/opencode) that we
 * spawned ourselves — see `reapOrphanedManagedAgentClis`. These orphan en masse
 * when the app's *main* process dies (crash or relaunch) without felling its PTY
 * children, and, unlike MCP servers, keep running and pinning CPU indefinitely.
 *
 * Safety: only processes whose parent is PID 1 (truly orphaned) AND whose command
 * matches a known pattern are signalled — and for agent CLIs, only those carrying
 * our managed-PTY env marker. A live `claude`'s MCP servers have that claude as
 * their parent (ppid !== 1), so they are never touched; a user's hand-detached
 * `claude` has no marker, so it is never touched either.
 */

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000 // 10 minutes

// How long to wait after SIGTERM before force-killing a still-living orphan.
// A SIGTERM that doesn't throw is *not* proof the process exited: some MCP
// servers install a graceful-shutdown handler but keep a non-`.unref()`'d timer
// pending, so the event loop never drains and the process lingers — only to be
// re-detected and "reaped" again on the next sweep. The escalation below makes a
// reap actually stick.
const REAP_SIGKILL_GRACE_MS = 2_000

// Matches the npm-exec wrapper and the node child for MCP servers, e.g.
// "npm exec @delorenj/mcp-server-trello" and ".../mcp-server-trello/build/index.js".
// Exported so the system monitor can reuse the same orphan-matching heuristic.
export const MCP_COMMAND_PATTERN = /mcp-server|@modelcontextprotocol|modelcontextprotocol/i

// Agent-CLI command matchers. A `claude` / `codex` / `opencode` process is one we
// spawn as a managed PTY. Single source of truth: the system monitor imports these
// so its process classification and this reaper's orphan-matching can never drift.
export const CLAUDE_COMMAND_PATTERN = /(^|[/\s])claude(-code|_code)?([/\s-]|$)/i
export const CODEX_COMMAND_PATTERN = /(^|[/\s])codex([/\s-]|$)/i
export const OPENCODE_COMMAND_PATTERN = /(^|[/\s])opencode([/\s-]|$)/i
export const AGENT_CLI_COMMAND_PATTERN = new RegExp(
  [CLAUDE_COMMAND_PATTERN, CODEX_COMMAND_PATTERN, OPENCODE_COMMAND_PATTERN]
    .map((r) => r.source)
    .join('|'),
  'i'
)

// Env var stamped on every PTY the app spawns (see PtyService.create). It is what
// lets us safely auto-reap an orphaned agent CLI: a process carrying this marker
// that has reparented to PID 1 is, by definition, one of *our* managed sessions
// whose owning app instance has died — a leak, never a user's intentionally
// detached terminal. So we only ever hard-kill agent CLIs we ourselves started.
export const HIVE_MANAGED_PTY_ENV = 'HIVE_MANAGED_PTY'

interface ProcRow {
  pid: number
  ppid: number
  command: string
}

/** Parse `ps -Ao pid,ppid,command` output into rows (header line fails the match). */
export function parseProcRows(stdout: string): ProcRow[] {
  const rows: ProcRow[] = []
  for (const line of stdout.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)
    if (!match) continue
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] })
  }
  return rows
}

/** Snapshot the full process table. Resolves [] on error (best-effort sweeps). */
function listProcesses(): Promise<ProcRow[]> {
  return new Promise((resolve) => {
    exec('ps -Ao pid,ppid,command', { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        log.warn('Orphan sweep failed to list processes', { err: String(err) })
        resolve([])
        return
      }
      resolve(parseProcRows(stdout))
    })
  })
}

/**
 * Whether a raw environment block contains the managed-PTY marker at a token
 * boundary — so `HIVE_MANAGED_PTY` can never be a false substring of some
 * unrelated variable (e.g. `SOME_HIVE_MANAGED_PTY`). Handles both the macOS
 * `ps -E` shape (space-separated `KEY=val` after the command) and the Linux
 * `/proc/<pid>/environ` shape (NUL-separated pairs). Pure, for unit tests.
 */
export function environIncludesManagedMarker(environText: string): boolean {
  return new RegExp(`(^|[\\s\\0])${HIVE_MANAGED_PTY_ENV}=`).test(environText)
}

/**
 * Best-effort check of whether a live pid was spawned by us (carries the
 * managed-PTY env marker). Linux reads /proc/<pid>/environ; macOS reads the env
 * via `ps -E`. Any failure resolves false — an unrecognised process is treated
 * as not-ours and left alone (fail safe: we never kill what we can't attribute).
 */
export function isProcessHiveManaged(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (process.platform === 'linux') {
      readFile(`/proc/${pid}/environ`, 'utf8', (err, data) => {
        resolve(!err && environIncludesManagedMarker(data))
      })
      return
    }
    if (process.platform === 'darwin') {
      execFile('ps', ['-Eww', '-o', 'command=', '-p', String(pid)], (err, stdout) => {
        resolve(!err && environIncludesManagedMarker(stdout))
      })
      return
    }
    resolve(false)
  })
}

let timer: NodeJS.Timeout | undefined

/**
 * Run a single sweep for orphans (ppid===1) whose command matches `pattern`.
 * Resolves with the number of processes signalled. The pattern is parameterised
 * so the periodic reaper can stay MCP-only (it must not touch a user's
 * intentionally-detached agent session) while the monitor's manual
 * "force-cleanup" can sweep the wider set of app orphans it actually flags.
 */
export async function reapOrphans(pattern: RegExp): Promise<number> {
  if (process.platform === 'win32') return 0
  const rows = await listProcesses()
  const signalled: number[] = []
  for (const { pid, ppid, command } of rows) {
    if (ppid !== 1) continue // only reparented orphans
    if (pid === process.pid) continue
    if (!pattern.test(command)) continue
    try {
      process.kill(pid, 'SIGTERM')
      signalled.push(pid)
      log.info('Reaped orphaned process', { pid, command: command.slice(0, 160) })
    } catch (killErr) {
      const code = (killErr as NodeJS.ErrnoException)?.code
      if (code !== 'ESRCH') {
        log.warn('Failed to reap orphaned process', { pid, code })
      }
    }
  }
  if (signalled.length > 0) {
    log.info('Orphan sweep complete', { killed: signalled.length })
    // Backstop: SIGKILL any that ignored the SIGTERM, so a stubborn server
    // can't survive sweep after sweep. Unref'd so it never holds the app
    // open. We re-scan rather than trust the stale pid list, so a pid that
    // exited and got recycled into something innocent is never hit.
    setTimeout(() => escalateKill(signalled, pattern), REAP_SIGKILL_GRACE_MS).unref?.()
  }
  return signalled.length
}

/**
 * Re-scan and SIGKILL any of `pids` that are STILL orphaned (ppid===1) and still
 * match `pattern`. Both guards matter: skipping a pid that reparented away or got
 * recycled into an unrelated command means the hard kill can only ever land on a
 * process we already SIGTERM'd and that refused to die.
 */
function escalateKill(pids: number[], pattern: RegExp): void {
  const targets = new Set(pids)
  void listProcesses().then((rows) => {
    for (const { pid, ppid, command } of rows) {
      if (!targets.has(pid)) continue
      if (ppid !== 1) continue // reparented away — leave it alone
      if (!pattern.test(command)) continue // pid recycled into something else
      try {
        process.kill(pid, 'SIGKILL')
        log.info('Force-killed orphan that ignored SIGTERM', { pid })
      } catch {
        // ESRCH: it finally exited on its own between the scan and the kill.
      }
    }
  })
}

/** Run a single sweep for orphaned MCP servers (the periodic-reaper default). */
export function reapOrphanedMcpServers(): Promise<number> {
  return reapOrphans(MCP_COMMAND_PATTERN)
}

/**
 * Reap agent-CLI orphans (claude/codex/opencode reparented to PID 1) that carry
 * our managed-PTY marker — sessions we spawned whose owning app instance has died
 * (a crash, or a quit/relaunch that outran its synchronous PTY teardown). Because
 * these were parented by an app process that is now gone, they will otherwise run
 * forever, typically busy-looping on their severed PTY and pinning a core — the
 * "50 orphaned Claude CLIs at 202% CPU" symptom. Unmarked orphaned agent CLIs are
 * deliberately left untouched: they may be a user's own detached session.
 * Resolves with the number signalled.
 */
export async function reapOrphanedManagedAgentClis(): Promise<number> {
  if (process.platform === 'win32') return 0
  const rows = await listProcesses()
  const candidates = rows.filter(
    (r) => r.ppid === 1 && r.pid !== process.pid && AGENT_CLI_COMMAND_PATTERN.test(r.command)
  )
  const signalled: number[] = []
  for (const c of candidates) {
    // Only kill what we can prove is ours. A hand-run `claude` the user detached
    // has no marker and is skipped.
    if (!(await isProcessHiveManaged(c.pid))) continue
    try {
      process.kill(c.pid, 'SIGTERM')
      signalled.push(c.pid)
      log.info('Reaped orphaned managed agent CLI', {
        pid: c.pid,
        command: c.command.slice(0, 160)
      })
    } catch (killErr) {
      const code = (killErr as NodeJS.ErrnoException)?.code
      if (code !== 'ESRCH') log.warn('Failed to reap orphaned agent CLI', { pid: c.pid, code })
    }
  }
  if (signalled.length > 0) {
    log.info('Managed agent-CLI orphan sweep complete', { killed: signalled.length })
    // Same SIGKILL escalation as the MCP path: an agent CLI wedged on its dead
    // PTY may not honour SIGTERM promptly. Re-scan guards against a recycled pid.
    setTimeout(
      () => escalateKill(signalled, AGENT_CLI_COMMAND_PATTERN),
      REAP_SIGKILL_GRACE_MS
    ).unref?.()
  }
  return signalled.length
}

/** Sweep every kind of leaked orphan we know how to attribute to ourselves. */
function sweepOrphans(): void {
  void reapOrphanedMcpServers()
  void reapOrphanedManagedAgentClis()
}

/** Start the periodic reaper. Idempotent. */
export function startOrphanMcpReaper(intervalMs = DEFAULT_INTERVAL_MS): void {
  if (timer) return
  // Sweep once shortly after startup, then on an interval. The timer is unref'd
  // so it never keeps the app alive — the very bug this service cleans up after.
  sweepOrphans()
  timer = setInterval(sweepOrphans, intervalMs)
  timer.unref?.()
  log.info('Orphan MCP reaper started', { intervalMs })
}

/** Stop the periodic reaper. */
export function stopOrphanMcpReaper(): void {
  if (timer) {
    clearInterval(timer)
    timer = undefined
    log.info('Orphan MCP reaper stopped')
  }
}
