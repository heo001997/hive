import { watch, existsSync, readdirSync, statSync, type FSWatcher } from 'fs'
import { join, basename } from 'path'
import { encodePath, resolveProjectsDir } from './claude-transcript-reader'
import { createLogger } from './logger'

const log = createLogger({ component: 'ClaudeSessionWatcher' })

function listJsonlFiles(dir: string): Set<string> {
  try {
    return new Set(readdirSync(dir).filter((name) => name.endsWith('.jsonl')))
  } catch {
    return new Set()
  }
}

function newestJsonlCreatedAfter(dir: string, existing: Set<string>, startedAtMs: number): string | null {
  let newest: { name: string; mtimeMs: number } | null = null
  for (const name of listJsonlFiles(dir)) {
    if (existing.has(name)) continue
    try {
      const stat = statSync(join(dir, name))
      if (stat.mtimeMs + 1000 < startedAtMs) continue
      if (!newest || stat.mtimeMs > newest.mtimeMs) {
        newest = { name, mtimeMs: stat.mtimeMs }
      }
    } catch {
      // File can disappear between readdir and stat; ignore this scan tick.
    }
  }
  return newest ? basename(newest.name, '.jsonl') : null
}

export interface ClaudeSessionWatchHandle {
  close(): void
}

export interface WatchForClaudeSessionIdOptions {
  /**
   * Interval for the guaranteed poll fallback. Defaults to 1000ms; tests lower it.
   */
  pollMs?: number
}

const DEFAULT_POLL_MS = 1000

export function watchForClaudeSessionId(
  worktreePath: string,
  onSessionId: (sessionId: string) => void,
  options: WatchForClaudeSessionIdOptions = {}
): ClaudeSessionWatchHandle {
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS
  const dir = join(resolveProjectsDir(), encodePath(worktreePath))
  const existing = listJsonlFiles(dir)
  const startedAtMs = Date.now()
  let closed = false
  let watcher: FSWatcher | null = null
  let interval: NodeJS.Timeout | null = null
  let scanScheduled: NodeJS.Timeout | null = null

  const stopTimers = (): void => {
    if (interval) clearInterval(interval)
    interval = null
    if (scanScheduled) clearTimeout(scanScheduled)
    scanScheduled = null
  }

  const complete = (sessionId: string): void => {
    if (closed) return
    closed = true
    stopTimers()
    watcher?.close()
    watcher = null
    log.info('Detected Claude CLI session id', { worktreePath, sessionId })
    onSessionId(sessionId)
  }

  // Coalesce bursts of fs events (the CLI appends many lines while a transcript
  // is created) into a single directory scan.
  const requestScan = (): void => {
    if (closed || scanScheduled) return
    scanScheduled = setTimeout(() => {
      scanScheduled = null
      if (!closed) scan()
    }, 50)
  }

  // Attach fs.watch for low-latency detection. The transcript directory may not
  // exist at spawn (brand-new worktree), so this is retried from the poll loop
  // until it succeeds — after which fs events and the poll both feed detection.
  const tryAttachWatcher = (): void => {
    if (watcher || closed || !existsSync(dir)) return
    try {
      watcher = watch(dir, (_eventType, filename) => {
        if (typeof filename === 'string' && filename.endsWith('.jsonl')) {
          requestScan()
        }
      })
    } catch (error) {
      log.warn('Unable to watch Claude transcript directory', {
        dir,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  const scan = (): void => {
    if (closed) return
    tryAttachWatcher()
    const sessionId = newestJsonlCreatedAfter(dir, existing, startedAtMs)
    if (sessionId) complete(sessionId)
  }

  // Always poll as a guaranteed fallback. macOS fs.watch/FSEvents can silently
  // drop or coalesce the transcript's create event under CPU/FS load, which
  // would otherwise strand the session id permanently ("session lost connect to
  // the right Claude Code CLI session"). fs.watch stays attached for low latency;
  // the poll guarantees eventual capture. It self-terminates the instant the id
  // is found, so it is short-lived in the common case and only lingers for
  // sessions that have not yet produced a transcript.
  interval = setInterval(scan, pollMs)
  scan()

  return {
    close: () => {
      if (closed) return
      closed = true
      stopTimers()
      watcher?.close()
      watcher = null
    }
  }
}
