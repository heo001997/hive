import { exec } from 'node:child_process'
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
 * Safety: only processes whose parent is PID 1 (truly orphaned) AND whose
 * command matches an MCP server are signalled. Servers attached to a live
 * `claude` have that claude as their parent, so they are never touched.
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

let timer: NodeJS.Timeout | undefined

/**
 * Run a single sweep for orphans (ppid===1) whose command matches `pattern`.
 * Resolves with the number of processes signalled. The pattern is parameterised
 * so the periodic reaper can stay MCP-only (it must not touch a user's
 * intentionally-detached agent session) while the monitor's manual
 * "force-cleanup" can sweep the wider set of app orphans it actually flags.
 */
export function reapOrphans(pattern: RegExp): Promise<number> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      resolve(0)
      return
    }
    exec('ps -Ao pid,ppid,command', { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        log.warn('Orphan sweep failed to list processes', { err: String(err) })
        resolve(0)
        return
      }
      const signalled: number[] = []
      for (const line of stdout.split('\n')) {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)
        if (!match) continue
        const pid = Number(match[1])
        const ppid = Number(match[2])
        const command = match[3]
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
      resolve(signalled.length)
    })
  })
}

/**
 * Re-scan and SIGKILL any of `pids` that are STILL orphaned (ppid===1) and still
 * match `pattern`. Both guards matter: skipping a pid that reparented away or got
 * recycled into an unrelated command means the hard kill can only ever land on a
 * process we already SIGTERM'd and that refused to die.
 */
function escalateKill(pids: number[], pattern: RegExp): void {
  const targets = new Set(pids)
  exec('ps -Ao pid,ppid,command', { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
    if (err) return
    for (const line of stdout.split('\n')) {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)
      if (!match) continue
      const pid = Number(match[1])
      const ppid = Number(match[2])
      const command = match[3]
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

/** Start the periodic reaper. Idempotent. */
export function startOrphanMcpReaper(intervalMs = DEFAULT_INTERVAL_MS): void {
  if (timer) return
  // Sweep once shortly after startup, then on an interval. The timer is unref'd
  // so it never keeps the app alive — the very bug this service cleans up after.
  void reapOrphanedMcpServers()
  timer = setInterval(() => void reapOrphanedMcpServers(), intervalMs)
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
