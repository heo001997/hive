import { stripAnsi } from '../../../shared/lib/ansi'

/**
 * Per-terminal output liveness, as observed by THIS (server) process.
 *
 * Why it lives here and not in `main/services/terminal-pty-bridge`: in the desktop
 * app the Claude CLI PTYs are owned by the Electron **main** process, while the RPC
 * domains (`completionOps.getSessionFingerprint`) run in the **server** child
 * process. Importing main's accumulator from here yields a second, permanently empty
 * module instance — so every fingerprint fell back to the coarse DB path
 * (`source: 'db'`; 5 days of production logs contained 108 `db` reads and not one
 * `pty`). For a Claude CLI session the DB holds no messages at all, so that fallback
 * compared two identical empty samples and reported `frozen` about 1.2s after ANY
 * `completed` event — the 30s sustained-silence window that is supposed to keep a
 * live agent In Progress never applied, and a freshly launched ticket went straight
 * to Review.
 *
 * Main already streams every PTY chunk to this process (`terminal:data:<id>`, the
 * feed the renderer renders from) and announces exits (`terminal:exit:<id>`), so the
 * server can mirror liveness with no extra IPC: `server.ts` records data/exit,
 * `terminal-ops` marks a terminal alive the moment it is created (see
 * {@link markTerminalAlive}) and disposes it on destroy. Server-owned PTYs (headless
 * mode) feed the same map from their own data listener.
 */
export interface TerminalLiveness {
  /** Running total of emitted bytes (never reset while the terminal lives). */
  bytes: number
  /** Capped, ANSI-stripped rolling window of the most recent output. */
  tail: string
  /** Wall-clock ms of the most recent emit — or of creation, before the first byte. */
  lastOutputAt: number
}

/** Cap on the rolling tail kept per terminal (raw, ANSI stripped at read time). */
const LIVENESS_TAIL_CAP = 16 * 1024

const liveness = new Map<string, { bytes: number; raw: string; lastOutputAt: number }>()

/**
 * Record a terminal as alive with no output yet. Called at create time so the window
 * between spawn and the first byte reads as *alive* rather than as "no data anywhere"
 * (a Claude CLI PTY takes ~300ms to paint its first frame; treating that silence as a
 * frozen session is what let a booting terminal promote its ticket to Review).
 * Never clobbers an existing entry — a duplicate create for a live terminal must not
 * rewind its byte count or its last-emit timestamp.
 */
export function markTerminalAlive(terminalId: string): void {
  if (liveness.has(terminalId)) return
  liveness.set(terminalId, { bytes: 0, raw: '', lastOutputAt: Date.now() })
}

/**
 * Append emitted output. The tail is stored RAW and stripped once at read time: PTY
 * chunks split on arbitrary byte boundaries, so an escape sequence can straddle two
 * chunks and per-chunk stripping would leave the split fragment behind.
 */
export function recordTerminalLiveness(terminalId: string, data: string): void {
  if (!data) return
  const prev = liveness.get(terminalId)
  const combined = (prev?.raw ?? '') + data
  liveness.set(terminalId, {
    bytes: (prev?.bytes ?? 0) + data.length,
    raw: combined.length > LIVENESS_TAIL_CAP ? combined.slice(-LIVENESS_TAIL_CAP) : combined,
    lastOutputAt: Date.now()
  })
}

/** Forget a terminal (exit / destroy). A missing entry means "no live PTY here". */
export function disposeTerminalLiveness(terminalId: string): void {
  liveness.delete(terminalId)
}

/**
 * Snapshot of a terminal's output so far, or `undefined` when this process knows of no
 * live PTY for the id (non-PTY provider, exited session) — the caller then falls back
 * to a coarser source. For Claude CLI sessions `sessionId === terminalId`.
 */
export function getTerminalLiveness(terminalId: string): TerminalLiveness | undefined {
  const live = liveness.get(terminalId)
  if (!live) return undefined
  return { bytes: live.bytes, tail: stripAnsi(live.raw), lastOutputAt: live.lastOutputAt }
}

/** Test hook: drop all mirrored liveness. */
export function resetTerminalLiveness(): void {
  liveness.clear()
}
