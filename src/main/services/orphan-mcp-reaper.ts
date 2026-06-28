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

// Matches the npm-exec wrapper and the node child for MCP servers, e.g.
// "npm exec @delorenj/mcp-server-trello" and ".../mcp-server-trello/build/index.js".
const MCP_COMMAND_PATTERN = /mcp-server|@modelcontextprotocol|modelcontextprotocol/i

let timer: NodeJS.Timeout | undefined

/** Run a single sweep. Resolves with the number of processes signalled. */
export function reapOrphanedMcpServers(): Promise<number> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      resolve(0)
      return
    }
    exec('ps -Ao pid,ppid,command', { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        log.warn('Orphan MCP sweep failed to list processes', { err: String(err) })
        resolve(0)
        return
      }
      let killed = 0
      for (const line of stdout.split('\n')) {
        const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)
        if (!match) continue
        const pid = Number(match[1])
        const ppid = Number(match[2])
        const command = match[3]
        if (ppid !== 1) continue // only reparented orphans
        if (pid === process.pid) continue
        if (!MCP_COMMAND_PATTERN.test(command)) continue
        try {
          process.kill(pid, 'SIGTERM')
          killed++
          log.info('Reaped orphaned MCP server', { pid, command: command.slice(0, 160) })
        } catch (killErr) {
          const code = (killErr as NodeJS.ErrnoException)?.code
          if (code !== 'ESRCH') {
            log.warn('Failed to reap orphaned MCP server', { pid, code })
          }
        }
      }
      if (killed > 0) {
        log.info('Orphan MCP sweep complete', { killed })
      }
      resolve(killed)
    })
  })
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
